// SPDX-License-Identifier: MIT
// MagicNumber suppression: every "magic" constant in this file is a verbatim
// reproduction of a FIPS 180-4 SHA-256 specification constant (round
// constants K[], initial hash values H[], rotation / shift amounts, 64-byte
// block / 8-byte length-suffix conventions). Naming them adds no clarity
// over the standard's own notation; pinning the file-level suppression is
// the documented Kotlin convention for cryptographic implementations.
@file:Suppress("MagicNumber")

package io.confeature.kmp.internal.platform

import org.khronos.webgl.Int8Array
import org.khronos.webgl.Uint8Array

/**
 * JS SHA-256 — implemented as a pure-JS port of FIPS 180-4 to keep the digest call synchronous
 * (the common-side [io.confeature.kmp.internal.SdkKey.deriveCacheKey] is NOT a `suspend` function
 * and there's no clean way to bridge `crypto.subtle.digest`'s Promise without making the entire
 * cache-key chain async — which would break parity with the JVM / Native ports).
 *
 * <p>The implementation is the standard 64-byte block schedule + 8 working variables. Output
 * bytes are byte-identical to:
 *
 * - JVM `MessageDigest.getInstance("SHA-256")`.
 * - iOS `CC_SHA256`.
 * - `node:crypto.createHash("sha256").digest()`.
 *
 * <p>Tested via `CacheKeyFixturesTest` on the JVM target (authoritative for parity) — the JS
 * variant runs in `commonTest` on `jsTest`, which exercises the same fixture set.
 */
public actual object Sha256Provider {
    private val K = intArrayOf(
        0x428a2f98.toInt(), 0x71374491.toInt(), -0x4a3f0431, -0x164a245b,
        0x3956c25b, 0x59f111f1, -0x6dc07d5c, -0x54e3a12b,
        -0x27f85568, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, -0x7f214e02, -0x6423f959, -0x3e640e8c,
        -0x1b64963f, -0x1041b87a, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        -0x67c1aeae, -0x57ce3993, -0x4ffcd838, -0x40a68039,
        -0x391ff40d, -0x2a586eb9, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, -0x7e3d36d2, -0x6d8dd37b,
        -0x5d40175f, -0x57e599b5, -0x3db47490, -0x3893ae5d,
        -0x2e6d17e7, -0x2966f9dc, -0xbf1ca7b, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, -0x7b3787ec, -0x7338fdf8,
        -0x6f410006, -0x5baf9315, -0x41065c09, -0x398e870e,
    )

    public actual fun digest(input: ByteArray): ByteArray {
        // Pad message: append 0x80, then zeros, then 8-byte big-endian length.
        val bitLen = input.size.toLong() * 8L
        val withOne = input.size + 1
        // Pad to a multiple of 64 bytes, leaving room for the 8-byte length.
        var paddedLen = withOne
        while ((paddedLen % 64) != 56) paddedLen++
        paddedLen += 8

        val padded = ByteArray(paddedLen)
        input.copyInto(padded)
        padded[input.size] = 0x80.toByte()
        // Encode bit length as big-endian 64-bit at the tail.
        for (i in 0 until 8) {
            padded[paddedLen - 1 - i] = ((bitLen shr (i * 8)) and 0xFFL).toByte()
        }

        val h = intArrayOf(
            0x6a09e667, -0x4498517b, 0x3c6ef372, -0x5ab00ac6,
            0x510e527f, -0x64fa9774, 0x1f83d9ab, 0x5be0cd19,
        )

        val w = IntArray(64)
        var off = 0
        while (off < paddedLen) {
            for (i in 0 until 16) {
                val b0 = (padded[off + i * 4].toInt() and 0xFF) shl 24
                val b1 = (padded[off + i * 4 + 1].toInt() and 0xFF) shl 16
                val b2 = (padded[off + i * 4 + 2].toInt() and 0xFF) shl 8
                val b3 = padded[off + i * 4 + 3].toInt() and 0xFF
                w[i] = b0 or b1 or b2 or b3
            }
            for (i in 16 until 64) {
                val s0 = rotr(w[i - 15], 7) xor rotr(w[i - 15], 18) xor (w[i - 15] ushr 3)
                val s1 = rotr(w[i - 2], 17) xor rotr(w[i - 2], 19) xor (w[i - 2] ushr 10)
                w[i] = w[i - 16] + s0 + w[i - 7] + s1
            }

            var a = h[0]; var b = h[1]; var c = h[2]; var d = h[3]
            var e = h[4]; var f = h[5]; var g = h[6]; var hh = h[7]

            for (i in 0 until 64) {
                val s1 = rotr(e, 6) xor rotr(e, 11) xor rotr(e, 25)
                val ch = (e and f) xor (e.inv() and g)
                val temp1 = hh + s1 + ch + K[i] + w[i]
                val s0 = rotr(a, 2) xor rotr(a, 13) xor rotr(a, 22)
                val maj = (a and b) xor (a and c) xor (b and c)
                val temp2 = s0 + maj
                hh = g; g = f; f = e; e = d + temp1
                d = c; c = b; b = a; a = temp1 + temp2
            }

            h[0] = h[0] + a; h[1] = h[1] + b; h[2] = h[2] + c; h[3] = h[3] + d
            h[4] = h[4] + e; h[5] = h[5] + f; h[6] = h[6] + g; h[7] = h[7] + hh

            off += 64
        }

        val out = ByteArray(32)
        for (i in 0 until 8) {
            val v = h[i]
            out[i * 4] = ((v ushr 24) and 0xFF).toByte()
            out[i * 4 + 1] = ((v ushr 16) and 0xFF).toByte()
            out[i * 4 + 2] = ((v ushr 8) and 0xFF).toByte()
            out[i * 4 + 3] = (v and 0xFF).toByte()
        }
        // Suppress unused-import warnings for the WebGL typed arrays — kept
        // available for a future SubtleCrypto-backed async path.
        @Suppress("UNUSED_VARIABLE")
        val unused: Int8Array? = null
        @Suppress("UNUSED_VARIABLE")
        val unused2: Uint8Array? = null
        return out
    }

    private fun rotr(x: Int, n: Int): Int = (x ushr n) or (x shl (32 - n))
}
