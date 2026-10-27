// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import java.nio.charset.StandardCharsets
import java.nio.file.Files

/**
 * What a `wire-cases.json` case means for sdk-kotlin-mp — ONE implementation, shared by the
 * hermetic suite ([WireCasesTest], Ktor's MockEngine plus a raw TCP listener) AND the live suite
 * ([WireCasesLiveTest], the production CIO client against the live-contract harness, #922), so
 * both are judged by the same rules. The request is passed in transport-neutral form
 * ([SentRequest]): the hermetic suite reads it from the mock and the raw request line, the live
 * suite from the harness's `GET /admin/requests`.
 *
 * Mirrors sdk-java's `WireCaseAssertions` and sdk-go's `wire_case_assertions_test.go` (#921).
 */
internal object WireCaseAssertions {
    /** Default key for cases that do not pin `given.sdkKey` in the hermetic suite. */
    const val DEFAULT_SDK_KEY =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /** Every `given` / `expected` field this suite reads; any other one fails the case (#803). */
    private val KNOWN_GIVEN_FIELDS = setOf("previousEtag", "sdkKey", "baseUrl")
    private val KNOWN_EXPECTED_FIELDS = setOf(
        "outcome",
        "errorClass",
        "resultingEtag",
        "requestHeaderIfNoneMatch",
        "hasConfig",
        "requestUrlPrefix",
        "requestPath",
    )

    /**
     * The one request a fetch sent: its path as it arrived on the wire (query excluded), the full
     * URL it was sent to, and its If-None-Match.
     */
    data class SentRequest(val path: String, val url: String, val ifNoneMatch: String?)

    /** The corpus's cases by id, in corpus order; an empty corpus fails rather than passing. */
    fun casesById(): Map<String, JsonObject> {
        val raw = String(Files.readAllBytes(WorkspaceRoot.wireCasesPath()), StandardCharsets.UTF_8)
        val cases = ((Json.parseToJsonElement(raw) as JsonObject)["cases"] as? JsonArray)
            ?.takeIf { it.isNotEmpty() }
            ?: error("wire-cases.json carries no cases.")
        val pending = pendingCases().toMutableMap()
        val runnable = cases.map { it.jsonObject }.filter { wireCase ->
            val id = wireCase.getValue("id").jsonPrimitive.content
            val ticket = pending.remove(id) ?: return@filter true
            // Left out BY NAME (wire-cases-pending.json, 1.4, #994), under a proof that the entry
            // is still true: this reader still cannot read the case. The day it can, it must go.
            val unread = (wireCase.getValue("given").jsonObject.keys - KNOWN_GIVEN_FIELDS) +
                (wireCase.getValue("expected").jsonObject.keys - KNOWN_EXPECTED_FIELDS)
            check(unread.isNotEmpty()) {
                "$id is pending for sdk-kotlin-mp ($ticket) but this reader reads every field of it " +
                    "— remove it from wire-cases-pending.json and run it"
            }
            System.err.println("pending ($ticket): $id — this reader cannot read $unread")
            false
        }
        check(pending.isEmpty()) {
            "wire-cases-pending.json lists ${pending.keys} for sdk-kotlin-mp, not in the corpus"
        }
        return runnable.associateBy { it.getValue("id").jsonPrimitive.content }
    }

    /** sdk-kotlin-mp's entry of `wire-cases-pending.json`: case id to ticket. */
    fun pendingCases(): Map<String, String> {
        val path = WorkspaceRoot.wireCasesPath().resolveSibling("wire-cases-pending.json")
        val raw = String(Files.readAllBytes(path), StandardCharsets.UTF_8)
        val entry = (Json.parseToJsonElement(raw) as JsonObject).getValue("pending").jsonObject["sdk-kotlin-mp"]
            ?.jsonObject ?: return emptyMap()
        val ticket = entry.getValue("ticket").jsonPrimitive.content
        return (entry.getValue("cases") as JsonArray).associate { it.jsonPrimitive.content to ticket }
    }

