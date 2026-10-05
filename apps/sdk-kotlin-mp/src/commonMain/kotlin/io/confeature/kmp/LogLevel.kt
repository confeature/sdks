// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Logging verbosity selector. Matches ConfigCat's `LogLevel` 1:1 (constitution Principle II).
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
