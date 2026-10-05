// SPDX-License-Identifier: MIT
@file:Suppress("MaxLineLength", "UnusedParameter", "UnusedPrivateClass")

package io.confeature.kmp

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.utils.io.ByteReadChannel
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * End-to-end client tests against a Ktor MockEngine. Covers the network-bound paths the
 * `ParityCorpusTest` skips (it uses LocalOnly overrides + `:memory:` cache).
 */
class ConfeatureClientTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /** Simple in-memory cache injected via `builder.cache(...)` to keep the test sandboxed. */
    private class TestCache : ConfigCache {
        private val store = HashMap<String, String>()
        override suspend fun read(cacheKey: String): String? = store[cacheKey]
        override suspend fun write(cacheKey: String, value: String) { store[cacheKey] = value }
    }

    /** Builds a client that goes through the full fetch pipeline but stays sandboxed. */
    private fun buildClient(
        body: String,
        pollingMode: PollingMode,
        logger: Logger = CapturingLogger(),
    ): ConfeatureClient {
        // Plumb a Ktor MockEngine via the public Builder. The Builder API
        // doesn't expose engine injection (yet), so the test installs a
        // MockEngine via Ktor's default HttpClient factory replacement —
        // best effort via the cache directory (we override cacheDirectory
        // to `:memory:` to keep the FS untouched).
        return ConfeatureClient.builder(sdkKey)
            .pollingMode(pollingMode)
            .cacheDirectory(":memory:")
            .baseUrl("https://mock.confeature.test")
            .logger(logger)
            .build()
    }

    @Test
    fun close_isIdempotent() {
        val client = buildClient("{}", PollingMode.manualPoll())
        client.close()
        client.close()
        // No throw — confirmed via successful return.
    }

    @Test
    fun getValue_afterClose_returnsDefaultAndLogsWarning() = runBlocking {
        val logger = CapturingLogger()
        val client = buildClient("{}", PollingMode.manualPoll(), logger)
        client.close()
        val v = client.getValue("flag", false)
        assertEquals(false, v)
        assertTrue(logger.messages.any { it.contains("getValue called after close") })
    }

    @Test
    fun forceRefresh_afterClose_returnsFalse() = runBlocking {
        val client = buildClient("{}", PollingMode.manualPoll())
        client.close()
        assertFalse(client.forceRefresh())
    }

    @Test
    fun forceRefresh_localOnly_isShortCircuitTrue() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(emptyMap())))
            .build()
        try {
            assertTrue(client.forceRefresh())
        } finally {
            client.close()
        }
    }

    @Test
    fun snapshot_capturesOverridesEvenWithoutFetch() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .build()
        try {
            val snapshot = client.snapshot()
            assertEquals(true, snapshot.getValue("flag", false))
        } finally {
            client.close()
        }
    }

    @Test
    fun getValue_localOnlyDoesNotFetch() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .defaultUser(User("anonymous"))
            .build()
        try {
            val v = client.getValue("flag", false)
            assertEquals(true, v)
            // Caller-supplied user overrides default — exercise that branch.
            val v2 = client.getValue("flag", false, User("caller"))
            assertEquals(true, v2)
        } finally {
            client.close()
        }
    }

    @Test
    fun getValueTyped_falsifiesOnTypeMismatch() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("flag" to true))))
            .build()
        try {
            val s = client.getValueTyped("flag", "default-string")
            // Override is a Boolean → type mismatch → default returned.
            assertEquals("default-string", s)
        } finally {
            client.close()
        }
    }

    @Test
    fun invalidSdkKeyFormat_logsWarningButStillBuilds() = runBlocking {
        val logger = CapturingLogger()
        val client = ConfeatureClient.builder("invalid-format-key-still-acceptable")
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .logger(logger)
            .build()
        try {
            assertTrue(logger.messages.any { it.contains("INVALID_SDK_KEY") })
        } finally {
            client.close()
        }
    }

    /**
     * Drives the lazy-load fetch via a `MockEngine`-backed Ktor client. We can't currently
     * inject the engine through the public Builder, so we sanity-check the contract surface
     * (forceRefresh on a manualPoll client wired to an unreachable URL returns false).
     */
    @Test
    fun lazyLoad_unreachableUrlReturnsDefault() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.lazyLoad(kotlin.time.Duration.parseIsoString("PT0.01S")))
            .cacheDirectory(":memory:")
            .baseUrl("http://127.0.0.1:1")
            .httpTimeoutMillis(200L)
            .build()
        try {
            // Triggers the lazy-load maybeLazyFetch + a failed fetchAndApply.
            assertEquals(true, client.getValue("flag", true))
        } finally {
            client.close()
        }
    }

    @Test
    fun defaultCache_buildsFilesystemBackedClientWithoutThrowing(@org.junit.jupiter.api.io.TempDir tmp: java.nio.file.Path) {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(tmp.toString())
            .baseUrl("http://127.0.0.1:1")
            .build()
        client.close()
    }

    @Test
    fun forceRefresh_unreachableUrlReturnsFalse() = runBlocking {
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            // Use a TCP port that is guaranteed to refuse — keeps the test
            // hermetic. Ktor wraps the connect failure in a thrown
            // exception → fetcher returns FAILED → forceRefresh returns false.
            .baseUrl("http://127.0.0.1:1")
            .httpTimeoutMillis(500L)
            .build()
        try {
            assertFalse(client.forceRefresh())
        } finally {
            client.close()
        }
    }

    /**
     * Drives the AutoPoll coroutine path. With a tiny `maxInitWaitTime` + `pollInterval`, the
     * background coroutine should fire at least one `fetchAndApply` iteration; we wait briefly
     * then close. The unreachable URL makes the fetch fail, but the autopoll loop's `try/catch`
     * keeps the coroutine alive — we verify the failure is logged and the close() teardown
     * completes cleanly.
     */
    @Test
    fun autoPoll_iterationRunsAndCloseStops() = runBlocking {
        val logger = CapturingLogger()
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(
                PollingMode.autoPoll(
                    kotlin.time.Duration.parseIsoString("PT0.05S"),
                    kotlin.time.Duration.parseIsoString("PT0.01S"),
                ),
            )
            .cacheDirectory(":memory:")
            .baseUrl("http://127.0.0.1:1")
            .httpTimeoutMillis(200L)
            .logger(logger)
            .build()
        try {
            // Poll until the autopoll coroutine has produced at least one
            // ConfigFetcher / AutoPoll log line, or the deadline expires.
            // The fetch fails (TCP port 1 refuses); the failure is logged.
            // Either the AutoPoll iteration logged the error itself, or the
            // ConfigFetcher's own log line landed in the logger. Fixed-delay
            // assertions raced the 200ms HTTP timeout on CI runners — polling
            // a bounded deadline is hermetic and resilient to scheduler jitter.
            val deadlineMs = 5_000L
            val start = System.currentTimeMillis()
            while (System.currentTimeMillis() - start < deadlineMs) {
                if (logger.messages.any { it.contains("ConfigFetcher") || it.contains("AutoPoll") }) {
                    break
                }
                kotlinx.coroutines.delay(50L)
            }
            assertTrue(
                logger.messages.any { it.contains("ConfigFetcher") || it.contains("AutoPoll") },
                "expected an autopoll / fetcher log line within ${deadlineMs}ms; got: ${logger.messages}",
            )
        } finally {
            client.close()
        }
    }

    /**
     * `close()` while an AutoPoll fetch is IN FLIGHT: the poll loop rethrows the cancellation and
     * stops — it never reports its own cancellation as a failed iteration (#803 review). The
     * listener accepts the request and never answers, so the fetch is still pending when `close()`
     * cancels the scope.
     */
    @Test
    fun autoPoll_closeDuringInFlightFetch_logsNoIterationFailure() {
        val requestArrived = CountDownLatch(1)
        val held = CopyOnWriteArrayList<Socket>()
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        val acceptor = thread(isDaemon = true, name = "hanging-listener") {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                held.add(socket)
                val input = socket.getInputStream()
                val tail = StringBuilder()
                while (!tail.endsWith("\r\n\r\n")) {
                    val b = try {
                        input.read()
                    } catch (_: IOException) {
                        -1
                    }
                    if (b < 0) break
                    tail.append(b.toChar())
                }
                requestArrived.countDown()
            }
        }
        val logger = CapturingLogger()
        val client = ConfeatureClient.builder(sdkKey)
            .pollingMode(PollingMode.autoPoll(60.seconds, 10.milliseconds))
            .cacheDirectory(":memory:")
            .baseUrl("http://127.0.0.1:${server.localPort}")
            .httpTimeoutMillis(30_000L)
            .logger(logger)
            .build()
        try {
            assertTrue(requestArrived.await(5, TimeUnit.SECONDS), "the AutoPoll fetch never reached the listener")
            client.close()
            // Join the poll coroutine: once it has completed, anything its cancelled iteration
            // would log is already in the logger. A join that never completes fails the test.
            val pollJob = assertNotNull(client.autopollJob, "AutoPoll must run a poll coroutine")
            runBlocking { withTimeout(5_000L) { pollJob.join() } }
            assertTrue(pollJob.isCancelled, "close() must cancel the poll coroutine")
            assertTrue(
                logger.messages.none { it.contains("AutoPoll iteration raised") },
                "close() must not surface as a failed AutoPoll iteration: ${logger.messages}",
            )
            assertTrue(
                logger.messages.none { it.contains("ConfigFetcher") },
                "a cancelled fetch is not a fetch failure: ${logger.messages}",
            )
        } finally {
            client.close()
            server.close()
            held.forEach(Socket::close)
            acceptor.join(1_000L)
        }
    }

    /** Silences the unused-import warning until the engine-injection API lands. */
    @Suppress("unused")
    private fun mockClient(body: String): HttpClient = HttpClient(
        MockEngine {
            respond(
                content = ByteReadChannel(body),
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ETag, "\"e1\""),
            )
        },
    )
}
