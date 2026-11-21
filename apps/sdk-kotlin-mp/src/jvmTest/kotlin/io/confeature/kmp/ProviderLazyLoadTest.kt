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
                assertTrue(logger.messages.none { it.contains("confeature-fixture-cache-sentinel") })
            } finally {
                client.close()
                Files.deleteIfExists(path)
            }
        }
    }

    private fun ConfeatureClient.providerDetails(): ProviderResult =
        getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN)

    private class DelayedConfig : AutoCloseable {
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
                    exchange.sendResponseHeaders(200, body.size.toLong())
                    exchange.responseBody.use { it.write(body) }
                } finally {
                    exchange.close()
                    if (index == 1) firstFinished.countDown()
                }
            }
            server.start()
        }

        fun client(cache: String = ":memory:", logger: Logger = Logger.default()): ConfeatureClient =
            ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
                .baseUrl("http://127.0.0.1:${server.address.port}")
                .pollingMode(PollingMode.lazyLoad())
                .cacheDirectory(cache)
                .logger(logger)
                .build()

        override fun close() {
            firstRelease.countDown()
            server.stop(0)
            workers.shutdownNow()
        }
    }
}
