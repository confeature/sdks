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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asContextElement
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
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
    fun anInvalidFlagEnvelopeLeavesTheLastUsableSnapshotIntact() = runBlocking {
        DelayedConfig(secondBody = """{"f":null}""").use { fixture ->
            val client = fixture.client()
            try {
                fixture.firstRelease.countDown()
                assertTrue(client.forceRefresh())
                assertFalse(client.forceRefresh())
                assertEquals(true, client.providerDetails().value)
                assertEquals(2, fixture.requests.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun fetchedStringsStayStringsAndQuotedIntegerConfigurationFailsClosed() = runBlocking {
        val body = """
            {"f": {
              "digits":{"t":1,"v":{"s":"00123"}},
              "word":{"t":1,"v":{"s":"true"}},
              "quoted-type":{"t":"2","v":{"i":20}},
              "quoted-value":{"t":2,"v":{"i":"20"}}
            }}
        """.trimIndent()
        DelayedConfig(firstBody = body).use { fixture ->
            val client = fixture.client()
            try {
                fixture.firstRelease.countDown()
                assertTrue(client.forceRefresh())
                assertEquals("00123", client.getValueDetails("digits", "").value)
                assertEquals("true", client.providerDetails("word", "", ProviderValueType.STRING).value)
                for (key in listOf("quoted-type", "quoted-value")) {
                    val outcome = client.providerDetails(key, Long.MAX_VALUE, ProviderValueType.INTEGER)
                    assertEquals(Status.PARSE_ERROR, outcome.status, key)
                    assertEquals(Long.MAX_VALUE, outcome.value, key)
                }
                assertEquals(1, fixture.requests.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun cancellingTheNativeWriterPreservesItsCallerContextAndLeavesReadyAvailable() = runBlocking {
        DelayedConfig().use { fixture ->
            val marker = ThreadLocal<String>()
            val started = CompletableDeferred<String?>()
            val counter = AtomicInteger()
            val cache = object : ConfigCache {
                override suspend fun read(cacheKey: String): String? = null

                override suspend fun write(cacheKey: String, value: String) {
                    if (counter.incrementAndGet() == 1) {
                        started.complete(marker.get())
                        awaitCancellation()
                    }
                }
            }
            val client = fixture.client(customCache = cache)
            val readyCalls = AtomicInteger()
            client.getHooks().addOnClientReady { readyCalls.incrementAndGet() }
            try {
                fixture.firstRelease.countDown()
                val first = async { withContext(marker.asContextElement("caller")) { client.forceRefresh() } }
                assertEquals("caller", withTimeout(5_000) { started.await() })
                first.cancelAndJoin()
                assertEquals(0, readyCalls.get())
                assertTrue(withTimeout(5_000) { client.forceRefresh() })
                assertEquals(2, counter.get())
                assertEquals(1, readyCalls.get())
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun providerCacheErrorsExposeOnlyFixedDiagnostics() = runBlocking {
        DelayedConfig().use { fixture ->
            val logger = CapturingLogger()
            val cache = object : ConfigCache {
                override suspend fun read(cacheKey: String): String? = null

                override suspend fun write(cacheKey: String, value: String) {
                    throw AssertionError("application cache sentinel")
                }
            }
            val client = fixture.client(logger = logger, customCache = cache)
            val ready = CountDownLatch(1)
            client.getHooks().addOnClientReady { ready.countDown() }
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                fixture.firstRelease.countDown()
                assertTrue(ready.await(5, TimeUnit.SECONDS))
                assertTrue(logger.messages.contains("ERROR ConfeatureClient: provider cache write failed."))
                assertTrue(logger.messages.none { it.contains("application cache sentinel") })
                assertEquals(true, client.providerDetails().value)
            } finally {
                client.close()
            }
        }
    }

    @Test
    fun pendingProviderCacheWriteKeepsItsDiagnosticsWhenRecoveringFromANativeWriterError() = runBlocking {
        DelayedConfig().use { fixture ->
            val firstWrite = CompletableDeferred<Unit>()
            val releaseFirstWrite = CompletableDeferred<Unit>()
            val providerChanged = CompletableDeferred<Unit>()
            val writes = AtomicInteger()
            val logger = CapturingLogger()
            val cache = object : ConfigCache {
                override suspend fun read(cacheKey: String): String? = null

                override suspend fun write(cacheKey: String, value: String) {
                    if (writes.incrementAndGet() == 1) {
                        firstWrite.complete(Unit)
                        releaseFirstWrite.await()
                        throw AssertionError("native cache sentinel")
                    }
                    throw AssertionError("pending provider cache sentinel")
                }
            }
            val client = fixture.client(
                logger = logger,
                customCache = cache,
                polling = PollingMode.lazyLoad(25.milliseconds),
            )
            client.getHooks().addOnConfigChanged { providerChanged.complete(Unit) }
            try {
                fixture.firstRelease.countDown()
                val native = async { runCatching { client.forceRefresh() }.exceptionOrNull() }
                withTimeout(5_000) { firstWrite.await() }
                delay(50)
                assertEquals(true, client.providerDetails().value)
                withTimeout(5_000) { providerChanged.await() }
                assertEquals(1, writes.get())
                releaseFirstWrite.complete(Unit)
                assertEquals("native cache sentinel", native.await()?.message)
                withTimeout(5_000) {
                    while ("ERROR ConfeatureClient: provider cache write failed." !in logger.messages) delay(10)
                }
                assertEquals(2, writes.get())
                assertTrue(logger.messages.none { it.contains("sentinel") })
            } finally {
                releaseFirstWrite.complete(Unit)
                client.close()
            }
        }
    }

    @Test
    fun closingFromTheProviderFailureDiagnosticPreventsTheErrorCallback() = runBlocking {
        DelayedConfig(firstStatus = 503).use { fixture ->
            lateinit var client: ConfeatureClient
            val closedFromLogger = CountDownLatch(1)
            val onError = CountDownLatch(1)
            val logger = object : Logger by Logger.default() {
                override fun error(message: String, throwable: Throwable?) {
                    if (message == "ConfeatureClient: provider config fetch failed.") {
                        client.close()
                        closedFromLogger.countDown()
                    }
                }
            }
            client = fixture.client(logger = logger)
            client.getHooks().addOnError { onError.countDown() }
            try {
                assertEquals(Status.NOT_READY, client.providerDetails().status)
                fixture.firstRelease.countDown()
                assertTrue(closedFromLogger.await(5, TimeUnit.SECONDS))
                assertFalse(onError.await(200, TimeUnit.MILLISECONDS))
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

    private fun ConfeatureClient.providerDetails(
        key: String = "flag",
        fallback: Any = false,
        type: ProviderValueType = ProviderValueType.BOOLEAN,
    ): ProviderResult = getValueDetailsForProvider(key, fallback, null, type)

    private class DelayedConfig(
        private val firstStatus: Int = 200,
        private val firstBody: String? = null,
        private val secondBody: String? = null,
    ) : AutoCloseable {
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
                    val customBody = when (index) {
                        1 -> firstBody
                        2 -> secondBody
                        else -> null
                    }
                    val body = (customBody ?: """{"f":{"flag":{"t":0,"v":{"b":${index == 1}}}}}""").encodeToByteArray()
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
