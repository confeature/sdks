// SPDX-License-Identifier: MIT
// MagicNumber suppression: every "magic" constant in this file is a verbatim
// reproduction of a FIPS 180-4 SHA-1 specification constant (round constants K[],
// initial hash values H[], rotation amounts, 64-byte block / 8-byte length-suffix
// conventions). Naming them adds no clarity over the standard's own notation;
// pinning the file-level suppression is the documented Kotlin convention for
// cryptographic implementations.
@file:Suppress("MagicNumber")

package io.confeature.kmp.internal.platform

/**
 * JS SHA-1 — a pure-JS port of FIPS 180-4 to keep the digest call synchronous (the engine
 * percentage bucketer, [io.confeature.kmp.internal.Hashing.percentageBucket], is NOT a `suspend`
 * function, mirroring the synchronous-by-design [Sha256Provider] JS actual; bridging
 * `crypto.subtle.digest`'s Promise would make the whole bucketing chain async and break parity).
 *
 * <p>The implementation is the standard 64-byte block schedule + 5 working variables. Output bytes
 * are byte-identical to:
 *
 * - JVM `MessageDigest.getInstance("SHA-1")`.
 * - iOS `CC_SHA1`.
 * - `node:crypto.createHash("sha1").digest()`.
 *
 * <p>Tested via the parity corpus on the JVM target (authoritative for parity); the JS variant
 * compiles in the `js(IR)` target and is exercised by `commonTest`.
 */
public actual object Sha1Provider {
    public actual fun digest(input: ByteArray): ByteArray {
        // Pad message: append 0x80, then zeros, then 8-byte big-endian length.
        val bitLen = input.size.toLong() * 8L
        val withOne = input.size + 1
        var paddedLen = withOne
        while ((paddedLen % 64) != 56) paddedLen++
        paddedLen += 8

        val padded = ByteArray(paddedLen)
        input.copyInto(padded)
        padded[input.size] = 0x80.toByte()
        for (i in 0 until 8) {
            padded[paddedLen - 1 - i] = ((bitLen shr (i * 8)) and 0xFFL).toByte()
        }

        var h0 = 0x67452301
        var h1 = -0x10325477 // 0xEFCDAB89
        var h2 = -0x67452302 // 0x98BADCFE
        var h3 = 0x10325476
        var h4 = -0x3c2d1e10 // 0xC3D2E1F0

        val w = IntArray(80)
        var off = 0
        while (off < paddedLen) {
            for (i in 0 until 16) {
                val b0 = (padded[off + i * 4].toInt() and 0xFF) shl 24
                val b1 = (padded[off + i * 4 + 1].toInt() and 0xFF) shl 16
                val b2 = (padded[off + i * 4 + 2].toInt() and 0xFF) shl 8
                val b3 = padded[off + i * 4 + 3].toInt() and 0xFF
                w[i] = b0 or b1 or b2 or b3
            }
            for (i in 16 until 80) {
                w[i] = rotl(w[i - 3] xor w[i - 8] xor w[i - 14] xor w[i - 16], 1)
            }

            var a = h0
            var b = h1
            var c = h2
            var d = h3
            var e = h4

            for (i in 0 until 80) {
                val f: Int
                val k: Int
                when {
                    i < 20 -> {
                        f = (b and c) or (b.inv() and d)
                        k = 0x5A827999
                    }
                    i < 40 -> {
                        f = b xor c xor d
                        k = 0x6ED9EBA1
                    }
                    i < 60 -> {
                        f = (b and c) or (b and d) or (c and d)
                        k = -0x70e44324 // 0x8F1BBCDC
                    }
                    else -> {
                        f = b xor c xor d
                        k = -0x359d3e2a // 0xCA62C1D6
                    }
                }
                val temp = rotl(a, 5) + f + e + k + w[i]
                e = d
                d = c
                c = rotl(b, 30)
                b = a
                a = temp
            }

            h0 += a
            h1 += b
            h2 += c
            h3 += d
            h4 += e
            off += 64
        }

        val out = ByteArray(20)
        val hs = intArrayOf(h0, h1, h2, h3, h4)
        for (i in 0 until 5) {
            val v = hs[i]
            out[i * 4] = ((v ushr 24) and 0xFF).toByte()
            out[i * 4 + 1] = ((v ushr 16) and 0xFF).toByte()
            out[i * 4 + 2] = ((v ushr 8) and 0xFF).toByte()
            out[i * 4 + 3] = (v and 0xFF).toByte()
        }
        return out
    }

    private fun rotl(x: Int, n: Int): Int = (x shl n) or (x ushr (32 - n))
}
