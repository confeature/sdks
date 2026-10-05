// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.ConfigFetcher
import io.confeature.android.internal.JsonParser
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.stream.Stream
import okhttp3.Call
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.jupiter.api.Assertions.fail
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource

/**
 * Wire-protocol fixture suite — Android consumer.
 *
 * Drives sdk-android's [ConfigFetcher] against each case in
 * `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The corpus is the language-agnostic
 * contract; this file is the Android consumer that maps the fetcher's typed [ConfigFetcher.Status]
 * plus stringly-typed [ConfigFetcher.FetchResult.error] onto the corpus's normalised
 * `{fetched, notModified, failed}` x `{fetchFailed, timeout, parseFailed, invalidSdkKey}`
 * vocabulary — the same vocabulary the other SDK families already conform to (sdk-node /
 * sdk-browser-js / sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-rust / sdk-java).
 *
 * Layer choice: this drives the fetcher directly (NOT the public [ConfeatureClient]), matching
 * what the other SDK slices already do — the wire-cases corpus by name tests wire behaviour, and
 * the fetcher is sdk-android's wire layer. Driving the public client would add poll-service
 * indirection that the corpus does not assert.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): every corpus case MUST pass (incl. the
 * `timeout` + `network-reset` behaviour cases added in #490 and the #803 `request-path-*` cases).
 * If a case drifts, STOP and investigate the fetcher — never mutate the corpus to make the test
 * green. A `given` / `expected` field this consumer does not read FAILS the case (#803 FR-003).
 *
 * The corpus's `server.behavior` discriminator (#490) selects how the mock transport acts:
 * `"respond"` (default / absent) delivers status+headers+body verbatim; `"timeout"` withholds the
 * response past a short per-case client timeout (→ the fetcher's timeout error class);
 * `"close-mid-response"` drops the socket mid-body (→ the fetcher's body-read failure → fetchFailed,
 * NOT parseFailed). An unrecognised behaviour FAILS the case loudly — it never falls through to
 * respond. Mirrors sdk-go's behaviour adapter (apps/sdk-go/wire_cases_test.go, commit a804507).
 *
 * See spec 112 / epic #146 / issue #148 (slice 10 of 17) + #490 / #590.
 */
