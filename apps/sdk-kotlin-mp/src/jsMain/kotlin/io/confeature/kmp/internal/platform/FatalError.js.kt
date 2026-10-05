// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/** JS: every `Error` the engine raises (e.g. a failed `fetch`'s `TypeError`) is recoverable. */
internal actual fun isFatalError(error: Throwable): Boolean = false
