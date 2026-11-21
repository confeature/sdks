// SPDX-License-Identifier: MIT
package io.confeature.kmp

/** JVM wall-clock epoch-millis — `System.currentTimeMillis()`. */
internal actual fun currentEpochMillis(): Long = System.currentTimeMillis()
