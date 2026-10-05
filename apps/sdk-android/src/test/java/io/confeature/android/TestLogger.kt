// SPDX-License-Identifier: MIT
package io.confeature.android

import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * In-memory [Logger] used to assert log content + redaction in tests.
 *
 * It records everything a real logger would print (#803): an [error] entry carries the message
 * AND the throwable's whole chain — each throwable's `toString()` (class + message), its cause
 * chain and its suppressed exceptions — so a key-free assertion over [allMessages] also covers a
 * library exception handed to the logger. [throwables] exposes the raw throwables passed in.
 */
public class TestLogger : Logger {
    private val messages = CopyOnWriteArrayList<String>()
    private val throwables = CopyOnWriteArrayList<Throwable>()

    override fun error(message: String, throwable: Throwable?) {
        if (throwable == null) {
            messages.add("ERROR: $message")
            return
        }
        throwables.add(throwable)
        messages.add("ERROR: $message\n" + describeChain(throwable))
    }

    override fun warning(message: String) {
        messages.add("WARN: $message")
    }

    override fun info(message: String) {
        messages.add("INFO: $message")
    }

    override fun debug(message: String) {
        messages.add("DEBUG: $message")
    }

    /** Every entry; an error's entry includes its throwable chain (see [describeChain]). */
    public fun allMessages(): List<String> = messages.toList()

    /** The throwables passed to [error], in order (non-null only). */
    public fun throwables(): List<Throwable> = throwables.toList()

    private companion object {
        /**
         * One line per throwable reachable from [root] through `cause` and `suppressed`, each
         * the throwable's `toString()` plus its raw `message` (a subclass may override
         * `toString()` and hide it). Cycles are cut by identity.
         */
        fun describeChain(root: Throwable): String {
            val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
            val lines = ArrayList<String>()
            val pending = ArrayDeque<Pair<String, Throwable>>()
            pending.addLast("throwable" to root)
            while (pending.isNotEmpty()) {
                val (label, t) = pending.removeFirst()
                if (!seen.add(t)) continue
                lines.add("  $label: $t | message=${t.message} | localized=${t.localizedMessage}")
                t.cause?.let { pending.addLast("caused by" to it) }
                for (s in t.suppressed) pending.addLast("suppressed" to s)
            }
            return lines.joinToString("\n")
        }
    }
}
