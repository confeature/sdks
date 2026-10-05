// SPDX-License-Identifier: MIT
package io.confeature.android

import android.util.Log

/**
 * Minimal logging surface. Customers can swap in their own implementation via
 * [ConfeatureClient.Builder.logger] — the default implementation delegates to `android.util.Log`
 * under the tag `"Confeature"`.
 *
 * Mirrors ConfigCat's Android SDK `com.configcat.ConfigCatLogger`-style surface; method names match
 * `error / warning / info / debug` exactly so a customer porting from ConfigCat can drop their
 * existing logger in unchanged.
 */
public interface Logger {
    /** Logs an error. [throwable] may be null. */
    public fun error(message: String, throwable: Throwable?)

    /** Logs a warning. */
    public fun warning(message: String)

    /** Logs an informational message. */
    public fun info(message: String)

    /** Logs a debug message. */
    public fun debug(message: String)

    public companion object {
        private const val TAG = "Confeature"

        /**
         * Returns the SDK's default `android.util.Log`-backed logger. Levels are honoured per the
         * platform's runtime configuration; the public [LogLevel] enum filter is applied at the
         * call site by the SDK internals.
         */
        @JvmStatic
        public fun defaultLogger(): Logger = AndroidLogLogger
    }

    /** `android.util.Log`-backed default. Visible for tests. */
    public object AndroidLogLogger : Logger {
        override fun error(message: String, throwable: Throwable?) {
            if (throwable == null) {
                Log.e(TAG, message)
            } else {
                Log.e(TAG, message, throwable)
            }
        }

        override fun warning(message: String) {
            Log.w(TAG, message)
        }

        override fun info(message: String) {
            Log.i(TAG, message)
        }

        override fun debug(message: String) {
            Log.d(TAG, message)
        }
    }
}
