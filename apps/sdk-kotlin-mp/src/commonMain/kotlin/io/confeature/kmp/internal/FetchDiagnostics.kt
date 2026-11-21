// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.Logger

/** Records diagnostics from one serialized HTTP attempt for playback outside the refresh mutex. */
internal class FetchDiagnostics : Logger {
    private val messages = mutableListOf<(Logger) -> Unit>()

    override fun error(message: String, throwable: Throwable?) {
        messages.add { it.error(message, throwable) }
    }

    override fun warning(message: String) {
        messages.add { it.warning(message) }
    }

    override fun info(message: String) {
        messages.add { it.info(message) }
    }

    override fun debug(message: String) {
        messages.add { it.debug(message) }
    }

    fun replay(logger: Logger) {
        for (message in messages) message(logger)
    }
}
