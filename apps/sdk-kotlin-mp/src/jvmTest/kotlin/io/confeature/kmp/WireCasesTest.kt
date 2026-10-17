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
import io.ktor.http.headers
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.cancel
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
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

        val behavior = WireCaseAssertions.field(server, "behavior") ?: BEHAVIOR_RESPOND
        val sdkKey = WireCaseAssertions.field(given, "sdkKey") ?: WireCaseAssertions.DEFAULT_SDK_KEY

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
            val url = capturedUrls.single()
            val wirePath = wireRequestTarget(given).substringBefore('?')
            // The mock must never see a different path than the socket.
            assertEquals(wirePath, url.encodedPath, "case=$id mock path vs wire path")
            WireCaseAssertions.assertWireCase(
                id,
                wireCase,
                sdkKey,
                WireCaseAssertions.SentRequest(wirePath, url.toString(), capturedIfNoneMatch.firstOrNull()),
                result,
            )
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
        baseUrl = WireCaseAssertions.field(given, "baseUrl") ?: DEFAULT_BASE_URL,
        sdkKey = WireCaseAssertions.field(given, "sdkKey") ?: WireCaseAssertions.DEFAULT_SDK_KEY,
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

    /**
     * Sends the case's request once more through the PRODUCTION Ktor client (the fetcher's default
     * factory — CIO on the JVM) to a raw TCP listener, and returns the request-target exactly as
     * the bytes arrived (#803 brief item 4: Ktor may re-encode a path between the string the SDK
     * builds and the socket; the [MockEngine] only sees Ktor's parsed view). The case's base path,
     * if any, is kept; only scheme + authority move to the listener.
     */
    private fun wireRequestTarget(given: JsonObject): String = runBlocking {
        RawHttpListener().use { listener ->
            val basePath = WireCaseAssertions.field(given, "baseUrl")
                ?.let { Url(it).encodedPath.trimEnd('/') }
                .orEmpty()
            val fetcher = ConfigFetcher(
                baseUrl = listener.baseUrl + basePath,
                sdkKey = WireCaseAssertions.field(given, "sdkKey")
                    ?: WireCaseAssertions.DEFAULT_SDK_KEY,
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

    private fun readPreviousEtag(given: JsonObject): String = when (val raw = given["previousEtag"]) {
        null, JsonNull -> ""
        is JsonPrimitive -> raw.content
        else -> error("unexpected previousEtag shape: $raw")
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
        val bodyRef = WireCaseAssertions.field(server, "bodyRef")
        val bodyText: String? = when {
            bodyRef != null -> {
                val raw = Files.readAllBytes(WorkspaceRoot.fixturesDir().resolve(bodyRef))
                String(raw, StandardCharsets.UTF_8)
            }
            else -> WireCaseAssertions.field(server, "body")
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
        /** Base URL when a case does not pin `given.baseUrl`. */
        const val DEFAULT_BASE_URL = "https://mock.confeature.test"

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
         * Loads + projects each corpus case into a JUnit [Arguments] row keyed by case id so the
         * test output reports `WireCasesTest > wireCase("fresh-fetch-200")`.
         */
        @JvmStatic
        fun wireCases(): Stream<Arguments> =
            WireCaseAssertions.casesById().entries.stream().map { (id, wireCase) ->
                Arguments.of(id, wireCase)
            }
    }
}
