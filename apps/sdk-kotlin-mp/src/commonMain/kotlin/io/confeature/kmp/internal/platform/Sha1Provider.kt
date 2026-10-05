// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

/**
 * Multiplatform SHA-1 abstraction (the parity engine's percentage bucketer). Each target provides
 * an `actual` implementation, mirroring [Sha256Provider]:
 *
 * - JVM / Android: `java.security.MessageDigest.getInstance("SHA-1")`.
 * - iOS / macOS: `CC_SHA1` via `kotlinx.cinterop` (CommonCrypto).
 * - JS: a pure-JS FIPS 180-4 SHA-1 (synchronous — the engine bucketer is NOT a `suspend` call).
 *
 * <p>All implementations MUST return the canonical 20-byte SHA-1 digest of [input]. The common-code
 * consumer ([io.confeature.kmp.internal.Hashing.percentageBucket]) lowercase-hex-encodes the digest,
 * takes the first 7 hex chars and computes `% 100` — byte-identical to the TS / Python / Go / .NET /
 * Rust / Ruby / PHP / Java / Swift / Android ports.
 *
 * <p>Implemented as an `expect object` so the consumer can call `Sha1Provider.digest(...)` in common
 * code without injecting an instance.
 */
public expect object Sha1Provider {
    public fun digest(input: ByteArray): ByteArray
}
