// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.ConfigFetcher
import io.confeature.android.internal.JsonParser
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration
import okhttp3.Call
import okhttp3.Request
import org.assertj.core.api.Assertions.assertThat

/**
 * What a `wire-cases.json` case means for sdk-android — ONE implementation, shared by the
 * hermetic suite ([WireCasesTest], a MockWebServer) AND the live suite ([WireCasesLiveTest], real
 * HTTP against the live-contract harness, #922), so both are judged by the same rules. The request
 * is passed in transport-neutral form ([SentRequest]): the hermetic suite reads it from the
 * recorded request line, the live suite from the harness's `GET /admin/requests`.
 *
 * Mirrors sdk-java's `WireCaseAssertions` and sdk-go's `wire_case_assertions_test.go` (#921).
 */
internal object WireCaseAssertions {
    /**
     * Default key for cases that do not pin `given.sdkKey` in the hermetic suite: a well-shaped
     * legacy key, so its #803 FR-001 path is the key verbatim.
     */
    const val DEFAULT_SDK_KEY =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /** Every `given` field this consumer reads; any other FAILS the case (#803 FR-003). */
    private val KNOWN_GIVEN: Set<String> = setOf("previousEtag", "sdkKey", "baseUrl")

    /** Every `expected` field this consumer reads; any other FAILS the case. */
    private val KNOWN_EXPECTED: Set<String> = setOf(
        "requestHeaderIfNoneMatch",
        "outcome",
        "resultingEtag",
        "hasConfig",
        "errorClass",
        "requestUrlPrefix",
        "requestPath",
    )

    /** The one request a fetch sent, as it arrived: its path (query excluded) and If-None-Match. */
    data class SentRequest(val path: String, val ifNoneMatch: String?)

    /** The corpus's cases by id, in corpus order; an empty corpus fails rather than passing. */
    @Suppress("UNCHECKED_CAST")
    fun casesById(): Map<String, Map<String, Any?>> {
        val raw = String(Files.readAllBytes(WorkspaceRoot.wireCasesPath()), StandardCharsets.UTF_8)
        val cases = (JsonParser.parseObject(raw)["cases"] as? List<Map<String, Any?>>)
            ?.takeIf { it.isNotEmpty() }
            ?: error("wire-cases.json carries no cases.")
        return cases.associateBy { it["id"] as String }
    }

    /** The key a case's fetcher is configured with: its pinned `given.sdkKey`, else [defaultKey]. */
    @Suppress("UNCHECKED_CAST")
    fun sdkKeyFor(wireCase: Map<String, Any?>, defaultKey: String): String =
        (wireCase["given"] as Map<String, Any?>)["sdkKey"] as String? ?: defaultKey

    /**
     * The exact path the request must carry: the case's `requestPath` when it pins one, else
     * ConfigCat's `/configuration-files/<sdkKey>/config_v6.json`, which FR-001 sends verbatim for a
     * key that needs no escaping (the default key, a harness case id).
     */
    @Suppress("UNCHECKED_CAST")
    fun requestPathFor(wireCase: Map<String, Any?>, sdkKey: String): String =
        (wireCase["expected"] as Map<String, Any?>)["requestPath"] as String?
            ?: "/configuration-files/$sdkKey/config_v6.json"

    /**
     * Judges one fetch against its case: the fields read, the request sent and the outcome. [sent]
     * is the one request the fetch made; the caller has already checked there was exactly one.
     */
    @Suppress("UNCHECKED_CAST")
    fun assertWireCase(
        id: String,
        wireCase: Map<String, Any?>,
        sdkKey: String,
        sent: SentRequest,
        result: ConfigFetcher.FetchResult,
    ) {
        val given = wireCase["given"] as Map<String, Any?>
        val expected = wireCase["expected"] as Map<String, Any?>
        assertThat(given.keys - KNOWN_GIVEN)
            .`as`("case %s carries a given field this consumer does not read", id)
            .isEmpty()
        assertThat(expected.keys - KNOWN_EXPECTED)
            .`as`("case %s carries an expected field this consumer does not read", id)
            .isEmpty()

        // The path AS IT ARRIVED, byte for byte (#803): never a re-parsed URL, so neither OkHttp
        // re-encoding nor a decoding peer can hide a difference.
        assertThat(sent.path)
            .`as`("request path on the wire (case %s)", id)
            .isEqualTo(requestPathFor(wireCase, sdkKey))
        assertRequestUrlPrefix(id, given, expected, sdkKey)
        assertIfNoneMatch(id, sent.ifNoneMatch, expected)
        if (expected.containsKey("hasConfig")) {
            assertThat(result.body != null)
                .`as`("hasConfig (case %s)", id)
                .isEqualTo(expected["hasConfig"])
        }
        assertOutcome(id, expected, result)
    }

