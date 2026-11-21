// SPDX-License-Identifier: MIT
package io.confeature.kmp

import kotlin.js.Date

/** JS wall-clock epoch-millis — `Date.now()`. */
internal actual fun currentEpochMillis(): Long = Date.now().toLong()
