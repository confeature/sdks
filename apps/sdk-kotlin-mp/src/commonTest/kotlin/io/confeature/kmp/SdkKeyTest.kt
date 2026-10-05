// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.SdkKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Cross-platform `SdkKey` contract. Runs on JVM, iOS, JS, and Android via `kotlin-test` so the
 * SHA-256 → base64url → 32-char envelope behaves identically regardless of which `Sha256Provider`
 * `actual` is bound (JVM `MessageDigest`, iOS CommonCrypto, JS SubtleCrypto).
 */
class SdkKeyTest {

    private val validKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /** A ConfigCat-shaped key (#802) — an obvious fake (#858), belongs to no environment. */
    private val newShapeKey = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

    @Test
    fun isValidConfeatureKeyFormat_matchesCanonical() {
        assertTrue(SdkKey.isValidConfeatureKeyFormat(validKey))
    }

    // The full accept/reject list (sdk-key-shapes.json) is exercised on the JVM target by
    // SdkKeyShapesTest; these cases pin the same regex on every other target (iOS / JS / Android).

    @Test
    fun isValidConfeatureKeyFormat_acceptsConfigCatShape() {
        assertTrue(SdkKey.isValidConfeatureKeyFormat(newShapeKey))
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsConfigCatShapeWithShortSegment() {
        assertFalse(
            SdkKey.isValidConfeatureKeyFormat(
                "configcat-sdk-1/FAKEfixtureKeyNotRe05/FAKEfixtureKeyNotRea06",
            ),
        )
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsTrailingNewline() {
        // `$` can match before a final line terminator; a whole-string match must still reject it.
        assertFalse(SdkKey.isValidConfeatureKeyFormat(newShapeKey + "\n"))
        assertFalse(SdkKey.isValidConfeatureKeyFormat(validKey + "\n"))
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsNull() {
        assertFalse(SdkKey.isValidConfeatureKeyFormat(null))
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsEmpty() {
        assertFalse(SdkKey.isValidConfeatureKeyFormat(""))
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsTruncated() {
        assertFalse(SdkKey.isValidConfeatureKeyFormat("confeature-sdk-1-AAA"))
    }

    @Test
    fun redact_emptyReturnsRedactedSentinel() {
        assertEquals("[redacted]", SdkKey.redact(""))
    }

    @Test
    fun redact_nullReturnsRedactedSentinel() {
        assertEquals("[redacted]", SdkKey.redact(null))
    }

    @Test
    fun redact_shortKeyReturnsSentinel() {
        assertEquals("[redacted]", SdkKey.redact("short"))
    }

    @Test
    fun redact_neverContainsRawKey() {
        val redacted = SdkKey.redact(validKey)
        assertTrue(redacted.contains("[redacted]"))
        // Middle of the key MUST be masked.
        val middle = validKey.substring(20, validKey.length - 20)
        assertFalse(redacted.contains(middle))
    }

    @Test
    fun redact_keepsHeadAndTailVisible() {
        val redacted = SdkKey.redact(validKey)
        val visible = maxOf(4, validKey.length / 10)
        assertTrue(redacted.startsWith(validKey.substring(0, visible)))
        assertTrue(redacted.endsWith(validKey.substring(validKey.length - visible)))
    }

    @Test
    fun redact_newShapeShowsNoMoreSecretThanLegacy() {
        val redacted = SdkKey.redact(newShapeKey)
        val segments = newShapeKey.split("/")
        assertEquals(3, segments.size)
        // Neither secret segment appears whole; the head carries no secret characters.
        assertFalse(redacted.contains(segments[1]))
        assertFalse(redacted.contains(segments[2]))
        // Tail: 6 secret characters (a legacy 82-char key shows 8).
        assertEquals("config…[redacted]…" + newShapeKey.takeLast(6), redacted)
    }

    @Test
    fun deriveCacheKey_newShapeHashesSlashAsPlainByte() {
        // Cross-language value pinned by cache-key-fixtures.json; the `/` is never escaped/stripped.
        assertEquals(
            "confeature:cache:v1:SqU9woq8Xp72crnJnqAuccVvuDENt176",
            SdkKey.deriveCacheKey("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"),
        )
    }

    @Test
    fun deriveCacheKey_envelopeFormat() {
        val cacheKey = SdkKey.deriveCacheKey(validKey)
        assertTrue(cacheKey.startsWith("confeature:cache:v1:"))
        assertEquals("confeature:cache:v1:".length + 32, cacheKey.length)
    }

    @Test
    fun deriveCacheKey_isDeterministic() {
        assertEquals(SdkKey.deriveCacheKey(validKey), SdkKey.deriveCacheKey(validKey))
    }

    @Test
    fun deriveCacheKey_differentKeysProduceDifferentEnvelopes() {
        assertNotEquals(SdkKey.deriveCacheKey(validKey), SdkKey.deriveCacheKey("other-key"))
    }

    @Test
    fun cacheKeyTail_stripsEnvelopePrefix() {
        val cacheKey = SdkKey.deriveCacheKey(validKey)
        val tail = SdkKey.cacheKeyTail(cacheKey)
        assertEquals(32, tail.length)
        assertFalse(tail.contains(":"))
    }
}
