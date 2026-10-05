// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/** Kotlin/Native terminates the process on its fatal conditions instead of throwing them. */
internal actual fun isFatalError(error: Throwable): Boolean = false
