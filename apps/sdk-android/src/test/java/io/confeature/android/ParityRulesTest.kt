// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.JsonParser
import java.nio.file.Files
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * Targeting-rule parity (spec 135 / #440, epic #382, US3) — the `CORPUS_RULES` corpus injected
 * through the full-config offline override.
 *
 * Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which feed a value-only
 * `overridesMap` via [MapOverrideDataSource]), the rule corpus carries the whole `{p, f, s}` config
 * and is injected via [FlagOverrides.localConfig] + [OverrideBehaviour.LOCAL_ONLY]. The SDK then
 * resolves targeting rules / segments / % options offline through the real Android evaluator,
 * exactly as it would against a CDN-served config — no network round-trip.
 *
 * Runner contract (mirrors `apps/sdk-node/tests/parity/parity-rules.test.ts`, sdk-python's
 * `test_parity_rules.py`, sdk-java's `ParityRulesTest`): every tuple branches on the config's
 * `injectionMode`:
 * - `"full-config"` → capability-probe [FlagOverrides.localConfig]. If sdk-android exposes it,
 *   build the override and assert the PUBLIC `client.getValue` returns `tuple.expected`. If it does
 *   NOT, SKIP with a reason — NEVER fall back to the flat-map path (SC-004: no `"full-config"`
 *   tuple is ever resolved on the map path, and a skip is reported with its reason).
 *
 * sdk-android HAS adopted the full-config path, so every loaded rule tuple runs and passes; there
 * are no skips for this family.
 *
 * AC4: if a tuple fails because of a real Android evaluator targeting-rule gap (not override
 * wiring), STOP and file a discrete #382 follow-up — never a corpus or test workaround.
 */
class ParityRulesTest {
    private companion object {
        const val PARITY_SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    /**
     * Capability probe: does this SDK expose the in-memory full-config override factory
     * [FlagOverrides.localConfig]? The full-config path is gated on this — never silently resolved
     * on the flat-map path (SC-004 / AC4).
     */
    private fun hasFullConfigOverrides(): Boolean =
        runCatching {
            FlagOverrides::class.java.getMethod(
                "localConfig",
                Map::class.java,
                OverrideBehaviour::class.java,
            )
        }.isSuccess

    @TestFactory
    fun ruleCorpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusRulesPath().toString())
        val configs = loadList(WorkspaceRoot.parityConfigsRulesPath().toString())

        // Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
        // foundational #383 tuples are never removed) and grows with every
        // comparator spec, so we assert only that the fixture actually loaded —
        // not a hardcoded total that re-trips on every growth. Per-tuple
        // correctness is covered by the per-tuple dynamic tests below, and
        // JSON↔TS sync is owned by the central `check:exports` gate, so this
        // guard is purely a non-empty smoke and never needs a per-spec bump.
        assertTrue(
            tuples.size >= 8,
            "rule corpus is non-empty (append-only floor: at least the 8 foundational rule " +
                "tuples); got ${tuples.size} — looks empty/truncated, regenerate via " +
                "`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.",
        )

        val byId: Map<String, Map<String, Any?>> = configs.associateBy { it["id"] as String }

        return tuples.map { tuple ->
            DynamicTest.dynamicTest(tuple["description"] as String) { runRuleTuple(tuple, byId) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun runRuleTuple(tuple: Map<String, Any?>, configsById: Map<String, Map<String, Any?>>) {
        val configId = tuple["configId"] as String
        val configRecord = configsById[configId]
            ?: throw AssertionError(
                "rule corpus references unknown configId=$configId; regenerate fixtures",
            )

        val injectionMode = configRecord["injectionMode"] as? String
        // The rule corpus is full-config only; a flat-map tuple here would mean a
        // corpus regression, never a silent flat-map fallback (SC-004).
        assertThat(injectionMode)
            .`as`("rule corpus tuple %s must be full-config (SC-004)", tuple["description"])
            .isEqualTo("full-config")

        if (!hasFullConfigOverrides()) {
            // SC-004: NEVER fall back to the flat-map path — skip with a reason so a
            // CI run surfaces it explicitly rather than false-greening on the map path.
            Assumptions.abort<Unit>("SDK has not adopted full-config overrides")
        }

        val config = configRecord["config"] as Map<String, Any?>

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localConfig(config, OverrideBehaviour.LOCAL_ONLY))
            .build()
        try {
            val key = tuple["key"] as String
            // Typed default by SETTING type (spec 152 / #475): the corpus encodes a numeric default
            // by its natural JSON type (`-1` → Int). For a DOUBLE setting (`t == 3`) we MUST hand the
            // evaluator a Double default so the int-vs-double type guard stays strict (Principle II) —
            // a raw Int default would TYPE_MISMATCH the double-typed setting. Read `f[key].t` from the
            // injected config and coerce the corpus default to it.
            val defaultValue = typedDefault(tuple["defaultValue"], config, key)
            val user = buildUser(tuple["user"])

            val expectedVariationId = tuple["expectedVariationId"] as? String
            if (expectedVariationId != null) {
                // Assert against the PUBLIC getValueDetails (Principle II) — value AND variationId.
                val details = client.getValueDetails(key, defaultValue, user)
                assertValueEquals(details.value, tuple["expected"], tuple["description"])
                assertThat(details.variationId)
                    .`as`(
                        "variationId parity drift on %s — the full-config override path must " +
                            "propagate the evaluator's variationId through getValueDetails (#395 " +
                            "gap class). Investigate Snapshot.getValueDetails / Evaluator, do NOT " +
                            "mutate the corpus (Principle II is NON-NEGOTIABLE).",
                        tuple["description"],
                    )
                    .isEqualTo(expectedVariationId)
            } else {
                val actual = client.getValue(key, defaultValue, user)
                assertValueEquals(actual, tuple["expected"], tuple["description"])
            }
        } finally {
            client.close()
        }
    }

    /**
     * Coerce the corpus default to the INJECTED setting's wire type (`f[key].t`). t=3 (DOUBLE) →
     * Double, t=2 (INT) → Int. This keeps the int-vs-double type guard strict: a DOUBLE setting
     * with an Int default would TYPE_MISMATCH and resolve to the (wrong-typed) default. Non-numeric
     * defaults (String / Boolean) and keys whose setting type is not numeric pass through verbatim.
     */
    @Suppress("UNCHECKED_CAST")
    private fun typedDefault(rawDefault: Any?, config: Map<String, Any?>, key: String): Any? {
        if (rawDefault !is Number) return rawDefault
        val settings = config["f"] as? Map<String, Any?> ?: return rawDefault
        val setting = settings[key] as? Map<String, Any?> ?: return rawDefault
        return when ((setting["t"] as? Number)?.toInt()) {
            3 -> rawDefault.toDouble()
            2 -> rawDefault.toInt()
            else -> rawDefault
        }
    }

    /**
     * Compare an evaluated value to the corpus `expected`, numerically for numbers (so an
     * Int `expected` matches a Double evaluator result and vice versa — the corpus encodes whole
     * numbers as JSON ints) and by `isEqualTo` for everything else.
     */
    private fun assertValueEquals(actual: Any?, expected: Any?, description: Any?) {
        val drift =
            "Targeting-rule parity drift on $description — investigate Evaluator / OverrideEval, " +
                "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE). " +
                "If this is a real Android targeting-rule engine gap (not an " +
                "override-wiring bug), STOP and file a discrete #382 follow-up (AC4)."
        if (actual is Number && expected is Number) {
            assertThat(actual.toDouble()).`as`(drift).isEqualTo(expected.toDouble())
        } else {
            assertThat(actual).`as`(drift).isEqualTo(expected)
        }
    }

    /** The in-memory full-config override factory is exposed on this SDK (no skips). */
    @Test
    fun fullConfigFactoryIsExposed() {
        assertThat(hasFullConfigOverrides())
            .`as`(
                "FlagOverrides.localConfig must be exposed; sdk-android has adopted the in-memory " +
                    "full-config override path (#440).",
            )
            .isTrue()
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
            // Typed custom-attribute decoding (spec 151 / #468, #479). The corpus encodes a
            // `user.custom` value by its NATURAL JSON type: string → String, number → Number,
            // bool → Boolean, string[] → List<String>, a Date as the TAGGED object
            // `{"$date": <epoch-seconds>}`, and a non-finite number as the TAGGED object
            // `{"$num": "NaN"|"Infinity"|"-Infinity"}` (lossless, since `JSON.stringify` collapses
            // those to `null`). A `null` attribute is skipped. The decoded typed value is handed to
            // the public typed `User.custom` (Map<String, Any>) so the real Android evaluator
            // performs the ConfigCat-exact conversion.
            val custom = LinkedHashMap<String, Any>()
            for ((k, v) in raw) {
                val decoded = decodeCustomAttribute(v) ?: continue
                custom[k] = decoded
            }
            b.custom(custom)
        }
        return b.build()
    }

    /**
     * Decode a single corpus-encoded `user.custom` attribute into the typed value the public
     * [User.custom] accepts. `null` → null (caller skips). A `{"$date": n}` tag becomes a
     * [java.util.Date] at epoch SECONDS (millis = `n * 1000`), exactly the value ConfigCat's
     * evaluator stringifies via `getTime() / 1000.0`. A `{"$num": "NaN"|"Infinity"|"-Infinity"}`
     * tag (#479, parallel to `$date`) becomes the matching non-finite [Double]
     * ([Double.NaN] / [Double.POSITIVE_INFINITY] / [Double.NEGATIVE_INFINITY]) — this lossless
     * encoding carries the 6 non-finite number-conversion tuples that `JSON.stringify` would
     * otherwise collapse to `null`. `Double.NaN.toString()` = "NaN",
     * `Double.POSITIVE_INFINITY.toString()` = "Infinity", `Double.NEGATIVE_INFINITY.toString()` =
     * "-Infinity", so the evaluator's number→string conversion matches the TextEquals(28) oracle.
     * A JSON array becomes a `List<String>`; string / number / boolean pass through verbatim.
     */
    @Suppress("UNCHECKED_CAST")
    private fun decodeCustomAttribute(v: Any?): Any? =
        when (v) {
            null -> null
            is Map<*, *> -> {
                val obj = v as Map<String, Any?>
                val dateField = obj["\$date"]
                val numField = obj["\$num"]
                when {
                    dateField is Number -> java.util.Date(Math.round(dateField.toDouble() * 1000.0))
                    numField != null -> when (numField) {
                        "NaN" -> Double.NaN
                        "Infinity" -> Double.POSITIVE_INFINITY
                        "-Infinity" -> Double.NEGATIVE_INFINITY
                        else -> throw AssertionError("unexpected \$num sentinel: $numField")
                    }
                    else -> throw AssertionError("unexpected object-typed custom attribute: $obj")
                }
            }
            is List<*> -> {
                // string array → List<String> (empty list stays empty).
                val out = ArrayList<String>(v.size)
                for (e in v) if (e is String) out.add(e)
                out
            }
            else -> v // String / Number / Boolean verbatim.
        }

    @Suppress("UNCHECKED_CAST")
    private fun loadList(path: String): List<Map<String, Any?>> {
        val raw = String(Files.readAllBytes(java.nio.file.Paths.get(path)))
        // Wrap top-level array in an object envelope so the org.json adapter accepts it.
        val wrapped = JsonParser.parseObject("{\"list\":$raw}")
        return wrapped["list"] as List<Map<String, Any?>>
    }
}
