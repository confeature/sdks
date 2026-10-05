// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import java.security.MessageDigest

/**
 * Android SHA-256 — `java.security.MessageDigest`, identical to the JVM impl. Android exposes the
 * same SHA-256 provider since API level 1; the JVM and Android source sets diverge only on the
 * HTTP engine (CIO vs OkHttp) and the filesystem-cache default path.
 */
public actual object Sha256Provider {
    public actual fun digest(input: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(input)
}
