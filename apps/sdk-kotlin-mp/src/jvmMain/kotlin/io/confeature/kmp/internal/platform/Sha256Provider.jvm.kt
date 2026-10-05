// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import java.security.MessageDigest

/**
 * JVM SHA-256 — `java.security.MessageDigest`. Available since JDK 1.4 on every standards-
 * compliant JRE; the only way SHA-256 is missing is a deliberately stripped-down JVM, which the
 * SDK does not support.
 */
public actual object Sha256Provider {
    public actual fun digest(input: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(input)
}
