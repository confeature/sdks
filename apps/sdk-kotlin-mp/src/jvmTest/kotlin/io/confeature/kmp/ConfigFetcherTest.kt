// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import io.confeature.kmp.internal.SdkKey
import io.confeature.kmp.internal.escapePathSegment
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.cancel
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Test
import java.io.IOException
import java.lang.reflect.Modifier
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Ktor `MockEngine`-driven contract test for [ConfigFetcher].
 *
 * Mirrors `apps/sdk-java/.../ConfigFetcherTest.java` 1:1 at the assertion level:
 * - 200 → FETCHED, captures ETag + body.
 * - 304 → NOT_MODIFIED, forwards `If-None-Match` header.
 * - 500 → FAILED, SDK key NEVER appears in any log line.
 * - User-Agent stamped per FR-012.
 * - Request path is ConfigCat's: the raw key, `/configuration-files/<key>/config_v6.json` (#803),
 *   asserted on the raw request line a TCP listener received from the production client.
 * - Forced timeout / mid-body reset / redirect loop / a thrown `kotlin.Error` never leak the key
 *   (#803 FR-002) — the test logger records the throwable and its whole cause chain.
 * - An unusable base URL is `invalid_request` with nothing sent; a cancelled caller is not
 *   reported as a failed fetch.
 */
class ConfigFetcherTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /** Captures every request the fake engine sees so assertions can inspect headers / URL. */
    private class RecordingEngine(
        private val handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ) {
        val received: MutableList<HttpRequestData> = CopyOnWriteArrayList()

        fun newClient(configure: HttpClientConfig<*>.() -> Unit = {}): HttpClient = HttpClient(
            MockEngine { request ->
                received.add(request)
                handler(request)
            },
            configure,
        )
    }

    @Test
    fun fetch_200_parsesBodyAndCapturesEtag() = runBlocking {
        val engine = RecordingEngine { _ ->
            respond(
                content = ByteReadChannel(
                    "{\"p\":{\"u\":\"https://cdn.example\",\"r\":0,\"s\":\"v1\"},\"f\":{},\"s\":[]}",
                ),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ETag, "\"abc123\""),
            )
        }
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = sdkKey,
            timeoutMillis = 5_000L,
            logger = CapturingLogger(),
            httpClientFactory = { engine.newClient() },
        )
        try {
            val result = fetcher.fetch("")
            assertEquals(ConfigFetcher.Status.FETCHED, result.status)
            assertEquals("\"abc123\"", result.etag)
            assertNotNull(result.body)
            assertTrue(result.body!!.containsKey("f"))
            assertTrue(result.rawBody!!.contains("\"f\""))
        } finally {
            fetcher.close()
        }
    }

    @Test
    fun fetch_304_returnsNotModified() = runBlocking {
        val engine = RecordingEngine { _ ->
            respond(
                content = ByteReadChannel(ByteArray(0)),
                status = HttpStatusCode.NotModified,
                headers = headersOf(HttpHeaders.ETag, "\"abc123\""),
            )
        }
        val logger = CapturingLogger()
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = sdkKey,
            timeoutMillis = 5_000L,
            logger = logger,
            httpClientFactory = { engine.newClient() },
        )
        try {
            val result = fetcher.fetch("\"abc123\"")
            assertEquals(ConfigFetcher.Status.NOT_MODIFIED, result.status)
            assertEquals("\"abc123\"", result.etag)
            val req = engine.received.single()
            assertEquals("\"abc123\"", req.headers[HttpHeaders.IfNoneMatch])
        } finally {
            fetcher.close()
        }
    }

    @Test
    fun fetch_500_reportsFailureWithRedactedSdkKey() = runBlocking {
        val engine = RecordingEngine { _ ->
            respond(
                content = ByteReadChannel(ByteArray(0)),
                status = HttpStatusCode.InternalServerError,
            )
        }
        val logger = CapturingLogger()
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = sdkKey,
            timeoutMillis = 5_000L,
            logger = logger,
            httpClientFactory = { engine.newClient() },
        )
        try {
            val result = fetcher.fetch("")
            assertEquals(ConfigFetcher.Status.FAILED, result.status)
            assertTrue(result.error.contains("HTTP 500"))
            // SDK key MUST NOT appear in any log line.
            for (m in logger.messages) {
                assertTrue(
                    !m.contains(sdkKey),
                    "logged message must not contain raw SDK key: $m",
                )
            }
        } finally {
            fetcher.close()
        }
    }

    @Test
    fun fetch_emitsExpectedUserAgent() = runBlocking {
        val engine = RecordingEngine { _ ->
            respond(
                content = ByteReadChannel("{}"),
                status = HttpStatusCode.OK,
            )
        }
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = sdkKey,
            timeoutMillis = 5_000L,
            logger = CapturingLogger(),
            httpClientFactory = { engine.newClient() },
        )
        try {
            fetcher.fetch("")
            val req = engine.received.single()
            assertEquals(
                "confeature-kmp-sdk/${Version.SDK_VERSION}",
                req.headers[HttpHeaders.UserAgent],
            )
        } finally {
            fetcher.close()
        }
    }

    /**
     * Fetches once through the PRODUCTION Ktor client (the default factory — CIO on the JVM) against
     * a raw TCP listener, and returns the request-target exactly as the bytes arrived. Ktor may
     * re-encode a path between the string the SDK builds and the socket; this sees the socket.
     */
    private fun requestedPath(key: String): String = runBlocking {
        RawHttpListener().use { listener ->
            val fetcher = ConfigFetcher(
                baseUrl = listener.baseUrl,
                sdkKey = key,
                timeoutMillis = 5_000L,
                logger = CapturingLogger(),
            )
            try {
                assertEquals(ConfigFetcher.Status.FETCHED, fetcher.fetch("").status)
                listener.requestTargets.single()
            } finally {
                fetcher.close()
            }
        }
    }

    @Test
    fun fetch_legacyKey_requestsTheRawKeyPath() {
        // #803 FR-001 — ConfigCat's path (com.configcat.fetch.ConfigFetcher appends the raw
        // sdkKey): no /v2/ prefix, no cache-key tail.
        assertEquals("/configuration-files/$sdkKey/config_v6.json", requestedPath(sdkKey))
    }

    @Test
    fun fetch_configCatKey_travelsRawAsThreeSegments() {
        assertEquals(
            "/configuration-files/configcat-sdk-1/$PART_A/$PART_B/config_v6.json",
            requestedPath(CONFIGCAT_KEY),
        )
    }

    @Test
    fun fetch_malformedKey_isOneEscapedSegment() {
        assertEquals(
            "/configuration-files/configcat-sdk-1%2Fshort%2Fkey/config_v6.json",
            requestedPath("configcat-sdk-1/short/key"),
        )
    }

    /**
     * #803 FR-001 — a malformed key goes out as ONE segment escaped exactly like Go's
     * `url.PathEscape`. The expected bytes are Go's real output (copied, never recomputed), and
     * they are compared with the request line as it reached the socket.
     */
    @Test
    fun fetch_malformedKey_onTheWire_isGoPathEscape() {
        assertEquals(
            "/configuration-files/" +
                "bad%20key\$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25../config_v6.json",
            requestedPath("bad key\$&+:=@,;!'()*~/x?y#z%.."),
        )
    }

    /**
     * #803 — a base URL without an http(s) scheme or host is refused with the fixed
     * `invalid_request` code and NOTHING is sent: Ktor would resolve `cdn.example.test` against its
     * default `http://localhost` and send the keyed request there. The constructor never throws.
     */
    @Test
    fun fetch_unusableBaseUrl_isInvalidRequest_andSendsNothing() = runBlocking {
        val unusable = listOf(
            "cdn.example.test",
            "localhost:8080",
            "/configuration-files",
            "ftp://cdn.example.test",
            "https://",
            "https:///path",
            "https://user@",
            "https://cdn.example.test?x=1",
            "https://cdn.example.test#frag",
            "https://cdn.example.test:notaport",
            "://cdn.example.test",
        )
        for (base in unusable) {
            val engine = RecordingEngine { _ -> respond("{\"f\":{}}") }
            val logger = CapturingLogger()
            val fetcher = ConfigFetcher(
                baseUrl = base,
                sdkKey = CONFIGCAT_KEY,
                timeoutMillis = 5_000L,
                logger = logger,
                httpClientFactory = { engine.newClient() },
            )
            try {
                val result = fetcher.fetch("")
                assertEquals(ConfigFetcher.Status.FAILED, result.status, "base=\"$base\"")
                assertEquals(ConfigFetcher.INVALID_REQUEST, result.error, "base=\"$base\"")
                assertTrue(engine.received.isEmpty(), "no request may be sent for base=\"$base\"")
                assertTrue(logger.messages.any { it.contains(ConfigFetcher.INVALID_REQUEST) })
                assertKeyFree(CONFIGCAT_KEY, result, logger, "base=\"$base\"")
            } finally {
                fetcher.close()
            }
        }
    }

    /**
     * Structured concurrency — when the CALLER is cancelled mid-request, [ConfigFetcher.fetch]
     * rethrows the cancellation: it returns no result and logs no failure.
     */
    @Test
    fun fetch_cancelledCaller_propagatesCancellation_andLogsNothing() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val engine = RecordingEngine { _ ->
            started.complete(Unit)
            awaitCancellation()
        }
        val logger = CapturingLogger()
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = CONFIGCAT_KEY,
            timeoutMillis = 5_000L,
            logger = logger,
            httpClientFactory = { engine.newClient() },
        )
        try {
            val returned = AtomicReference<ConfigFetcher.FetchResult?>(null)
            val job = launch(Dispatchers.Default) { returned.set(fetcher.fetch("")) }
            withTimeout(CANCEL_BUDGET_MS) {
                started.await()
                job.cancelAndJoin()
            }
            assertTrue(job.isCancelled)
            assertEquals(null, returned.get(), "a cancelled fetch must not return a result")
            assertTrue(logger.messages.isEmpty(), "a cancelled fetch must log nothing: ${logger.messages}")
        } finally {
            fetcher.close()
        }
    }

    /**
     * Ktor's JS engine surfaces a failed browser `fetch` as a `kotlin.Error`, not an Exception. The
     * fetcher must reduce it to a fixed code like any transport failure — never let it (or its
     * URL-quoting message) escape.
     */
    @Test
    @Suppress("TooGenericExceptionThrown") // the JS engine's own failure type, simulated on the JVM
    fun fetch_engineThrowsKotlinError_isNetworkError_andKeyFree() = runBlocking {
        val engine = RecordingEngine { request ->
            throw Error("TypeError: Failed to fetch ${request.url}")
        }
        val logger = CapturingLogger()
        val fetcher = ConfigFetcher(
            baseUrl = "https://mock.confeature.test",
            sdkKey = CONFIGCAT_KEY,
            timeoutMillis = 5_000L,
            logger = logger,
            httpClientFactory = { engine.newClient() },
        )
        try {
            val result = fetcher.fetch("")
            assertEquals(ConfigFetcher.Status.FAILED, result.status)
            assertEquals(ConfigFetcher.NETWORK_ERROR, result.error)
            assertKeyFree(CONFIGCAT_KEY, result, logger, "kotlin.Error")
        } finally {
            fetcher.close()
        }
    }

    /**
     * The `Throwable` catch is for the JS engine's recoverable `kotlin.Error` only: a fatal JVM error
     * thrown mid-request (out of memory, stack overflow, a linkage failure) propagates as-is — it is
     * never reported as a `network_error` result, and nothing is logged for it.
     */
    @Test
    fun fetch_fatalJvmError_propagates_andIsNotAFetchFailure() = runBlocking {
        val fatals: List<Throwable> = listOf(
            OutOfMemoryError("simulated"),
            StackOverflowError("simulated"),
            NoClassDefFoundError("simulated"),
        )
        for (fatal in fatals) {
            val engine = RecordingEngine { _ -> throw fatal }
            val logger = CapturingLogger()
            val fetcher = ConfigFetcher(
                baseUrl = "https://mock.confeature.test",
                sdkKey = CONFIGCAT_KEY,
                timeoutMillis = 5_000L,
                logger = logger,
                httpClientFactory = { engine.newClient() },
            )
            try {
                val thrown = assertFailsWith<Throwable>("${fatal::class.simpleName} must propagate") {
                    fetcher.fetch("")
                }
                // Same class + message, not the same instance: coroutines' stack-trace recovery may
                // rethrow a copy across the suspension point. A wrapper (or a result) fails this.
                assertEquals(fatal::class, thrown::class, "the fatal error propagates unwrapped")
                assertEquals(fatal.message, thrown.message)
                assertTrue(logger.messages.isEmpty(), "a fatal error is not a logged fetch failure")
            } finally {
                fetcher.close()
            }
        }
    }

    /**
     * #803 — the keyed URL and the transport seam stay out of the JVM-public surface. Kotlin
     * `internal` is PUBLIC in bytecode (a getter named `getUrl$<module>`), so this reads what Java —
     * or reflection — actually sees, as sdk-android's
     * `configFetcher_publicJvmSurface_exposesNoKeyedUrlAndNoTransportSetter` does: every public
     * zero-argument method is invoked and every public field read, for a ConfigCat-shaped key, a
     * legacy key and a malformed key, and none may return the key, a 22-char part, or the escaped
     * key; no public method may take an [HttpClient] or a client factory, nor be named `getUrl…`.
     */
    @Test
    fun configFetcher_publicJvmSurface_exposesNoKeyedUrlAndNoTransportSetter() {
        val type = ConfigFetcher::class.java
        for (key in listOf(CONFIGCAT_KEY, sdkKey, "bad key/$PART_A")) {
            val engine = RecordingEngine { _ -> respond("{\"f\":{}}") }
            val fetcher = ConfigFetcher(
                baseUrl = "https://mock.confeature.test",
                sdkKey = key,
                timeoutMillis = 5_000L,
                logger = CapturingLogger(),
                httpClientFactory = { engine.newClient() },
            )
            try {
                val secrets = listOf(key, PART_A, PART_B, escapePathSegment(key)) +
                    key.split('/', '-', ' ').filter { it.length >= MIN_SECRET_PART }
                for (m in type.methods) {
                    val params = m.parameterTypes.toList()
                    assertTrue(HttpClient::class.java !in params, "public $m takes an HttpClient")
                    assertTrue(Function0::class.java !in params, "public $m takes a client factory")
                    if (m.parameterCount != 0 || m.returnType == Void.TYPE) continue
                    val target = if (Modifier.isStatic(m.modifiers)) null else fetcher
                    assertNoSecret(m.invoke(target), secrets, "public method $m (key=${SdkKey.redact(key)})")
                }
                for (f in type.fields) {
                    val target = if (Modifier.isStatic(f.modifiers)) null else fetcher
                    assertNoSecret(f.get(target), secrets, "public field $f (key=${SdkKey.redact(key)})")
                }
            } finally {
                fetcher.close()
            }
        }
        val getters = type.methods.map { it.name }.filter { it.startsWith("getUrl") }
        assertTrue(getters.isEmpty(), "ConfigFetcher exposes a public URL getter: $getters")
    }

    private fun assertNoSecret(value: Any?, secrets: List<String>, what: String) {
        val shown = value?.toString() ?: return
        for (secret in secrets) {
            assertTrue(!shown.contains(secret), "$what returns the key or a part of it")
        }
    }

    @Test
    fun fetch_emptyDotOrDotDotKey_sendsNoRequest() = runBlocking {
        for (key in listOf("", ".", "..")) {
            val engine = RecordingEngine { _ -> respond("{}") }
            val logger = CapturingLogger()
            val fetcher = ConfigFetcher(
                baseUrl = "https://mock.confeature.test",
                sdkKey = key,
                timeoutMillis = 5_000L,
                logger = logger,
                httpClientFactory = { engine.newClient() },
            )
            try {
                val result = fetcher.fetch("")
                assertEquals(ConfigFetcher.Status.FAILED, result.status, "key=\"$key\"")
                assertEquals(ConfigFetcher.INVALID_SDK_KEY, result.error)
                assertTrue(engine.received.isEmpty(), "no request may be sent for key=\"$key\"")
                assertTrue(logger.messages.any { it.contains("INVALID_SDK_KEY") })
            } finally {
                fetcher.close()
            }
        }
    }

    /**
     * #803 FR-002/FR-004 — the URL now carries the key, and Ktor quotes the URL in its exception
     * messages ("Request timeout has expired [url=…]"). Forces a timeout, a mid-body reset and a
     * redirect loop, and asserts neither the key nor any of its parts reaches a log line or the
     * fetch result's error.
     */
    @Test
    fun fetch_forcedFailures_neverLeakTheKey() = runBlocking {
        for (key in listOf(CONFIGCAT_KEY, sdkKey)) {
            for ((scenario, expectedReasons) in FORCED_FAILURES) {
                val logger = CapturingLogger()
                val engine = RecordingEngine { request -> forcedFailure(scenario, request) }
                val fetcher = ConfigFetcher(
                    baseUrl = "https://mock.confeature.test",
                    sdkKey = key,
                    timeoutMillis = 5_000L,
                    logger = logger,
                    httpClientFactory = {
                        engine.newClient {
                            // Only the timeout scenario gets the SHORT deadline: a 20-hop redirect
                            // loop on a loaded host can outlast 100 ms and read as a timeout.
                            install(HttpTimeout) {
                                requestTimeoutMillis =
                                    if (scenario == "timeout") FORCED_TIMEOUT_MS else FORCED_HANG_MS
                            }
                        }
                    },
                )
                try {
                    val result = fetcher.fetch("")
                    assertEquals(ConfigFetcher.Status.FAILED, result.status, scenario)
                    assertTrue(result.error in expectedReasons, "$scenario: ${result.error}")
                    assertTrue(logger.messages.isNotEmpty(), "$scenario must log")
                    assertKeyFree(key, result, logger, scenario)
                } finally {
                    fetcher.close()
                }
            }
        }
    }

    /**
     * Neither [key] nor any of its parts (the 22-char ConfigCat parts, the 32-char legacy parts)
     * may appear in the result's error or in ANY captured log line — throwable lines included.
     */
    private fun assertKeyFree(
        key: String,
        result: ConfigFetcher.FetchResult,
        logger: CapturingLogger,
        scenario: String,
    ) {
        val secrets = listOf(key) + key.split('/', '-').filter { it.length >= MIN_SECRET_PART }
        for (secret in secrets) {
            assertTrue(!result.error.contains(secret), "$scenario error leaked $secret")
            for (m in logger.messages) {
                assertTrue(!m.contains(secret), "$scenario log leaked $secret: $m")
            }
        }
    }

    private suspend fun MockRequestHandleScope.forcedFailure(
        scenario: String,
        request: HttpRequestData,
    ): HttpResponseData = when (scenario) {
        "timeout" -> {
            delay(FORCED_HANG_MS)
            respond("{}")
        }
        "mid-body-reset" -> {
            val channel = ByteChannel(autoFlush = true)
            channel.writeStringUtf8("{\"p\":")
            channel.flush()
            channel.cancel(IOException("connection reset mid-response"))
            respond(content = channel, status = HttpStatusCode.OK)
        }
        "redirect-loop" -> respond(
            content = ByteReadChannel(ByteArray(0)),
            status = HttpStatusCode.Found,
            headers = headersOf(HttpHeaders.Location, request.url.toString()),
        )
        else -> error("unknown scenario $scenario")
    }

    private companion object {
        const val PART_A = "FAKEfixtureKeyNotRea01"
        const val PART_B = "FAKEfixtureKeyNotRea02"
        const val CONFIGCAT_KEY = "configcat-sdk-1/$PART_A/$PART_B"

        /** Shortest key part treated as secret (the 22-char ConfigCat parts, the 32-char legacy). */
        const val MIN_SECRET_PART = 22

        const val FORCED_TIMEOUT_MS = 100L
        const val FORCED_HANG_MS = 5_000L
        const val CANCEL_BUDGET_MS = 5_000L

        val FORCED_FAILURES: List<Pair<String, Set<String>>> = listOf(
            "timeout" to setOf(ConfigFetcher.TIMEOUT),
            // Ktor 3 may buffer the body inside `get`, so a reset surfaces there or in
            // bodyAsText — either way a transport failure (wire-cases `network-reset`).
            "mid-body-reset" to setOf(ConfigFetcher.BODY_READ_FAILED, ConfigFetcher.NETWORK_ERROR),
            "redirect-loop" to setOf(ConfigFetcher.TOO_MANY_REDIRECTS),
        )
    }
}
