// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.JsonParser
import io.confeature.android.internal.SdkKey
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource

class SdkKeyTest {
    companion object {
        private const val VALID_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

        /** A ConfigCat-shaped key (#802) — an obvious fake (#858), belongs to no environment. */
        private const val NEW_SHAPE_KEY =
            "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"

        @Suppress("UNCHECKED_CAST")
        private fun shapes(bucket: String): List<Map<String, String>> {
            val raw = String(Files.readAllBytes(WorkspaceRoot.sdkKeyShapesPath()), StandardCharsets.UTF_8)
            val doc = JsonParser.parseObject(raw)
            val list = doc[bucket] as List<Map<String, String>>
            assertThat(list).`as`("sdk-key-shapes.json '%s' list", bucket).isNotEmpty()
            return list
        }

        @JvmStatic
        fun validShapes(): List<Map<String, String>> = shapes("valid")

        @JvmStatic
        fun invalidShapes(): List<Map<String, String>> = shapes("invalid")
    }

    @ParameterizedTest(name = "[{index}] valid: {0}")
    @MethodSource("validShapes")
    fun isValidConfeatureKeyFormat_acceptsEverySharedValidShape(entry: Map<String, String>) {
        assertThat(SdkKey.isValidConfeatureKeyFormat(entry["key"]))
            .`as`("sdk-key-shapes.json valid case '%s'", entry["name"])
            .isTrue()
    }

    @ParameterizedTest(name = "[{index}] invalid: {0}")
    @MethodSource("invalidShapes")
    fun isValidConfeatureKeyFormat_rejectsEverySharedInvalidShape(entry: Map<String, String>) {
        assertThat(SdkKey.isValidConfeatureKeyFormat(entry["key"]))
            .`as`("sdk-key-shapes.json invalid case '%s'", entry["name"])
            .isFalse()
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsTrailingNewline() {
        // java.util.regex `$` can match before a final line terminator; matches() must still reject it.
        assertThat(SdkKey.isValidConfeatureKeyFormat(NEW_SHAPE_KEY + "\n")).isFalse()
        assertThat(SdkKey.isValidConfeatureKeyFormat(VALID_KEY + "\n")).isFalse()
    }

    @Test
    fun isValidConfeatureKeyFormat_matchesCanonical() {
        assertThat(SdkKey.isValidConfeatureKeyFormat(VALID_KEY)).isTrue()
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsNull() {
        assertThat(SdkKey.isValidConfeatureKeyFormat(null)).isFalse()
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsEmpty() {
        assertThat(SdkKey.isValidConfeatureKeyFormat("")).isFalse()
    }

    @Test
    fun isValidConfeatureKeyFormat_rejectsTruncated() {
        assertThat(SdkKey.isValidConfeatureKeyFormat("confeature-sdk-1-AAA")).isFalse()
    }

    @Test
    fun redact_emptyReturnsRedactedSentinel() {
        assertThat(SdkKey.redact("")).isEqualTo("[redacted]")
    }

    @Test
    fun redact_nullReturnsRedactedSentinel() {
        assertThat(SdkKey.redact(null)).isEqualTo("[redacted]")
    }

    @Test
    fun redact_shortKeyReturnsSentinel() {
        assertThat(SdkKey.redact("short")).isEqualTo("[redacted]")
    }

    @Test
    fun redact_neverContainsRawKey() {
        val redacted = SdkKey.redact(VALID_KEY)
        assertThat(redacted).contains("[redacted]")
        val middle = VALID_KEY.substring(20, VALID_KEY.length - 20)
        assertThat(redacted).doesNotContain(middle)
    }

    @Test
    fun redact_keepsHeadAndTailVisible() {
        val redacted = SdkKey.redact(VALID_KEY)
        val visible = maxOf(4, VALID_KEY.length / 10)
        assertThat(redacted).startsWith(VALID_KEY.substring(0, visible))
        assertThat(redacted).endsWith(VALID_KEY.substring(VALID_KEY.length - visible))
    }

    @Test
    fun redact_newShapeShowsNoMoreSecretThanLegacy() {
        val redacted = SdkKey.redact(NEW_SHAPE_KEY)
        val segments = NEW_SHAPE_KEY.split("/")
        assertThat(segments).hasSize(3)
        assertThat(redacted).contains("[redacted]")
        // Neither secret segment appears whole; the head carries no secret characters.
        assertThat(redacted).doesNotContain(segments[1]).doesNotContain(segments[2])
        assertThat(redacted).startsWith("config…[redacted]…")
        // Tail: 6 secret characters (a legacy 82-char key shows 8).
        assertThat(redacted)
            .isEqualTo("config…[redacted]…" + NEW_SHAPE_KEY.substring(NEW_SHAPE_KEY.length - 6))
    }

    @Test
    fun deriveCacheKey_newShapeHashesSlashAsPlainByte() {
        // Cross-language value pinned by cache-key-fixtures.json; the `/` is never escaped/stripped.
        assertThat(SdkKey.deriveCacheKey("configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"))
            .isEqualTo("confeature:cache:v1:SqU9woq8Xp72crnJnqAuccVvuDENt176")
    }

    @Test
    fun deriveCacheKey_envelopeFormat() {
        val cacheKey = SdkKey.deriveCacheKey(VALID_KEY)
        assertThat(cacheKey).startsWith("confeature:cache:v1:")
        assertThat(cacheKey).hasSize("confeature:cache:v1:".length + 32)
    }

    @Test
    fun deriveCacheKey_isDeterministic() {
        assertThat(SdkKey.deriveCacheKey(VALID_KEY)).isEqualTo(SdkKey.deriveCacheKey(VALID_KEY))
    }

    @Test
    fun cacheKeyTail_stripsEnvelopePrefix() {
        val cacheKey = SdkKey.deriveCacheKey(VALID_KEY)
        val tail = SdkKey.cacheKeyTail(cacheKey)
        assertThat(tail).hasSize(32).doesNotContain(":")
    }
}
