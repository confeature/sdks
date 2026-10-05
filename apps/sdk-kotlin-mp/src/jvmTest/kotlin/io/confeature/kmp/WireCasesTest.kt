// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.headersOf
import io.ktor.http.headers
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.cancel
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.stream.Stream

/**
 * Wire-protocol fixture suite — sdk-kotlin-mp (JVM target) consumer.
 *
 * Drives the JVM target's Ktor-based [ConfigFetcher] against each case in
 * `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The corpus is the
 * language-agnostic contract; this file is the KMP consumer that maps the fetcher's typed
 * [ConfigFetcher.Status] plus stringly-typed [ConfigFetcher.FetchResult.error] onto the corpus's
 * normalised `{fetched, notModified, failed}` x `{fetchFailed, timeout, parseFailed,
 * invalidSdkKey}` vocabulary — the same vocabulary the other SDK families already conform to
 * (sdk-node / sdk-browser-js / sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-rust / sdk-java /
 * sdk-android / sdk-dotnet / sdk-ruby / sdk-php / sdk-elixir).
 *
 * Layer choice: this drives the fetcher directly (NOT the public [ConfeatureClient]), matching
 * what every other SDK slice already does — the wire-cases corpus by name tests wire behaviour,
 * and the fetcher is the JVM target's wire layer. Driving the public client would add
 * poll-service indirection that the corpus does not assert.
 *
 * Mock pattern: this test uses Ktor's [MockEngine] (already on the jvmTest classpath via
 * `ktor-client-mock`) rather than OkHttp's MockWebServer. The KMP fetcher is Ktor-based across
 * every target (JVM/JS/iOS) — driving it through Ktor's own mock engine is the SDK's existing
 * JUnit 5 idiom (see [ConfigFetcherTest]). No new Gradle deps required.
 *
 * Behaviour adapter (#490): the corpus's `server.behavior` discriminator selects how the mock
 * transport acts, mirroring the sdk-go reference (commit a804507):
 *
 * - `respond` (default / absent) — deliver `status` + `headers` + `body` verbatim.
 * - `timeout` — the handler [delay]s past a SHORT per-case request timeout so Ktor's
 *   [HttpTimeout] plugin raises `HttpRequestTimeoutException` → the fetcher's catch → `timeout`.
 * - `close-mid-response` — a 200 whose body channel emits a partial payload then is cancelled
 *   with an [IOException], so the fetcher's `bodyAsText()` read (which precedes the JSON parse)
 *   throws → the outer catch → `fetchFailed` (a transport failure, NOT `parseFailed`: a truncated
 *   body is not a JSON-shape error).
 * - any other value — fail loudly via [error]; never fall through to `respond`.
 *
 * Target scope: JVM only. The KMP iOS / JS test targets sit out of scope for spec 112 per
 * research §R-003 — the wire layer is exercised on the JVM authoritative slot, and the iOS / JS
 * platform-engine implementations rely on the same Ktor abstraction so their contract surface is
 * indirectly covered.
 *
 * Request paths are asserted ON THE WIRE (#803): each case's request is also sent through the
 * production CIO client to a raw TCP listener ([RawHttpListener]) and the request line's path is
 * compared byte for byte — Ktor's [MockEngine] only ever sees the parsed URL.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): every corpus case MUST pass (17 as of
 * #803, incl. the `timeout` + `network-reset` behaviour cases and the three `requestPath`
 * cases). If a case drifts, STOP and investigate the fetcher — never mutate the corpus to make
 * the test green.
 *
 * See spec 112 / epic #146 / issue #148 (slice 14).
 */
class WireCasesTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("wireCases")
    fun wireCase(id: String, wireCase: JsonObject) = runBlocking {
        val given = wireCase["given"] as JsonObject
        val server = wireCase["server"] as JsonObject
        val expected = wireCase["expected"] as JsonObject

        val behavior = (server["behavior"] as? JsonPrimitive)?.contentOrEmpty() ?: BEHAVIOR_RESPOND

        // FR-003 (#803): an unread field is a skipped expectation — fail on any we do not know.
        assertOnlyKnownFields(id, "given", given, KNOWN_GIVEN_FIELDS)
        assertOnlyKnownFields(id, "expected", expected, KNOWN_EXPECTED_FIELDS)

        val capturedIfNoneMatch = CopyOnWriteArrayList<String?>()
        val capturedUrls = CopyOnWriteArrayList<Url>()
        val capturedRequestCount = java.util.concurrent.atomic.AtomicInteger(0)
        val fetcher = newFetcher(
            given,
            server,
            behavior,
            capturedRequestCount,
            capturedIfNoneMatch,
            capturedUrls,
        )

        try {
            val previousEtag = readPreviousEtag(given)
            val result = fetcher.fetch(previousEtag)

            assertEquals(1, capturedRequestCount.get(), "fetcher MUST issue exactly one HTTP request")
            assertRequestUrl(id, capturedUrls.single(), wireRequestTarget(given), expected)
            assertIfNoneMatch(capturedIfNoneMatch.firstOrNull(), expected)
            assertOutcome(id, expected, result)
            assertHasConfig(id, expected, result)
        } finally {
            fetcher.close()
        }
    }

    @Suppress("LongParameterList")
    private fun newFetcher(
        given: JsonObject,
        server: JsonObject,
        behavior: String,
        requestCount: java.util.concurrent.atomic.AtomicInteger,
        ifNoneMatch: CopyOnWriteArrayList<String?>,
        urls: CopyOnWriteArrayList<Url>,
    ): ConfigFetcher = ConfigFetcher(
        baseUrl = givenString(given, "baseUrl") ?: DEFAULT_BASE_URL,
        sdkKey = givenString(given, "sdkKey") ?: SDK_KEY,
        timeoutMillis = 5_000L,
        logger = CapturingLogger(),
        httpClientFactory = {
            HttpClient(
                MockEngine { request ->
                    requestCount.incrementAndGet()
                    ifNoneMatch.add(request.headers[HttpHeaders.IfNoneMatch])
                    urls.add(request.url)
                    respondFromCase(server, behavior)
                },
            ) {
                // The behaviour=timeout case needs Ktor's timeout plugin to abort the
                // in-flight request once the mock handler delays past a SHORT per-case
                // deadline (every other behaviour keeps the engine's default budget).
                // Mirrors the sdk-go reference dropping the client Timeout to 100ms.
                install(HttpTimeout) {
                    requestTimeoutMillis = if (behavior == BEHAVIOR_TIMEOUT) {
                        TIMEOUT_BEHAVIOR_REQUEST_MS
                    } else {
                        DEFAULT_REQUEST_TIMEOUT_MS
                    }
                }
            }
        },
    )

    private fun assertOnlyKnownFields(id: String, block: String, obj: JsonObject, known: Set<String>) {
        val unknown = obj.keys - known
        assertTrue(
            unknown.isEmpty(),
            "case=$id: $block field(s) $unknown unknown to the kotlin-mp wire suite — read them",
        )
    }

    private fun givenString(given: JsonObject, field: String): String? =
        (given[field] as? JsonPrimitive)?.contentOrEmpty()

    /**
     * Sends the case's request once more through the PRODUCTION Ktor client (the fetcher's default
     * factory — CIO on the JVM) to a raw TCP listener, and returns the request-target exactly as
     * the bytes arrived (#803 brief item 4: Ktor may re-encode a path between the string the SDK
     * builds and the socket; the [MockEngine] only sees Ktor's parsed view). The case's base path,
     * if any, is kept; only scheme + authority move to the listener.
     */
    private fun wireRequestTarget(given: JsonObject): String = runBlocking {
        RawHttpListener().use { listener ->
            val basePath = givenString(given, "baseUrl")?.let { Url(it).encodedPath.trimEnd('/') }.orEmpty()
            val fetcher = ConfigFetcher(
                baseUrl = listener.baseUrl + basePath,
                sdkKey = givenString(given, "sdkKey") ?: SDK_KEY,
                timeoutMillis = DEFAULT_REQUEST_TIMEOUT_MS,
                logger = CapturingLogger(),
            )
            try {
                fetcher.fetch("")
                listener.requestTargets.single()
            } finally {
                fetcher.close()
            }
        }
    }

    /**
     * `requestUrlPrefix` is compared against the full request URL (scheme + host come from the
     * mock run); `requestPath` against the path of the request line AS RECEIVED ON THE WIRE, byte
     * for byte (query excluded — #807 may add one). The mock's parsed path must equal those wire
     * bytes too, so the mock never sees a different path than the socket. Every request is
     * ConfigCat's `/configuration-files/<key>/config_v6.json` — never a `/v2/` path.
     */
    private fun assertRequestUrl(id: String, url: Url, wireTarget: String, expected: JsonObject) {
        val wirePath = wireTarget.substringBefore('?')
        assertTrue(wirePath.startsWith("/configuration-files/"), "case=$id wire path=$wirePath")
        assertTrue(wirePath.endsWith("/config_v6.json"), "case=$id wire path=$wirePath")
        assertEquals(wirePath, url.encodedPath, "case=$id mock path vs wire path")
        (expected["requestUrlPrefix"] as? JsonPrimitive)?.let { prefix ->
            assertTrue(
                url.toString().startsWith(prefix.content),
                "case=$id request URL must start with ${prefix.content}",
            )
        }
        (expected["requestPath"] as? JsonPrimitive)?.let { path ->
            assertEquals(path.content, wirePath, "case=$id requestPath (raw request line)")
        }
    }

    private fun assertHasConfig(id: String, expected: JsonObject, result: ConfigFetcher.FetchResult) {
        val hasConfig = (expected["hasConfig"] as? JsonPrimitive)?.content?.toBooleanStrict() ?: return
        assertEquals(hasConfig, result.body != null, "case=$id hasConfig")
    }

    private fun readPreviousEtag(given: JsonObject): String = when (val raw = given["previousEtag"]) {
        null, JsonNull -> ""
        is JsonPrimitive -> raw.content
        else -> error("unexpected previousEtag shape: $raw")
    }

    private fun assertOutcome(
        id: String,
        expected: JsonObject,
        result: ConfigFetcher.FetchResult,
    ) {
        when (val outcome = (expected["outcome"] as JsonPrimitive).content) {
            "fetched" -> assertFetched(id, expected, result)
            "notModified" -> assertNotModified(id, expected, result)
            "failed" -> assertFailed(id, expected, result)
            else -> error("unknown outcome: $outcome")
        }
    }

    private fun assertFetched(id: String, expected: JsonObject, result: ConfigFetcher.FetchResult) {
        assertEquals(
            ConfigFetcher.Status.FETCHED,
            result.status,
            "outcome=fetched (case=$id, error=${result.error})",
        )
        assertResultingEtag(expected, result.etag)
        assertNotNull(result.body, "fetched outcome must populate body")
        assertNotNull(result.rawBody, "fetched outcome must populate raw body")
    }

    private fun assertNotModified(
        id: String,
        expected: JsonObject,
        result: ConfigFetcher.FetchResult,
    ) {
        assertEquals(
            ConfigFetcher.Status.NOT_MODIFIED,
            result.status,
            "outcome=notModified (case=$id, error=${result.error})",
        )
        assertResultingEtag(expected, result.etag)
        assertNull(result.body, "notModified outcome must NOT carry a body")
    }

    private fun assertFailed(id: String, expected: JsonObject, result: ConfigFetcher.FetchResult) {
        assertEquals(
            ConfigFetcher.Status.FAILED,
            result.status,
            "outcome=failed (case=$id, error=${result.error})",
        )
        val expectedClass = (expected["errorClass"] as JsonPrimitive).content
        val actualClass = kotlinMpErrorToClass(result.error)
        assertEquals(
            expectedClass,
            actualClass,
            "errorClass mapping for case=$id (raw error=${result.error}) MUST be $expectedClass",
        )
        assertNull(result.body, "failed outcome must NOT carry a body")
    }

    private fun assertResultingEtag(expected: JsonObject, actualEtag: String) {
        val resultingEtag = expected["resultingEtag"]
        if (resultingEtag != null && resultingEtag !is JsonNull) {
            assertEquals((resultingEtag as JsonPrimitive).content, actualEtag)
        }
    }

    /**
     * Asserts the request's `If-None-Match` header against the corpus's three-state semantics:
     * absent (don't assert), explicit `null` (header MUST NOT be sent), explicit string (header
     * MUST equal). kotlinx-serialization decodes absent vs explicit-null differently — absent
     * yields `containsKey == false`, explicit-null yields a [JsonNull] value.
     */
    private fun assertIfNoneMatch(actual: String?, expected: JsonObject) {
        if (!expected.containsKey("requestHeaderIfNoneMatch")) return
        when (val value = expected["requestHeaderIfNoneMatch"]) {
            null, JsonNull -> assertNull(actual, "If-None-Match MUST NOT be sent")
            is JsonPrimitive -> assertEquals(value.content, actual, "If-None-Match round-trip")
            else -> error("unexpected requestHeaderIfNoneMatch shape: $value")
        }
    }

    /**
     * Builds the Ktor mock [respond] reply for one case, branching on the corpus's
     * `server.behavior` discriminator (#490, mirroring sdk-go a804507). `bodyRef` resolves to a
     * sibling fixture under `packages/test-fixtures-sdk-parity/fixtures/`; `body` is used verbatim
     * (for malformed-payload cases). Either may be absent — 304 has no body.
     */
    private suspend fun io.ktor.client.engine.mock.MockRequestHandleScope.respondFromCase(
        server: JsonObject,
        behavior: String,
    ): io.ktor.client.request.HttpResponseData {
        val status = HttpStatusCode.fromValue((server["status"] as JsonPrimitive).content.toInt())
        val headersBlock = (server["headers"] as? JsonObject) ?: JsonObject(emptyMap())
        val headers = headers {
            for ((name, value) in headersBlock) {
                append(name, (value as JsonPrimitive).content)
            }
        }
        val bodyRef = (server["bodyRef"] as? JsonPrimitive)?.contentOrEmpty()
        val bodyText: String? = when {
            bodyRef != null -> {
                val raw = Files.readAllBytes(WorkspaceRoot.fixturesDir().resolve(bodyRef))
                String(raw, StandardCharsets.UTF_8)
            }
            else -> (server["body"] as? JsonPrimitive)?.contentOrEmpty()
        }
        val payload = bodyText ?: ""
        return when (behavior) {
            BEHAVIOR_RESPOND ->
                respond(content = ByteReadChannel(payload), status = status, headers = headers)
            BEHAVIOR_TIMEOUT -> {
                // Hang past the SHORT per-case request timeout: Ktor's HttpTimeout plugin aborts
                // the in-flight request with HttpRequestTimeoutException → the fetcher's catch →
                // `timeout`. The delay outlives the deadline, so this respond is never reached.
                delay(TIMEOUT_BEHAVIOR_HANG_MS)
                respond(content = ByteReadChannel(payload), status = status, headers = headers)
            }
            BEHAVIOR_CLOSE_MID_RESPONSE ->
                respond(content = partialThenReset(payload), status = status, headers = headers)
            else ->
                // Unrecognised behaviour — FAIL loudly, never fall through to respond.
                error("wire-cases: unsupported server.behavior \"$behavior\" — no adapter")
        }
    }

    /**
     * Emits a truncated prefix of [payload] then cancels the channel with an [IOException], so the
     * fetcher's `bodyAsText()` read fails mid-stream — the close-mid-response transport failure the
     * `network-reset` corpus case pins. The fetcher reads the body BEFORE parsing, so this surfaces
     * as `fetchFailed`, NOT `parseFailed`.
     */
    private suspend fun partialThenReset(payload: String): ByteReadChannel {
        val channel = ByteChannel(autoFlush = true)
        val prefix = payload.take(PARTIAL_PREFIX_CHARS).ifEmpty { "{" }
        channel.writeStringUtf8(prefix)
        channel.flush()
        channel.cancel(IOException("wire-cases: connection reset mid-response"))
        return channel
    }

    private companion object {
        /** Stable, well-formed key — used when a case does not pin `given.sdkKey`. */
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

        /** Base URL when a case does not pin `given.baseUrl`. */
        const val DEFAULT_BASE_URL = "https://mock.confeature.test"

        /** Every `given` / `expected` field this suite reads; any other one fails the case. */
        val KNOWN_GIVEN_FIELDS = setOf("previousEtag", "sdkKey", "baseUrl")
        val KNOWN_EXPECTED_FIELDS = setOf(
            "outcome",
            "errorClass",
            "resultingEtag",
            "requestHeaderIfNoneMatch",
            "hasConfig",
            "requestUrlPrefix",
            "requestPath",
        )

        /** `server.behavior` discriminator values (#490) — see [respondFromCase]. */
        const val BEHAVIOR_RESPOND = "respond"
        const val BEHAVIOR_TIMEOUT = "timeout"
        const val BEHAVIOR_CLOSE_MID_RESPONSE = "close-mid-response"

        /** SHORT per-case request timeout for the behaviour=timeout case (ms). */
        const val TIMEOUT_BEHAVIOR_REQUEST_MS = 100L

        /** How long the timeout-behaviour handler hangs (ms) — must outlive the request deadline. */
        const val TIMEOUT_BEHAVIOR_HANG_MS = 5_000L

        /** Request timeout for every non-timeout behaviour (ms). */
        const val DEFAULT_REQUEST_TIMEOUT_MS = 5_000L

        /** Bytes of the close-mid-response body emitted before the socket is reset. */
        const val PARTIAL_PREFIX_CHARS = 16

        /**
         * Maps the KMP fetcher's stringly-typed [ConfigFetcher.FetchResult.error] onto the
         * corpus's normalised error-class vocabulary. The fetcher emits:
         *
         * - `"MALFORMED_JSON"` (JSON parse failure OR wrong-shape body) → `parseFailed`
         * - `"HTTP 403"` / `"HTTP 404"` → `invalidSdkKey` (per ConfigCat only 403/404 are
         *   invalid-SDK-key statuses; 401 is a generic retryable failure)
         * - `"HTTP <other-non-2xx>"` → `fetchFailed`
         * - `"timeout"` (HttpRequestTimeoutException / connect / socket timeout) → `timeout`
         * - any other fixed transport code (`network_error`, `body_read_failed`,
         *   `too_many_redirects`, `INVALID_SDK_KEY`) → `fetchFailed`
         *
         * The fetcher never returns exception text (#803 FR-002), so the mapping is on fixed codes.
         *
         * Mirrors sdk-java's `javaErrorToClass`, sdk-android's `androidErrorToClass`, sdk-go's
         * `goErrorToClass`, and sdk-python's `_python_error_to_class`. When the fetcher upgrades
         * to a typed enum (FR-018), this mapping moves to a `when` on that enum.
         */
        @JvmStatic
        fun kotlinMpErrorToClass(reason: String?): String {
            if (reason.isNullOrEmpty()) return "fetchFailed"
            if (reason == "MALFORMED_JSON") return "parseFailed"
            if (reason == "HTTP 403" || reason == "HTTP 404") return "invalidSdkKey"
            if (reason == ConfigFetcher.TIMEOUT) return "timeout"
            return "fetchFailed"
        }

        /**
         * Loads + projects each corpus case into a JUnit [Arguments] row keyed by case id so the
         * test output reports `WireCasesTest > wireCase("fresh-fetch-200")`.
         */
        @JvmStatic
        fun wireCases(): Stream<Arguments> {
            val raw = String(
                Files.readAllBytes(WorkspaceRoot.wireCasesPath()),
                StandardCharsets.UTF_8,
            )
            val corpus = Json.parseToJsonElement(raw) as JsonObject
            val cases = (corpus["cases"] as? JsonArray)
                ?: error("wire-cases.json carries no cases.")
            check(cases.isNotEmpty()) {
                "wire-cases.json carries no cases."
            }
            return cases.stream().map { element ->
                val obj = element.jsonObject
                Arguments.of(obj["id"]!!.jsonPrimitive.content, obj)
            }
        }

        /**
         * Returns the string content of a [JsonPrimitive], unless it is a JSON `null` literal, in
         * which case returns null. Distinguishes the corpus's `null` (explicit) from a string `""`.
         */
        private fun JsonPrimitive.contentOrEmpty(): String? = if (this is JsonNull) null else content
    }
}
