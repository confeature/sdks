// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/**
 * Multiplatform SHA-256 abstraction. Each target provides an `actual` implementation:
 *
 * - JVM / Android: `java.security.MessageDigest.getInstance("SHA-256")`.
 * - iOS / macOS: `CC_SHA256` via `kotlinx.cinterop` (CommonCrypto).
 * - JS: `crypto.subtle.digest` (browser SubtleCrypto) — Node provides the same shim via the
 *   global `crypto` from Node 20+.
 *
 * <p>All implementations MUST return the canonical 32-byte SHA-256 digest of [input]. The
 * common-code consumer ([io.confeature.kmp.internal.SdkKey.deriveCacheKey]) then base64url-encodes
 * the digest and slices the first 32 characters — byte-identical to the TS / Python / Go / .NET /
 * Rust / Ruby / PHP / Java / Swift / Android ports.
 *
 * <p>Implemented as an `expect object` so the consumer can call `Sha256Provider.digest(...)` in
 * common code without injecting an instance.
 */
public expect object Sha256Provider {
    public fun digest(input: ByteArray): ByteArray
}