class WireCasesTest {
    private companion object {
        /**
         * Default key for cases that do not pin `given.sdkKey`: a well-shaped legacy key, so its
         * #803 FR-001 path is the key verbatim.
         */
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

        /**
         * Maps the fetcher's stringly-typed [ConfigFetcher.FetchResult.error] onto the corpus's
         * normalised error-class vocabulary. The fetcher emits:
         *
         * - `"MALFORMED_JSON"` (JSON parse failure OR wrong-shape body) → `parseFailed`
         * - `"EMPTY_BODY"` (200 with empty payload) → `parseFailed`
         * - `"HTTP 403"` / `"HTTP 404"` → `invalidSdkKey` (per ConfigCat only 403/404 are
         *   invalid-SDK-key statuses; 401 is a generic retryable failure)
         * - `"HTTP <other-non-2xx>"` → `fetchFailed`
         * - `"timeout"` (call / connect / read timeout) → `timeout`
         * - any other fixed transport code (`network_error`, `body_read_failed`,
         *   `too_many_redirects`, `invalid_request`) → `fetchFailed`
         * - `"INVALID_SDK_KEY"` (the key cannot be a path segment; nothing fetched) →
         *   `invalidSdkKey`
         *
         * Mirrors sdk-java's `javaErrorToClass`, sdk-go's `goErrorToClass`, and sdk-python's
         * `_python_error_to_class`. When the fetcher upgrades to a typed enum (FR-018), this
         * mapping moves to a `when` on that enum.
         */
        fun androidErrorToClass(reason: String?): String {
            if (reason.isNullOrEmpty()) return "fetchFailed"
            if (reason == "MALFORMED_JSON" || reason == "EMPTY_BODY") return "parseFailed"
            if (reason == "HTTP 403" || reason == "HTTP 404") return "invalidSdkKey"
            if (reason.startsWith("HTTP ")) return "fetchFailed"
            if (reason == "timeout") return "timeout"
            if (reason == "INVALID_SDK_KEY") return "invalidSdkKey"
            return "fetchFailed"
        }

        /** Every `given` field this consumer reads; any other FAILS the case (#803 FR-003). */
        val KNOWN_GIVEN: Set<String> = setOf("previousEtag", "sdkKey", "baseUrl")

        /** Every `expected` field this consumer reads; any other FAILS the case. */
        val KNOWN_EXPECTED: Set<String> = setOf(
            "requestHeaderIfNoneMatch",
            "outcome",
            "resultingEtag",
            "hasConfig",
            "errorClass",
            "requestUrlPrefix",
            "requestPath",
        )

        /**
         * Loads + projects each corpus case into a JUnit [Arguments] row keyed by case id so the
         * test output reports `WireCasesTest > wireCase("fresh-fetch-200")`.
         */
        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun wireCases(): Stream<Arguments> {
            val raw = String(
                Files.readAllBytes(WorkspaceRoot.wireCasesPath()),
                StandardCharsets.UTF_8,
            )
            val corpus = JsonParser.parseObject(raw)
            val cases = corpus["cases"] as? List<Map<String, Any?>>
                ?: throw IllegalStateException(
                    "wire-cases.json carries no cases.",
                )
            if (cases.isEmpty()) {
                throw IllegalStateException(
                    "wire-cases.json carries no cases.",
                )
            }
            return cases.stream().map { wireCase ->
                Arguments.of(wireCase["id"] as String, wireCase)
            }
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("wireCases")
    @Suppress("UNCHECKED_CAST")
    fun wireCase(id: String, wireCase: Map<String, Any?>) {
        val given = wireCase["given"] as Map<String, Any?>
        val server = wireCase["server"] as Map<String, Any?>
        val expected = wireCase["expected"] as Map<String, Any?>
        assertThat(given.keys - KNOWN_GIVEN)
            .`as`("case %s carries a given field this consumer does not read", id)
            .isEmpty()
        assertThat(expected.keys - KNOWN_EXPECTED)
            .`as`("case %s carries an expected field this consumer does not read", id)
            .isEmpty()
        val sdkKey = given["sdkKey"] as String? ?: SDK_KEY

        // The behaviour adapter (#490) maps server.behavior onto the mock transport.
        // Absent/empty defaults to "respond".
        val behavior = (server["behavior"] as String?)?.takeIf { it.isNotEmpty() } ?: "respond"

        val mockServer = MockWebServer()
        try {
            mockServer.start()
            mockServer.enqueue(buildMockResponse(server, behavior))

            // The timeout case needs a short deadline so the suite stays fast; every other
            // behaviour keeps the standard 5s budget. Mirrors sdk-go's per-case requestTimeout.
            val requestTimeout =
                if (behavior == "timeout") Duration.ofMillis(200) else Duration.ofSeconds(5)

            val result: ConfigFetcher.FetchResult
            ConfigFetcher(
                mockServer.url("/").toString(),
                sdkKey,
                requestTimeout,
                TestLogger(),
            ).use { fetcher ->
                val prevETag = given["previousEtag"] as String?
                result = fetcher.fetch(prevETag ?: "")
            }

            // ---- Request-side assertions ------------------------------------
            // Bounded: a fetcher that sent nothing fails the case instead of hanging the suite.
            // The fetch has returned, so its one request is already recorded.
            val taken = mockServer.takeRequest(5, TimeUnit.SECONDS)
            assertThat(taken).`as`("fetcher MUST issue an HTTP request (case %s)", id).isNotNull()
            assertThat(mockServer.requestCount)
                .`as`("fetcher MUST issue exactly one HTTP request (case %s)", id)
                .isEqualTo(1)
            val recorded = taken!!
            // The path AS SENT — the raw request-target of the request line, query excluded,
            // never MockWebServer's re-parsed requestUrl (#803: an HTTP client may re-encode, a
            // mock may decode) — compared byte for byte: the corpus's requestPath when the case
            // pins one, else ConfigCat's /configuration-files/<sdkKey>/config_v6.json for the
            // default legacy key, which FR-001 sends verbatim.
            val wantPath = expected["requestPath"] as String?
                ?: "/configuration-files/$sdkKey/config_v6.json"
            assertThat(wirePath(recorded))
                .`as`("request path (case %s)", id)
                .isEqualTo(wantPath)
            assertRequestUrlPrefix(id, given, expected, sdkKey)
            assertIfNoneMatch(recorded, expected)
            if (expected.containsKey("hasConfig")) {
                assertThat(result.body != null)
                    .`as`("hasConfig (case %s)", id)
                    .isEqualTo(expected["hasConfig"])
            }

            // ---- Outcome assertions -----------------------------------------
            when (val outcome = expected["outcome"] as String) {
                "fetched" -> {
                    assertThat(result.status)
                        .`as`("outcome=fetched (case %s, error=%s)", id, result.error)
                        .isEqualTo(ConfigFetcher.Status.FETCHED)
                    val resultingEtag = expected["resultingEtag"]
                    if (resultingEtag != null) {
                        assertThat(result.etag).isEqualTo(resultingEtag)
                    }
                    assertThat(result.body).`as`("fetched outcome must populate body").isNotNull
                    assertThat(result.rawBody)
                        .`as`("fetched outcome must populate raw body")
                        .isNotNull
                }
                "notModified" -> {
                    assertThat(result.status)
                        .`as`("outcome=notModified (case %s, error=%s)", id, result.error)
                        .isEqualTo(ConfigFetcher.Status.NOT_MODIFIED)
                    val resultingEtag = expected["resultingEtag"]
                    if (resultingEtag != null) {
                        assertThat(result.etag).isEqualTo(resultingEtag)
                    }
                    assertThat(result.body)
                        .`as`("notModified outcome must NOT carry a body")
                        .isNull()
                }
                "failed" -> {
                    assertThat(result.status)
                        .`as`("outcome=failed (case %s, error=%s)", id, result.error)
                        .isEqualTo(ConfigFetcher.Status.FAILED)
                    val expectedClass = expected["errorClass"] as String
                    val actualClass = androidErrorToClass(result.error)
                    assertThat(actualClass)
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
        } finally {
            mockServer.shutdown()
        }
    }

    /**
     * Builds the [MockResponse] for one case, applying the `server.behavior` adapter (#490).
     *
     * - `"respond"` (default / absent): deliver status + headers + body verbatim. `bodyRef`
     *   resolves to a sibling fixture under `packages/test-fixtures-sdk-parity/fixtures/`; `body`
     *   is used verbatim (for malformed-payload cases). Either may be absent — 304 has no body.
     * - `"timeout"`: [SocketPolicy.NO_RESPONSE] — accept the connection but never send a response,
     *   so the fetcher's per-call timeout fires (→ the fixed `timeout` reason → `timeout` error
     *   class). The nominal status/headers are never delivered.
     * - `"close-mid-response"`: [SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY] — begin streaming the
     *   200 body, then drop the socket mid-body. The fetcher's body read sees a truncated stream
     *   (IOException) → `fetchFailed` (a transport failure, NOT a JSON-shape error → NOT
     *   parseFailed). The partial body is config-v6.boolean.json, cut off mid-stream.
     * - anything else: FAIL loudly — never fall through to respond (FR-008 guard).
     */
    @Suppress("UNCHECKED_CAST")
    private fun buildMockResponse(server: Map<String, Any?>, behavior: String): MockResponse {
        val response = MockResponse().setResponseCode((server["status"] as Number).toInt())
        val headers = (server["headers"] as? Map<String, String>) ?: emptyMap()
        for ((name, value) in headers) {
            response.setHeader(name, value)
        }
        val bodyRef = server["bodyRef"] as String?
        if (bodyRef != null) {
            val raw = Files.readAllBytes(WorkspaceRoot.fixturesDir().resolve(bodyRef))
            response.setBody(String(raw, StandardCharsets.UTF_8))
        } else {
            val body = server["body"] as String?
            if (body != null) {
                response.setBody(body)
            }
        }

        when (behavior) {
            "respond" -> Unit
            "timeout" -> response.socketPolicy = SocketPolicy.NO_RESPONSE
            "close-mid-response" ->
                response.socketPolicy = SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY
            else ->
                fail<Unit>("wire-cases: unsupported server.behavior \"$behavior\" — no adapter")
        }
        return response
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
     * Asserts the request's `If-None-Match` header against the corpus's three-state semantics:
     * absent (don't assert), explicit `null` (header MUST NOT be sent), explicit string (header
     * MUST equal). The JsonParser decode collapses absent + explicit-null into the same `null`
     * value, so we additionally check the key's presence.
     */
    private fun assertIfNoneMatch(recorded: RecordedRequest, expected: Map<String, Any?>) {
        if (!expected.containsKey("requestHeaderIfNoneMatch")) return
        val value = expected["requestHeaderIfNoneMatch"]
        val actual = recorded.getHeader("If-None-Match")
        if (value == null) {
            assertThat(actual).`as`("If-None-Match MUST NOT be sent").isNull()
        } else {
            assertThat(actual).`as`("If-None-Match round-trip").isEqualTo(value)
        }
    }
}
