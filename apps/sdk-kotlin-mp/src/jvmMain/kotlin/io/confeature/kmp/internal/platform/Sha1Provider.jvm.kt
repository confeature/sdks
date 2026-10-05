// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import java.security.MessageDigest

/**
 * JVM SHA-1 — `java.security.MessageDigest`. Mandated by every standards-compliant JRE; mirrors
 * the [Sha256Provider] JVM actual.
 */
public actual object Sha1Provider {
    public actual fun digest(input: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-1").digest(input)
}
