// SPDX-License-Identifier: MIT
package io.confeature.kmp

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * Every line a real logger could print for [throwable]: the message and `toString()` of the
 * throwable and of EVERY throwable reachable from it — causes, suppressed exceptions, their causes
 * and suppressed, at any depth — as `printStackTrace` would (#803 — a test logger that drops part
 * of the graph would let a `logger.error(msg, ex)` quoting the keyed URL pass a key-free
 * assertion). Cycle-safe: each throwable (by identity) is visited once; iterative, so a long chain
 * cannot overflow the stack.
 */
internal fun throwableLines(throwable: Throwable?): List<String> {
    val lines = mutableListOf<String>()
    val seen: MutableSet<Throwable> = Collections.newSetFromMap(IdentityHashMap())
    val pending = ArrayDeque<Throwable>()
    throwable?.let(pending::addLast)
    while (pending.isNotEmpty()) {
        val current = pending.removeFirst()
        if (!seen.add(current)) continue
        lines.add("THROWABLE message=${current.message}")
        lines.add("THROWABLE toString=$current")
        current.cause?.let(pending::addLast)
        current.suppressed.forEach(pending::addLast)
    }
    return lines
}

/**
 * The one test double for [Logger] (#803): records every line a real logger would print — the
 * level-prefixed message and, for [error], the whole throwable graph via [throwableLines] — so a
 * key-free assertion over [messages] also covers anything a throwable could carry.
 */
internal class CapturingLogger : Logger {
    val messages: MutableList<String> = CopyOnWriteArrayList()

    override fun error(message: String, throwable: Throwable?) {
        messages.add("ERROR $message")
        messages.addAll(throwableLines(throwable))
    }

    override fun warning(message: String) {
        messages.add("WARN $message")
    }

    override fun info(message: String) {
        messages.add("INFO $message")
    }

    override fun debug(message: String) {
        messages.add("DEBUG $message")
    }
}

/**
 * A raw TCP HTTP/1.1 listener on 127.0.0.1 that records each request line EXACTLY as the bytes
 * arrived (ISO-8859-1, nothing decoded or normalised), then answers with [response] and closes.
 *
 * #803 brief item 4: an HTTP client may re-encode a path, and a mock may decode it — so the path
 * the SDK sends is asserted on the wire, not on Ktor's `MockEngine` view of the URL it built.
 */
internal class RawHttpListener(private val response: String = okResponse("{\"f\":{}}")) : AutoCloseable {
    private val server = ServerSocket(0, BACKLOG, InetAddress.getLoopbackAddress())
    private val requestLines: MutableList<String> = CopyOnWriteArrayList()

    /** `http://127.0.0.1:<port>` — no trailing slash. */
    val baseUrl: String = "http://127.0.0.1:${server.localPort}"

    private val acceptor = thread(isDaemon = true, name = "raw-http-listener") {
        while (!server.isClosed) {
            val socket = try {
                server.accept()
            } catch (_: IOException) {
                break
            }
            socket.use { s ->
                val head = readHead(s.getInputStream())
                requestLines.add(head.substringBefore("\r\n"))
                s.getOutputStream().apply {
                    write(response.toByteArray(StandardCharsets.ISO_8859_1))
                    flush()
                }
            }
        }
    }

    /** The request-target of every request line received, verbatim. */
    val requestTargets: List<String>
        get() = requestLines.map { it.substringAfter(' ').substringBeforeLast(' ') }

    override fun close() {
        server.close()
        acceptor.join(JOIN_MS)
    }

    private fun readHead(input: InputStream): String {
        val out = ByteArrayOutputStream()
        var matched = 0
        while (matched < HEAD_END.size) {
            val b = input.read()
            if (b < 0) break
            out.write(b)
            matched = if (b.toByte() == HEAD_END[matched]) matched + 1 else if (b == '\r'.code) 1 else 0
        }
        return String(out.toByteArray(), StandardCharsets.ISO_8859_1)
    }

    companion object {
        private const val BACKLOG = 50
        private const val JOIN_MS = 1_000L
        private val HEAD_END = "\r\n\r\n".toByteArray(StandardCharsets.ISO_8859_1)

        fun okResponse(body: String): String {
            val bytes = body.toByteArray(StandardCharsets.UTF_8)
            return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n" +
                String(bytes, StandardCharsets.ISO_8859_1)
        }
    }
}
