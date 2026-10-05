// SPDX-License-Identifier: MIT
package io.confeature.kmp

/** Android epoch-seconds — `System.currentTimeMillis()` / 1000. */
internal actual fun currentEpochSeconds(): Long = System.currentTimeMillis() / 1000L

/** Android wall-clock epoch-millis — `System.currentTimeMillis()`. */
internal actual fun currentEpochMillis(): Long = System.currentTimeMillis()
