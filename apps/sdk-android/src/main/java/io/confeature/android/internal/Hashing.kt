// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * The two hashes the ConfigCat decision engine needs (ported from
 * `packages/sdk-shared/src/hash.ts`, the spec-117 reference; transliterated from the Java port
 * `io.confeature.client.internal.Hashing`):
 *
 * - **SHA-1, UNSALTED** for percentage bucketing — `parseInt(sha1(key + attr).substring(0,7), 16)
 *   % 100`.
 * - **SHA-256, SALTED** for sensitive comparators — `sha256(utf8(value) + utf8(configSalt) +
 *   utf8(contextSalt))`.
 *
 * Both use [MessageDigest] (JDK stdlib — no new dependency). [MessageDigest] is not thread-safe, so
 * a fresh instance is obtained per call. Output is lowercase hex, byte-identical to the TS reference
 * (and therefore to every other federated SDK).
 */
internal object Hashing {
    private val HEX = "0123456789abcdef".toCharArray()

    /** Lowercase-hex-encode a byte array. */
    fun toHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val b = bytes[i].toInt() and 0xff
            out[i * 2] = HEX[b ushr 4]
            out[i * 2 + 1] = HEX[b and 0x0f]
        }
        return String(out)
    }

    /** SHA-1 digest of [input] (UTF-8) as a 40-char lowercase hex string. */
    fun sha1(input: String): String = digest("SHA-1", input.toByteArray(StandardCharsets.UTF_8))

    /** SHA-256 digest of [input] (UTF-8) as a 64-char lowercase hex string. */
    fun sha256(input: String): String = digest("SHA-256", input.toByteArray(StandardCharsets.UTF_8))

    /** SHA-256 digest of raw [bytes] as a 64-char lowercase hex string. */
    fun sha256Bytes(bytes: ByteArray): String = digest("SHA-256", bytes)

    private fun digest(algorithm: String, bytes: ByteArray): String {
        // SHA-1 / SHA-256 are mandated by every JVM; getInstance never throws here.
        val md = MessageDigest.getInstance(algorithm)
        return toHex(md.digest(bytes))
    }

    /**
     * Hash a user-attribute value for a **sensitive** comparator. Mirrors common-js
     * `hashComparisonValue`: `sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))`, no
     * separators, lowercase hex.
     *
     * @param value the user attribute value as text (after attribute conversion).
     * @param configSalt the top-level config salt (`config.p.s`).
     * @param contextSalt the per-evaluation discriminator — the setting key for a user condition, or
     *     the segment name for a segment condition.
     */
    fun hashComparisonValue(value: String, configSalt: String, contextSalt: String): String =
        sha256(value + configSalt + contextSalt)

    /**
     * Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator (common-js
     * `hashComparisonValueSlice`): `sha256(sliceBytes ++ utf8(configSalt) ++ utf8(contextSalt))`.
     * The slice is raw bytes (a byte-boundary cut of the attribute, which may land mid-codepoint),
     * so the hash runs over the concatenated byte sequence.
     */
    fun hashComparisonValueSlice(
        sliceUtf8: ByteArray,
        configSalt: String,
        contextSalt: String,
    ): String {
        val saltBytes = configSalt.toByteArray(StandardCharsets.UTF_8)
        val ctxBytes = contextSalt.toByteArray(StandardCharsets.UTF_8)
        val buf = ByteArray(sliceUtf8.size + saltBytes.size + ctxBytes.size)
        System.arraycopy(sliceUtf8, 0, buf, 0, sliceUtf8.size)
        System.arraycopy(saltBytes, 0, buf, sliceUtf8.size, saltBytes.size)
        System.arraycopy(ctxBytes, 0, buf, sliceUtf8.size + saltBytes.size, ctxBytes.size)
        return sha256Bytes(buf)
    }

    /**
     * ConfigCat percentage bucket in `[0, 99]` for `key + attrValue` (common-js
     * `evaluatePercentageOptions`): `parseInt(sha1(key + attrValue).substring(0,7), 16) % 100`.
     * SHA-1, unsalted. 7 hex chars = 28 bits, well within a 64-bit parse.
     */
    fun percentageBucket(key: String, attrValue: String): Int {
        val hex = sha1(key + attrValue).substring(0, 7)
        return (hex.toLong(16) % 100L).toInt()
    }
}
