// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Minimal logging surface. Customers can swap in their own implementation via
 * `ConfeatureClient.Builder#logger(Logger)`.
 *
 * <p>Mirrors ConfigCat's Kotlin SDK `ConfeatureLogger`-style surface; names match
 * `error / warning / info / debug` exactly so a customer porting from ConfigCat can drop their
 * existing logger in unchanged.
 *
 * <p>The default implementation [PrintlnLogger] routes to `println` and is appropriate for
 * development; customers ship their own logger in production. Per-platform default loggers (e.g.
 * SLF4J on JVM, NSLog on iOS) MAY be installed via `expect/actual` in a follow-up.
 */
public interface Logger {
    /** Logs an error. `throwable` may be null. */
    public fun error(message: String, throwable: Throwable? = null)

    /** Logs a warning. */
    public fun warning(message: String)

    /** Logs an informational message. */
    public fun info(message: String)

    /** Logs a debug message. */
    public fun debug(message: String)

    public companion object {
        /** Returns the SDK's default `println`-backed logger. */
        public fun default(): Logger = PrintlnLogger
    }
}

/**
 * Multiplatform default — writes to `println`. Replaced at runtime by any customer-supplied
 * [Logger]. Marked `internal` so it's not part of the public API surface but reachable via
 * [Logger.default].
 */
internal object PrintlnLogger : Logger {
    override fun error(message: String, throwable: Throwable?) {
        if (throwable == null) {
            println("[confeature][ERROR] $message")
        } else {
            println("[confeature][ERROR] $message — ${throwable.message}")
        }
    }

    override fun warning(message: String) {
        println("[confeature][WARN] $message")
    }

    override fun info(message: String) {
        println("[confeature][INFO] $message")
    }

    override fun debug(message: String) {
        println("[confeature][DEBUG] $message")
    }
}
