// SPDX-License-Identifier: MIT
package io.confeature.kmp

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Self-test of the #803 test-logger helpers: a key-free assertion is only as strong as what the
 * test logger records, so [throwableLines] must reach every throwable a real logger would print.
 */
class WireTestSupportTest {

    /** A secret buried as a suppressed exception of a suppressed exception of a cause is recorded. */
    @Test
    fun throwableLines_walksSuppressedAndCausesAtAnyDepth() {
        val deepest = IllegalStateException("deep-secret-message")
        val innerSuppressed = RuntimeException("inner-suppressed").apply { addSuppressed(deepest) }
        val cause = RuntimeException("cause").apply { addSuppressed(innerSuppressed) }
        val suppressedCause = RuntimeException("suppressed-cause-secret")
        val top = RuntimeException("top", cause).apply {
            addSuppressed(RuntimeException("top-suppressed", suppressedCause))
        }

        val lines = throwableLines(top)

        val markers = listOf("top", "cause", "inner-suppressed", "deep-secret-message", "suppressed-cause-secret")
        for (marker in markers) {
            assertTrue(lines.any { it == "THROWABLE message=$marker" }, "message of $marker missing: $lines")
            assertTrue(
                lines.any { it.startsWith("THROWABLE toString=") && it.endsWith(": $marker") },
                "toString of $marker missing: $lines",
            )
        }
    }

    /** Cause and suppressed cycles terminate, and each throwable is recorded exactly once. */
    @Test
    fun throwableLines_isCycleSafe() {
        val a = RuntimeException("a")
        val b = RuntimeException("b")
        val c = RuntimeException("c")
        a.initCause(b)
        b.initCause(a)
        a.addSuppressed(c)
        c.addSuppressed(a)
        c.addSuppressed(b)

        val lines = throwableLines(a)

        val messages = lines.filter { it.startsWith("THROWABLE message=") }.map { it.substringAfter('=') }
        assertEquals(listOf("a", "b", "c"), messages.sorted())
        assertEquals(6, lines.size, "two lines per distinct throwable: $lines")
    }

    @Test
    fun throwableLines_nullIsEmpty() {
        assertTrue(throwableLines(null).isEmpty())
    }

    /** The shared [CapturingLogger] records the level, the message and the whole throwable graph. */
    @Test
    fun capturingLogger_recordsEveryLevelAndTheThrowableGraph() {
        val logger = CapturingLogger()
        val nested = RuntimeException("outer").apply {
            addSuppressed(RuntimeException("mid").apply { addSuppressed(Error("graph-secret")) })
        }
        logger.error("e", nested)
        logger.warning("w")
        logger.info("i")
        logger.debug("d")

        assertEquals(
            listOf("ERROR e", "WARN w", "INFO i", "DEBUG d"),
            logger.messages.filterNot { it.startsWith("THROWABLE") },
        )
        assertTrue(logger.messages.any { it.contains("graph-secret") }, "${logger.messages}")
    }
}
