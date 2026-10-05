// SPDX-License-Identifier: MIT
@file:OptIn(ExperimentalForeignApi::class)

package io.confeature.kmp.internal.platform

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.refTo
import platform.CoreCrypto.CC_SHA256
import platform.CoreCrypto.CC_SHA256_DIGEST_LENGTH

/**
 * iOS SHA-256 — CommonCrypto's `CC_SHA256` via kotlinx.cinterop. Available on every iOS / macOS
 * / watchOS / tvOS runtime; same byte output as the JVM `MessageDigest.getInstance("SHA-256")`.
 *
 * <p>Compiles only on macOS hosts (the Kotlin/Native iOS toolchain requires Xcode). The build
 * guards the entire iOS source set behind `HostManager.hostIsMac` in `build.gradle.kts`.
 */
public actual object Sha256Provider {
    public actual fun digest(input: ByteArray): ByteArray = memScoped {
        val digestLen = CC_SHA256_DIGEST_LENGTH
        val digestBuffer: CPointer<ByteVar> = allocArray(digestLen)
        // `input.size.convert()` widens Int to the CC_LONG / size_t-equivalent
        // platform.posix.size_t typedef without losing the value.
        CC_SHA256(input.refTo(0), input.size.convert(), digestBuffer.reinterpret())
        digestBuffer.readBytes(digestLen)
    }
}

// kotlinx.cinterop's `reinterpret` is generic; the import keeps the
// extension function in scope without polluting consumers.
@Suppress("UnusedPrivateMember")
private fun <T : kotlinx.cinterop.CPointed> CPointer<*>.reinterpret(): CPointer<T> =
    @Suppress("UNCHECKED_CAST")
    (this as CPointer<T>)
