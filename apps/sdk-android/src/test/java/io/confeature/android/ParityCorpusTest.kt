// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.Evaluator
import io.confeature.android.internal.JsonParser
import java.nio.file.Files
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * Spec 047 US1 parity gate — 58/58 byte-identical to ConfigCat.
 *
 * Loads the TS-generated parity corpus + canonical configs from
 * `packages/test-fixtures-sdk-parity/fixtures/`, builds one [ConfeatureClient] per tuple with
 * `manualPoll() + FlagOverrides.localOnly(...)`, and asserts byte-identical evaluation against the
 * `expected` value.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST pass. If a tuple drifts, STOP
 * and investigate the override-eval / evaluator code — never mutate the corpus to make the test
 * green.
 *
 * Type-coercion note: [JsonParser] coerces JSON numbers to [Int] when they fit, then [Long], then
 * [Double]. Corpus default values are exclusively [Boolean], [String], [Int], and [Double] so
 * `assertThat(actual).isEqualTo(expected)` holds across the canonical variants.
 */
class ParityCorpusTest {
    private companion object {
        const val PARITY_SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    /**
     * Spec 069 US2 typed-parity gate — the 13-tuple `parity-corpus-typed.json` corpus, spanning
     * the `string` / `int` / `double` SettingTypes (plus the TYPE_MISMATCH tuples). Runs under
     * Robolectric in the same `manualPoll() + :memory: + LocalOnly` consumption mode as the
     * boolean tier. Numeric corpus values are canonicalised to the target setting's native Kotlin
     * type (`t:2→Int`, `t:3→Double`) so equality holds across the OverrideEval class check.
     */
    @TestFactory
    fun typedCorpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusTypedPath().toString())
        val configs = loadList(WorkspaceRoot.parityConfigsTypedPath().toString())

        assertEquals(
            13,
            tuples.size,
            "Expected 13 typed corpus tuples; regenerate via " +
                "`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.",
        )

        val byId: Map<String, Map<String, Any?>> = configs.associateBy { it["id"] as String }

        return tuples.map { tuple ->
            DynamicTest.dynamicTest(tuple["description"] as String) { runTypedTuple(tuple, byId) }
        }
    }

    /** Reads the `t` discriminator for [key] from a typed config, or null. */
    @Suppress("UNCHECKED_CAST")
    private fun settingType(cfg: Map<String, Any?>, key: String): Int? {
        val config = cfg["config"] as? Map<String, Any?> ?: return null
        val f = config["f"] as? Map<String, Any?> ?: return null
        val setting = f[key] as? Map<String, Any?> ?: return null
        return (setting["t"] as? Number)?.toInt()
    }

    /**
     * Canonicalises a decoded corpus value to the target setting's native Kotlin type. A `t:3`
     * (double) setting needs its value / default / expected as `Double` so equality holds across
     * the OverrideEval class-equality check. Non-numeric values and non-typed targets pass
     * through unchanged.
     */
    private fun canonicalise(value: Any?, settingType: Int?): Any? = when {
        settingType == null || value !is Number -> value
        settingType == Evaluator.SETTING_TYPE_DOUBLE -> value.toDouble()
        settingType == Evaluator.SETTING_TYPE_INT -> value.toInt()
        else -> value
    }

    /**
     * Runs one typed-corpus tuple. Mirrors [runTuple] but canonicalises the override map, the
     * default, and the expected value to the target setting's native Kotlin type so equality is
     * exact regardless of how JsonParser decoded the JSON literal.
     */
    @Suppress("UNCHECKED_CAST")
    private fun runTypedTuple(tuple: Map<String, Any?>, configsById: Map<String, Map<String, Any?>>) {
        val configId = tuple["configId"] as String
        val cfg = configsById[configId]
            ?: throw AssertionError(
                "typed corpus references unknown configId=$configId; regenerate fixtures",
            )

        val key = tuple["key"] as String
        val t = settingType(cfg, key)

        val rawOverrides = (cfg["overridesMap"] as? Map<String, Any?>) ?: LinkedHashMap()
        val overridesMap = LinkedHashMap<String, Any?>(rawOverrides.size)
        for ((k, v) in rawOverrides) {
            overridesMap[k] = canonicalise(v, settingType(cfg, k))
        }

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overridesMap)))
            .build()
        try {
            val defaultValue = canonicalise(tuple["defaultValue"], t)
            val expected = canonicalise(tuple["expected"], t)
            val user = buildUser(tuple["user"])
            val actual = client.getValue(key, defaultValue, user)
            assertThat(actual)
                .`as`(
                    "Typed parity drift on %s — investigate Evaluator / OverrideEval, " +
                        "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
                    tuple["description"],
                )
                .isEqualTo(expected)
        } finally {
            client.close()
        }
    }

    @TestFactory
    fun corpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusPath().toString())
        val configs = loadList(WorkspaceRoot.parityConfigsPath().toString())

        assertEquals(
            58,
            tuples.size,
            "Expected 58 corpus tuples; regenerate via " +
                "`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.",
        )

        val byId: Map<String, Map<String, Any?>> = configs.associateBy { it["id"] as String }

        return tuples.map { tuple ->
            DynamicTest.dynamicTest(tuple["description"] as String) { runTuple(tuple, byId) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun runTuple(tuple: Map<String, Any?>, configsById: Map<String, Map<String, Any?>>) {
        val configId = tuple["configId"] as String
        val cfg = configsById[configId]
            ?: throw AssertionError("corpus references unknown configId=$configId; regenerate fixtures")

        val overridesMap = (cfg["overridesMap"] as? Map<String, Any?>) ?: LinkedHashMap()

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overridesMap)))
            .build()
        try {
            val key = tuple["key"] as String
            val defaultValue = tuple["defaultValue"]
            val user = buildUser(tuple["user"])
            val actual = client.getValue(key, defaultValue, user)
            assertThat(actual)
                .`as`(
                    "Parity drift on %s — investigate Evaluator / OverrideEval, " +
                        "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
                    tuple["description"],
                )
                .isEqualTo(tuple["expected"])
        } finally {
            client.close()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun buildUser(userField: Any?): User? {
        if (userField !is Map<*, *>) return null
        val m = userField as Map<String, Any?>
        val identifier = (m["identifier"] as? String) ?: ""
        val b = User.builder(identifier)
        (m["email"] as? String)?.let { b.email(it) }
        (m["country"] as? String)?.let { b.country(it) }
        (m["custom"] as? Map<String, Any?>)?.let { raw ->
            val custom = LinkedHashMap<String, String>()
            for ((k, v) in raw) if (v is String) custom[k] = v
            b.custom(custom)
        }
        return b.build()
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadList(path: String): List<Map<String, Any?>> {
        val raw = String(Files.readAllBytes(java.nio.file.Paths.get(path)))
        // Wrap top-level array in an object envelope so the org.json
        // adapter accepts it.
        val wrapped = JsonParser.parseObject("{\"list\":$raw}")
        return wrapped["list"] as List<Map<String, Any?>>
    }
}