    /**
     * Maps the fetcher's fixed reason codes onto the corpus's error-class vocabulary. FAILS CLOSED:
     * a code not listed here maps to `unmapped:<code>`, which no case expects — so a new or renamed
     * reason fails the suite instead of passing as `fetchFailed`.
     *
     * - `MALFORMED_JSON` / `EMPTY_BODY` → `parseFailed`
     * - `HTTP 403` / `HTTP 404` / `INVALID_SDK_KEY` → `invalidSdkKey` (per ConfigCat only 403/404
     *   are invalid-SDK-key statuses; 401 is retryable)
     * - `timeout` → `timeout`
     * - any other `HTTP <status>`, `network_error`, `body_read_failed`, `too_many_redirects`,
     *   `invalid_request` → `fetchFailed`
     *
     * Mirrors sdk-java's `javaErrorToClass` and sdk-go's `goErrorToClass`.
     */
    fun androidErrorToClass(reason: String?): String = when (reason) {
        "MALFORMED_JSON", "EMPTY_BODY" -> "parseFailed"
        "HTTP 403", "HTTP 404", "INVALID_SDK_KEY" -> "invalidSdkKey"
        "timeout" -> "timeout"
        "network_error", "body_read_failed", "too_many_redirects", "invalid_request" -> "fetchFailed"
        null -> "unmapped:null"
        else -> if (reason.startsWith("HTTP ")) "fetchFailed" else "unmapped:$reason"
    }

    private fun assertOutcome(
        id: String,
        expected: Map<String, Any?>,
        result: ConfigFetcher.FetchResult,
    ) {
        when (val outcome = expected["outcome"] as String) {
            "fetched" -> {
                assertThat(result.status)
                    .`as`("outcome=fetched (case %s, error=%s)", id, result.error)
                    .isEqualTo(ConfigFetcher.Status.FETCHED)
                assertResultingEtag(id, expected, result)
                assertThat(result.body).`as`("fetched outcome must populate body").isNotNull
                assertThat(result.rawBody).`as`("fetched outcome must populate raw body").isNotNull
            }
            "notModified" -> {
                assertThat(result.status)
                    .`as`("outcome=notModified (case %s, error=%s)", id, result.error)
                    .isEqualTo(ConfigFetcher.Status.NOT_MODIFIED)
                assertResultingEtag(id, expected, result)
                assertThat(result.body).`as`("notModified outcome must NOT carry a body").isNull()
            }
            "failed" -> {
                assertThat(result.status)
                    .`as`("outcome=failed (case %s, error=%s)", id, result.error)
                    .isEqualTo(ConfigFetcher.Status.FAILED)
                val expectedClass = expected["errorClass"] as String
                assertThat(androidErrorToClass(result.error))
                    .`as`(
                        "errorClass mapping for case %s (raw error=%s) MUST be %s",
                        id,
                        result.error,
                        expectedClass,
                    )
                    .isEqualTo(expectedClass)
                assertThat(result.body).`as`("failed outcome must NOT carry a body").isNull()
            }
            else -> throw IllegalStateException("unknown outcome: $outcome")
        }
    }

    private fun assertResultingEtag(
        id: String,
        expected: Map<String, Any?>,
        result: ConfigFetcher.FetchResult,
    ) {
        val resultingEtag = expected["resultingEtag"] ?: return
        assertThat(result.etag).`as`("resultingEtag (case %s)", id).isEqualTo(resultingEtag)
    }

    /**
     * A custom base must lead the request URL (custom-base-url): `given.baseUrl` and
     * `expected.requestUrlPrefix` come together, and a fetcher configured with that base hands its
     * transport a request whose URL starts with the prefix. The base is not a reachable host, so a
     * recording [Call.Factory] (the fetcher's construction-time seam) captures the request and
     * fails it — the URL the fetcher actually requests, never a getter (#803: no public surface
     * hands out the keyed URL).
     */
    private fun assertRequestUrlPrefix(
        id: String,
        given: Map<String, Any?>,
        expected: Map<String, Any?>,
        sdkKey: String,
    ) {
        val base = given["baseUrl"] as String?
        val prefix = expected["requestUrlPrefix"] as String?
        assertThat(base == null)
            .`as`("case %s: given.baseUrl and expected.requestUrlPrefix come together", id)
            .isEqualTo(prefix == null)
        if (base == null) return
        val requested = ArrayList<String>()
        val recording = object : Call.Factory {
            override fun newCall(request: Request): Call {
                requested.add(request.url.toString())
                throw IOException("recorded, not sent")
            }
        }
        ConfigFetcher(base, sdkKey, Duration.ofSeconds(5), TestLogger(), recording).use { custom ->
            assertThat(custom.fetch("").status).isEqualTo(ConfigFetcher.Status.FAILED)
        }
        assertThat(requested).`as`("one request (case %s)", id).hasSize(1)
        assertThat(requested[0]).`as`("request URL prefix (case %s)", id).startsWith(prefix)
    }

    /**
     * The corpus's three-state If-None-Match: absent (not asserted), explicit `null` (MUST NOT be
     * sent), a string (MUST equal). The JsonParser decode collapses absent and explicit-null, so the
     * key's presence is checked separately.
     */
    private fun assertIfNoneMatch(id: String, actual: String?, expected: Map<String, Any?>) {
        if (!expected.containsKey("requestHeaderIfNoneMatch")) return
        val value = expected["requestHeaderIfNoneMatch"]
        if (value == null) {
            assertThat(actual).`as`("If-None-Match MUST NOT be sent (case %s)", id).isNull()
        } else {
            assertThat(actual).`as`("If-None-Match round-trip (case %s)", id).isEqualTo(value)
        }
    }
}
