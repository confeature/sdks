// SPDX-License-Identifier: MIT
package io.confeature.kmp

import platform.Foundation.NSDate
import platform.Foundation.timeIntervalSince1970

/** iOS epoch-seconds — `NSDate().timeIntervalSince1970`. */
internal actual fun currentEpochSeconds(): Long = NSDate().timeIntervalSince1970.toLong()

/** iOS wall-clock epoch-millis — `NSDate().timeIntervalSince1970 * 1000`. */
internal actual fun currentEpochMillis(): Long =
    (NSDate().timeIntervalSince1970 * 1000.0).toLong()
