// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.JsonParser
import io.confeature.android.internal.SdkKey
import java.nio.file.Files
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource

/**
 * Cross-language cache-key parity gate.
 *
 * Loads every row of `cache-key-fixtures.json` (≥ 5 entries; no row count is hard-coded) and
 * asserts that the Android SDK's [SdkKey.deriveCacheKey] produces the byte-identical envelope every
 * other SDK (TS / Python / Go / .NET / Rust / Ruby / Java) produces. That includes the
 * ConfigCat-shaped `configcat-sdk-1/<22>/<22>` row (#802), whose `/` is hashed as a plain byte.
 *
 * Constitution Principle II NON-NEGOTIABLE: every entry MUST match. A single drift implies the
 * Android derivation has gone out of phase with the canonical TS implementation.
 *
 * The parser uses our internal `JsonParser` so the fixture lives inside one consistent decoding
 * stack — same shape as the production `config_v6.json` parse path.
 */
class CacheKeyFixturesTest {
    companion object {
        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun entries(): List<Map<String, String>> {
            val raw = String(Files.readAllBytes(WorkspaceRoot.cacheKeyFixturesPath()))
            // Top-level is an array; wrap in an object envelope so org.json
            // can decode it without bypassing our parser surface.
            val wrapped = JsonParser.parseObject("{\"list\":$raw}")
            val list = wrapped["list"] as List<Map<String, String>>
            return list
        }
    }

    @ParameterizedTest(name = "[{index}] sdkKey={0}")
    @MethodSource("entries")
    fun deriveMatchesFixture(entry: Map<String, String>) {
        val sdkKey = entry["sdkKey"]!!
        val expected = entry["expectedCacheKey"]
        val actual = SdkKey.deriveCacheKey(sdkKey)
        assertThat(actual)
            .`as`(
                "Cache-key parity drift for sdkKey=%s — investigate SdkKey.deriveCacheKey, " +
                    "do NOT mutate the fixture (Constitution Principle II is NON-NEGOTIABLE).",
                sdkKey,
            )
            .isEqualTo(expected)
    }
}
