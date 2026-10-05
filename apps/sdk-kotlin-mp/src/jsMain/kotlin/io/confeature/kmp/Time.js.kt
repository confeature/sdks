// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlin.js.Date

/** JS epoch-seconds — `Date.now()` / 1000. */
internal actual fun currentEpochSeconds(): Long = (Date.now() / 1000.0).toLong()

/** JS wall-clock epoch-millis — `Date.now()`. */
internal actual fun currentEpochMillis(): Long = Date.now().toLong()
