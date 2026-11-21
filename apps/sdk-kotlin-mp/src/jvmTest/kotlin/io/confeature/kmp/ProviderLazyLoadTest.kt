// SPDX-License-Identifier: MIT
package io.confeature.kmp

import com.sun.net.httpserver.HttpServer
import io.confeature.kmp.internal.ProviderResult.Status
import io.confeature.kmp.internal.ProviderValueType
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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
        val requests = AtomicInteger()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            requests.incrementAndGet()
            entered.countDown()
            try {
                check(release.await(5, TimeUnit.SECONDS))
                val body = """{"f":{"flag":{"t":0,"v":{"b":true}}}}""".encodeToByteArray()
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            } finally {
                exchange.close()
            }
        }
        server.start()
        val client = ConfeatureClient.builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
            .baseUrl("http://127.0.0.1:${server.address.port}")
            .pollingMode(PollingMode.lazyLoad())
            .cacheDirectory(":memory:")
            .build()
        try {
            client.setOffline()
            assertEquals(Status.NOT_READY, client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN).status)
            assertFalse(entered.await(100, TimeUnit.MILLISECONDS))
            client.setOnline()
            val cold = client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN)
            assertEquals(Status.NOT_READY, cold.status)
            assertEquals(false, cold.value)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            repeat(16) {
                assertEquals(Status.NOT_READY, client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN).status)
            }
            release.countDown()
            withTimeout(5_000) {
                while (client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN).value != true) {
                    delay(10)
                }
            }
            assertEquals(1, requests.get())
            client.setOffline()
            assertEquals(true, client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN).value)
            assertEquals(1, requests.get())
            client.close()
            assertEquals(Status.NOT_READY, client.getValueDetailsForProvider("flag", false, null, ProviderValueType.BOOLEAN).status)
        } finally {
            release.countDown()
            client.close()
            server.stop(0)
        }
    }
}
