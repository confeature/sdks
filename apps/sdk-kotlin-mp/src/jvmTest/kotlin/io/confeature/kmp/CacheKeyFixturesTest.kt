// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.SdkKey
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files
import kotlin.test.assertEquals

/**
 * Cross-language cache-key parity gate (JVM target authoritative).
 *
 * Loads every row of `cache-key-fixtures.json` (no row count is hard-coded) and asserts that
 * [SdkKey.deriveCacheKey] produces the byte-identical envelope every other SDK (TS / Python / Go /
 * .NET / Rust / Ruby / PHP / Java) produces. That includes the ConfigCat-shaped
 * `configcat-sdk-1/<22>/<22>` row (#802), whose `/` is hashed as a plain byte.
 *
 * Constitution Principle II is NON-NEGOTIABLE: every entry MUST match. A single drift implies the
 * KMP derivation has gone out of phase with the canonical TS implementation.
 */
class CacheKeyFixturesTest {

    @TestFactory
    fun deriveMatchesFixture(): List<DynamicTest> {
        val raw = Files.readAllBytes(WorkspaceRoot.cacheKeyFixturesPath())
        val parsed = Json.parseToJsonElement(String(raw, Charsets.UTF_8))
        require(parsed is JsonArray) { "cache-key-fixtures.json must be a JSON array" }

        return parsed.map { element ->
            val entry: JsonObject = element.jsonObject
            val sdkKey = entry["sdkKey"]!!.jsonPrimitive.contentOrNull
                ?: error("missing sdkKey in fixture entry: $entry")
            val expected = entry["expectedCacheKey"]!!.jsonPrimitive.contentOrNull
                ?: error("missing expectedCacheKey in fixture entry: $entry")

            DynamicTest.dynamicTest("sdkKey=${SdkKey.redact(sdkKey)}") {
                val actual = SdkKey.deriveCacheKey(sdkKey)
                assertEquals(
                    expected,
                    actual,
                    "Cache-key parity drift for sdkKey=${SdkKey.redact(sdkKey)} — investigate " +
                        "SdkKey.deriveCacheKey, do NOT mutate the fixture (Constitution Principle " +
                        "II is NON-NEGOTIABLE).",
                )
            }
        }
    }
}
