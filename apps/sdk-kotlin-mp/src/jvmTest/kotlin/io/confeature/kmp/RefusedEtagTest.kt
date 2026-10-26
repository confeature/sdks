// SPDX-License-Identifier: MIT
package io.confeature.kmp

import com.sun.net.httpserver.HttpServer
import io.confeature.kmp.internal.ConfigFetcher
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.cio.CIO
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #840 — a stored ETag the HTTP engine refuses as a header value (a non-ASCII byte, which a
 * cache written elsewhere can hold) must not fail every later fetch. sdk-java and sdk-android
 * drop it, fetch without `If-None-Match`, and heal when the next 200 replaces it (#803).
 *
 * Run against a real loopback server on both engines this SDK ships for the JVM: CIO (jvmMain)
 * and OkHttp (androidMain), because MockEngine validates no header.
 */
class RefusedEtagTest {
    private lateinit var server: HttpServer
    private val ifNoneMatch = CopyOnWriteArrayList<String>()

    @BeforeEach
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val sent = exchange.requestHeaders.getFirst("If-None-Match")
            ifNoneMatch.add(sent ?: "")
            if (sent == "\"v2\"") {
                exchange.responseHeaders.add("ETag", "\"v2\"")
                exchange.sendResponseHeaders(304, -1)
            } else {
                val body = """{"f":{}}""".toByteArray()
                exchange.responseHeaders.add("ETag", "\"v2\"")
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            exchange.close()
        }
        server.start()
    }

    @AfterEach
    fun stop() = server.stop(0)

    private fun fetcher(engine: HttpClientEngineFactory<*>, logger: Logger) = ConfigFetcher(
        baseUrl = "http://127.0.0.1:${server.address.port}",
        sdkKey = KEY,
        timeoutMillis = 5_000,
        logger = logger,
        httpClientFactory = { HttpClient(engine) },
    )

    private fun assertHeals(engine: HttpClientEngineFactory<*>) = runBlocking {
        val lines = CopyOnWriteArrayList<String>()
        val logger = object : Logger {
            override fun error(message: String, throwable: Throwable?) {
                lines.add(message + (throwable?.message ?: ""))
            }
            override fun warning(message: String) { lines.add(message) }
            override fun info(message: String) { lines.add(message) }
            override fun debug(message: String) { lines.add(message) }
        }
        val f = fetcher(engine, logger)
        val first = f.fetch(REFUSED_ETAG)
        assertEquals(ConfigFetcher.Status.FETCHED, first.status, "a refused ETag is dropped")
        assertEquals("\"v2\"", first.etag)
        val second = f.fetch(first.etag)
        assertEquals(ConfigFetcher.Status.NOT_MODIFIED, second.status, "the next ETag heals it")
        assertEquals(listOf("", "\"v2\""), ifNoneMatch.toList())
        assertTrue(lines.none { REFUSED_ETAG in it || "é" in it }, "the raw ETag is never logged")
    }

    @Test
    fun cioDropsARefusedStoredEtagAndHeals() = assertHeals(CIO)

    @Test
    fun okHttpDropsARefusedStoredEtagAndHeals() = assertHeals(OkHttp)

    private companion object {
        const val KEY = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"
        const val REFUSED_ETAG = "\"v1-é\""
    }
}
