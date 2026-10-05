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
import platform.CoreCrypto.CC_SHA1
import platform.CoreCrypto.CC_SHA1_DIGEST_LENGTH

/**
 * iOS SHA-1 — CommonCrypto's `CC_SHA1` via kotlinx.cinterop. Available on every iOS / macOS /
 * watchOS / tvOS runtime; same byte output as the JVM `MessageDigest.getInstance("SHA-1")`.
 * Mirrors the [Sha256Provider] iOS actual.
 *
 * <p>Compiles only on macOS hosts (the Kotlin/Native iOS toolchain requires Xcode). The build
 * guards the entire iOS source set behind `HostManager.hostIsMac` in `build.gradle.kts`.
 */
public actual object Sha1Provider {
    public actual fun digest(input: ByteArray): ByteArray {
        // `input.refTo(0)` pins index 0; on a zero-length array that pin is dangling (UB). Guard
        // it: CC_SHA1 over the empty input has a well-known constant digest, so we compute it over
        // a 1-byte scratch buffer with length 0 instead of pinning the empty array (spec-129
        // review — the `digest` contract carries no non-empty precondition).
        if (input.isEmpty()) {
            return memScoped {
                val digestLen = CC_SHA1_DIGEST_LENGTH
                val digestBuffer: CPointer<ByteVar> = allocArray(digestLen)
                val scratch = ByteArray(1)
                CC_SHA1(scratch.refTo(0), 0.convert(), digestBuffer.reinterpret())
                digestBuffer.readBytes(digestLen)
            }
        }
        return memScoped {
            val digestLen = CC_SHA1_DIGEST_LENGTH
            val digestBuffer: CPointer<ByteVar> = allocArray(digestLen)
            // `input.size.convert()` widens Int to the CC_LONG / size_t-equivalent
            // platform.posix.size_t typedef without losing the value.
            CC_SHA1(input.refTo(0), input.size.convert(), digestBuffer.reinterpret())
            digestBuffer.readBytes(digestLen)
        }
    }
}

// kotlinx.cinterop's `reinterpret` is generic; the import keeps the
// extension function in scope without polluting consumers.
@Suppress("UnusedPrivateMember")
private fun <T : kotlinx.cinterop.CPointed> CPointer<*>.reinterpret(): CPointer<T> =
    @Suppress("UNCHECKED_CAST")
    (this as CPointer<T>)
