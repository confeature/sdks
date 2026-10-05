// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Logging verbosity selector. Matches ConfigCat's Android SDK `com.configcat.LogLevel` 1:1
 * (constitution Principle II).
 *
 * Mapped onto `android.util.Log` priorities by the bundled default [Logger] implementation.
 */
public enum class LogLevel {
    /** No logging. */
    OFF,

    /** Error-level only. */
    ERROR,

    /** Warning + error. */
    WARNING,

    /** Info + warning + error. */
    INFO,

    /** Debug + info + warning + error (everything). */
    DEBUG,
}
