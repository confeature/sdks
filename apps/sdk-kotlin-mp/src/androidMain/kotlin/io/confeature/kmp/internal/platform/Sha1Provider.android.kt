// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import java.security.MessageDigest

/**
 * Android SHA-1 — `java.security.MessageDigest`, identical to the JVM impl. Android exposes the
 * same SHA-1 provider since API level 1; mirrors the [Sha256Provider] Android actual.
 */
public actual object Sha1Provider {
    public actual fun digest(input: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-1").digest(input)
}