    /** A string field of a case block; a JSON `null` or an absent field is null. */
    fun field(block: JsonObject?, name: String): String? =
        (block?.get(name) as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content

    /**
     * The exact path the request must carry: the case's `requestPath` when it pins one, else
     * ConfigCat's `/configuration-files/<sdkKey>/config_v6.json`, which FR-001 sends verbatim for a
     * key that needs no escaping (the default key, a harness case id).
     */
    fun requestPathFor(wireCase: JsonObject, sdkKey: String): String =
        field(wireCase["expected"] as? JsonObject, "requestPath")
            ?: "/configuration-files/$sdkKey/config_v6.json"

    /**
     * Judges one fetch against its case: the fields read, the request sent and the outcome. [sent]
     * is the one request the fetch made; the caller has already checked there was exactly one.
     */
    fun assertWireCase(
        id: String,
        wireCase: JsonObject,
        sdkKey: String,
        sent: SentRequest,
        result: ConfigFetcher.FetchResult,
    ) {
        val given = wireCase["given"] as JsonObject
        val expected = wireCase["expected"] as JsonObject
        for ((block, known) in listOf(given to KNOWN_GIVEN_FIELDS, expected to KNOWN_EXPECTED_FIELDS)) {
            val unknown = block.keys - known
            assertTrue(
                unknown.isEmpty(),
                "case=$id: field(s) $unknown unknown to the kotlin-mp wire suite — read them",
            )
        }
        // The path AS IT ARRIVED, byte for byte (#803) — never a re-parsed URL.
        assertEquals(requestPathFor(wireCase, sdkKey), sent.path, "case=$id request path on the wire")
        field(expected, "requestUrlPrefix")?.let { prefix ->
            assertTrue(sent.url.startsWith(prefix), "case=$id request URL ${sent.url} must start with $prefix")
        }
        assertIfNoneMatch(id, sent.ifNoneMatch, expected)
        (expected["hasConfig"] as? JsonPrimitive)?.content?.toBooleanStrict()?.let { hasConfig ->
            assertEquals(hasConfig, result.body != null, "case=$id hasConfig")
        }
        assertOutcome(id, expected, result)
    }

    /**
     * Maps the KMP fetcher's fixed reason codes onto the corpus's error-class vocabulary. FAILS
     * CLOSED: a code not listed here maps to `unmapped:<code>`, which no case expects — so a new or
     * renamed reason fails the suite instead of passing as `fetchFailed`.
     *
     * - [ConfigFetcher.MALFORMED_JSON] → `parseFailed`
     * - `HTTP 403` / `HTTP 404` / [ConfigFetcher.INVALID_SDK_KEY] → `invalidSdkKey` (per ConfigCat
     *   only 403/404 are invalid-SDK-key statuses; 401 is retryable)
     * - [ConfigFetcher.TIMEOUT] → `timeout`
     * - any other `HTTP <status>`, `network_error`, `body_read_failed`, `too_many_redirects`,
     *   `invalid_request` → `fetchFailed`
     *
     * Mirrors sdk-java's `javaErrorToClass` and sdk-go's `goErrorToClass`.
     */
    fun kotlinMpErrorToClass(reason: String): String = when (reason) {
        ConfigFetcher.MALFORMED_JSON -> "parseFailed"
        "HTTP 403", "HTTP 404", ConfigFetcher.INVALID_SDK_KEY -> "invalidSdkKey"
        ConfigFetcher.TIMEOUT -> "timeout"
        ConfigFetcher.NETWORK_ERROR,
        ConfigFetcher.BODY_READ_FAILED,
        ConfigFetcher.TOO_MANY_REDIRECTS,
        ConfigFetcher.INVALID_REQUEST,
        -> "fetchFailed"
        else -> if (reason.startsWith("HTTP ")) "fetchFailed" else "unmapped:$reason"
    }

    private fun assertOutcome(id: String, expected: JsonObject, result: ConfigFetcher.FetchResult) {
        val outcome = field(expected, "outcome")
        val want = when (outcome) {
            "fetched" -> ConfigFetcher.Status.FETCHED
            "notModified" -> ConfigFetcher.Status.NOT_MODIFIED
            "failed" -> ConfigFetcher.Status.FAILED
            else -> error("unknown outcome: $outcome")
        }
        assertEquals(want, result.status, "outcome=$outcome (case=$id, error=${result.error})")
        field(expected, "resultingEtag")?.let { assertEquals(it, result.etag, "case=$id resultingEtag") }
        if (want == ConfigFetcher.Status.FETCHED) {
            assertNotNull(result.body, "fetched outcome must populate body")
            assertNotNull(result.rawBody, "fetched outcome must populate raw body")
            return
        }
        assertNull(result.body, "$outcome outcome must NOT carry a body")
        if (want == ConfigFetcher.Status.FAILED) {
            val expectedClass = field(expected, "errorClass")
            assertEquals(
                expectedClass,
                kotlinMpErrorToClass(result.error),
                "errorClass mapping for case=$id (raw error=${result.error}) MUST be $expectedClass",
            )
        }
    }

    /**
     * The corpus's three-state If-None-Match: absent (not asserted), explicit `null` (MUST NOT be
     * sent), a string (MUST equal). kotlinx-serialization keeps absent (no key) and explicit-null
     * ([JsonNull]) apart.
     */
    private fun assertIfNoneMatch(id: String, actual: String?, expected: JsonObject) {
        if (!expected.containsKey("requestHeaderIfNoneMatch")) return
        when (val value = expected["requestHeaderIfNoneMatch"]) {
            JsonNull -> assertNull(actual, "case=$id If-None-Match MUST NOT be sent")
            is JsonPrimitive -> assertEquals(value.content, actual, "case=$id If-None-Match round-trip")
            else -> error("unexpected requestHeaderIfNoneMatch shape: $value")
        }
    }
}
