// SPDX-License-Identifier: MIT
package io.confeature.kmp

/** JVM epoch-seconds — `System.currentTimeMillis()` / 1000. */
internal actual fun currentEpochSeconds(): Long = System.currentTimeMillis() / 1000L

/** JVM wall-clock epoch-millis — `System.currentTimeMillis()`. */
internal actual fun currentEpochMillis(): Long = System.currentTimeMillis()
