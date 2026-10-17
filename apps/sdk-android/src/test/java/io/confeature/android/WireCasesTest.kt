// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.ConfigFetcher
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Duration
import java.util.concurrent.TimeUnit
import java.util.stream.Stream
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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
         * Loads + projects each corpus case into a JUnit [Arguments] row keyed by case id so the
         * test output reports `WireCasesTest > wireCase("fresh-fetch-200")`.
         */
        @JvmStatic
        fun wireCases(): Stream<Arguments> =
            WireCaseAssertions.casesById().entries.stream().map { (id, wireCase) ->
                Arguments.of(id, wireCase)
            }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("wireCases")
    @Suppress("UNCHECKED_CAST")
    fun wireCase(id: String, wireCase: Map<String, Any?>) {
        val given = wireCase["given"] as Map<String, Any?>
        val server = wireCase["server"] as Map<String, Any?>
        val sdkKey = WireCaseAssertions.sdkKeyFor(wireCase, WireCaseAssertions.DEFAULT_SDK_KEY)

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

            // Bounded: a fetcher that sent nothing fails the case instead of hanging the suite.
            // The fetch has returned, so its one request is already recorded.
            val taken = mockServer.takeRequest(5, TimeUnit.SECONDS)
            assertThat(taken).`as`("fetcher MUST issue an HTTP request (case %s)", id).isNotNull()
            assertThat(mockServer.requestCount)
                .`as`("fetcher MUST issue exactly one HTTP request (case %s)", id)
                .isEqualTo(1)
            val recorded = taken!!
            // The raw request-target of the request line, query excluded — never
            // MockWebServer's re-parsed requestUrl (#803).
            WireCaseAssertions.assertWireCase(
                id,
                wireCase,
                sdkKey,
                WireCaseAssertions.SentRequest(wirePath(recorded), recorded.getHeader("If-None-Match")),
                result,
            )
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
}
