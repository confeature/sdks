// SPDX-License-Identifier: MIT
package io.confeature.kmp

import com.sun.net.httpserver.HttpServer
import io.confeature.kmp.internal.ProviderResult
import io.confeature.kmp.internal.ProviderResult.Status
import io.confeature.kmp.internal.ProviderValueType
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds

class ProviderLazyLoadTest {
    @Test
    fun returnsTheCapturedValueAndCoalescesAColdLazyRefresh() = runBlocking {
        DelayedConfig().use { fixture ->
            val client = fixture.client()
            try {
                client.setOffline()
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                assertFalse(fixture.firstEntered.await(100, TimeUnit.MILLISECONDS))

                client.setOnline()
                val cold = client.providerDetails()
                assertEquals(Status.NOT_READY, cold.status)
                assertEquals(false, cold.value)
                assertTrue(fixture.firstEntered.await(5, TimeUnit.SECONDS))
                repeat(16) { assertEquals(Status.NOT_READY, client.providerDetails().status) }

                fixture.firstRelease.countDown()
                withTimeout(5_000) {
                    while (client.providerDetails().value != true) delay(10)
                }
                assertEquals(1, fixture.requests.get())
                client.setOffline()
                assertEquals(true, client.providerDetails().value)
                assertEquals(1, fixture.requests.get())
                client.close()
                assertEquals(Status.NOT_READY, client.providerDetails().status)
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun nativeForceRefreshWaitsForTheProviderAndKeepsTheNewerConfiguration() = runBlocking {
        DelayedConfig().use { fixture ->
            val client = fixture.client()
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                assertTrue(fixture.firstEntered.await(5, TimeUnit.SECONDS))
                val nativeStarted = CountDownLatch(1)
                val native = async(Dispatchers.Default) {
                    nativeStarted.countDown()
                    client.forceRefresh()
                }
                assertTrue(nativeStarted.await(5, TimeUnit.SECONDS))
                assertFalse(fixture.secondEntered.await(200, TimeUnit.MILLISECONDS))
                fixture.firstRelease.countDown()
                assertTrue(withTimeout(5_000) { native.await() })
                assertEquals("\"fixture-1\"", fixture.secondEtag.get())
                assertEquals(Status.RESOLVED, client.providerDetails().status)
                assertEquals(false, client.providerDetails().value)
                assertEquals(2, fixture.requests.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun closingAnInFlightProviderRefreshPreventsReadyAndChangeCallbacks() = runBlocking {
        DelayedConfig().use { fixture ->
            val client = fixture.client()
            val callbacks = CountDownLatch(1)
            client.getHooks().addOnClientReady { callbacks.countDown() }
            client.getHooks().addOnConfigChanged { callbacks.countDown() }
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                assertTrue(fixture.firstEntered.await(5, TimeUnit.SECONDS))
                client.close()
                fixture.firstRelease.countDown()
                assertTrue(fixture.firstFinished.await(5, TimeUnit.SECONDS))
                assertFalse(callbacks.await(200, TimeUnit.MILLISECONDS))
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                assertEquals(1, fixture.requests.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun closingFromConfigChangedPreventsTheReadyCallback() = runBlocking {
        DelayedConfig().use { fixture ->
            val client = fixture.client()
            val closedFromCallback = CountDownLatch(1)
            val ready = CountDownLatch(1)
            client.getHooks().addOnClientReady { ready.countDown() }
            client.getHooks().addOnConfigChanged {
                client.close()
                closedFromCallback.countDown()
            }
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                fixture.firstRelease.countDown()
                assertTrue(closedFromCallback.await(5, TimeUnit.SECONDS))
                assertFalse(ready.await(200, TimeUnit.MILLISECONDS))
                assertEquals(Status.NOT_READY, client.providerDetails().status)
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun customCacheCanRefreshAndItsLastWriteIsTheNewestSnapshot() = runBlocking {
        DelayedConfig().use { fixture ->
            lateinit var client: ConfeatureClient
            val writes = mutableListOf<String>()
            val cache = object : ConfigCache {
                override suspend fun read(cacheKey: String): String? = null

                override suspend fun write(cacheKey: String, value: String) {
                    if (writes.isEmpty()) {
                        // The nested refresh must complete while this write is in progress.
                        assertTrue(withTimeout(3_000) { client.forceRefresh() })
                    }
                    writes.add(value)
                }
            }
            client = fixture.client(customCache = cache)
            try {
                fixture.firstRelease.countDown()
                assertTrue(withTimeout(5_000) { client.forceRefresh() })
                assertEquals(2, fixture.requests.get())
                assertEquals(2, writes.size)
                assertTrue(writes.first().contains("\"b\":true"))
                assertTrue(writes.last().contains("\"b\":false"))
                assertEquals(false, client.providerDetails().value)
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun nativeFetchDiagnosticsAllowAReentrantLogger() = runBlocking {
        DelayedConfig(firstStatus = 503).use { fixture ->
            lateinit var client: ConfeatureClient
            var nestedRefresh: Boolean? = null
            val logger = object : Logger by Logger.default() {
                override fun error(message: String, throwable: Throwable?) {
                    if (message.contains("HTTP 503")) {
                        nestedRefresh = runBlocking { withTimeout(3_000) { client.forceRefresh() } }
                    }
                }
            }
            client = fixture.client(logger = logger)
            try {
                fixture.firstRelease.countDown()
                assertFalse(client.forceRefresh())
                assertEquals(true, nestedRefresh)
                assertEquals(2, fixture.requests.get())
                assertEquals(Status.RESOLVED, client.providerDetails().status)
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun aPositiveSubsecondTtlDoesNotRefreshTheWarmConfigurationImmediately() = runBlocking {
        DelayedConfig().use { fixture ->
            val client = fixture.client(polling = PollingMode.lazyLoad(900.milliseconds))
            try {
                fixture.firstRelease.countDown()
                assertTrue(client.forceRefresh())
                repeat(4) {
                    assertEquals(true, client.providerDetails().value)
                    delay(25)
                }
                assertFalse(fixture.secondEntered.await(150, TimeUnit.MILLISECONDS))
                assertEquals(1, fixture.requests.get())
                withTimeout(5_000) {
                    while (fixture.requests.get() < 2) {
                        client.providerDetails()
                        delay(25)
                    }
                }
                assertEquals(2, fixture.requests.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun providerCacheFallbackKeepsTheConfiguredPathOutOfDiagnostics() = runBlocking {
        DelayedConfig().use { fixture ->
            val path = Files.createTempFile("confeature-fixture-cache-sentinel", ".file")
            val logger = CapturingLogger()
            val client = fixture.client(path.toString(), logger)
            val ready = CountDownLatch(1)
            client.getHooks().addOnClientReady { ready.countDown() }
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                assertTrue(fixture.firstEntered.await(5, TimeUnit.SECONDS))
                fixture.firstRelease.countDown()
                assertTrue(ready.await(5, TimeUnit.SECONDS))
                assertEquals(true, client.providerDetails().value)
                assertTrue(logger.messages.contains("ERROR FilesystemCache: provider cache cannot be written to disk."))
                assertTrue(logger.messages.none { it.contains("confeature-fixture-cache-sentinel") })
            } finally {
                client.close()
                Files.deleteIfExists(path)
            }
        }
    }

    private fun ConfeatureClient.providerDetails(): ProviderResult =
        getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN)

    private class DelayedConfig(private val firstStatus: Int = 200) : AutoCloseable {
        val requests = AtomicInteger()
        val firstEntered = CountDownLatch(1)
        val firstRelease = CountDownLatch(1)
        val firstFinished = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)
        val secondEtag = AtomicReference<String?>()
        private val workers = Executors.newFixedThreadPool(2)
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)

        init {
            server.executor = workers
            server.createContext("/") { exchange ->
                val index = requests.incrementAndGet()
                try {
                    if (index == 1) {
                        firstEntered.countDown()
                        check(firstRelease.await(5, TimeUnit.SECONDS))
                    } else {
                        secondEtag.set(exchange.requestHeaders.getFirst("If-None-Match"))
                        secondEntered.countDown()
                    }
                    val body = """{"f":{"flag":{"t":0,"v":{"b":${index == 1}}}}}""".encodeToByteArray()
                    exchange.responseHeaders.set("ETag", "\"fixture-$index\"")
                    exchange.sendResponseHeaders(if (index == 1) firstStatus else 200, body.size.toLong())
                    exchange.responseBody.use { it.write(body) }
                } finally {
                    exchange.close()
                    if (index == 1) firstFinished.countDown()
                }
            }
            server.start()
        }

        fun client(
            cache: String = ":memory:",
            logger: Logger = Logger.default(),
            customCache: ConfigCache? = null,
            polling: PollingMode = PollingMode.lazyLoad(),
        ): ConfeatureClient =
            ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
                .baseUrl("http://127.0.0.1:${server.address.port}")
                .pollingMode(polling)
                .cacheDirectory(cache)
                .logger(logger)
                .apply { if (customCache != null) cache(customCache) }
                .build()

        override fun close() {
            firstRelease.countDown()
            server.stop(0)
            workers.shutdownNow()
        }
    }
}
