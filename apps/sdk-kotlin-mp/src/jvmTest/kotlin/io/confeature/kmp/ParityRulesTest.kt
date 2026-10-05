// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.Evaluator
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Targeting-rule parity gate (spec 135 / #439, epic #382) — JVM target authoritative.
 *
 * Loads the TS-generated full-config rule corpus + configs from
 * `packages/test-fixtures-sdk-parity/fixtures/parity-{corpus,configs}-rules.json`, branches on each
 * config's `injectionMode`, and asserts byte-identical evaluation through the SDK's PUBLIC
 * [ConfeatureClient.getValue].
 *
 * Per the contract (`contracts/full-config-override.md` §3): a `"full-config"` tuple MUST route
 * through [createFlagOverridesFromConfig] / [ConfigOverrideDataSource] — never the flat map path
 * (SC-004). The capability probe is honoured explicitly: if this SDK lacked the full-config factory
 * the tuple is SKIPPED with a reason (never a silent map fallback → no false-green). The KMP SDK has
 * adopted the factory, so every loaded tuple resolves through the real
 * [io.confeature.kmp.internal.Evaluator] with the FULL `{p,f,s}` config root (salt `p.s` + segments
 * `s` intact — the spec-129 dropped-salt regression this story must not reintroduce).
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): every loaded tuple MUST pass. If a tuple
 * drifts, STOP and investigate the override-route / Evaluator code — never mutate the corpus to make
 * the test green. A genuinely unresolved rule is a real engine gap, reported as a discrete finding,
 * not a fixture workaround.
 */
class ParityRulesTest {

    @TestFactory
    fun ruleCorpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusRulesPath())
        val configs = loadList(WorkspaceRoot.parityConfigsRulesPath())

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

        val byId: Map<String, JsonObject> = configs.associateBy { obj ->
            obj["id"]!!.jsonPrimitive.content
        }

        return tuples.map { tuple ->
            val description = tuple["description"]!!.jsonPrimitive.content
            DynamicTest.dynamicTest(description) { runTuple(tuple, byId) }
        }
    }

    private fun runTuple(tuple: JsonObject, configsById: Map<String, JsonObject>) {
        val description = tuple["description"]!!.jsonPrimitive.content
        val configId = tuple["configId"]!!.jsonPrimitive.content
        val cfg = configsById[configId]
            ?: throw AssertionError(
                "rule corpus references unknown configId=$configId; regenerate fixtures",
            )

        val injectionMode = (cfg["injectionMode"] as? JsonPrimitive)?.contentOrNull ?: "map"

        val flagOverrides: FlagOverrides = when (injectionMode) {
            "full-config" -> {
                // Capability probe (contract §3 / SC-004): the KMP SDK HAS adopted the full-config
                // factory, so we build it. If it were ever removed, the right move is to SKIP this
                // tuple with a reason — NEVER flat-path a full-config tuple (no silent false-green).
                @Suppress("UNCHECKED_CAST")
                val configRoot = decodeJsonElement(cfg["config"]) as? Map<String, Any?>
                    ?: throw AssertionError("rule config $configId has no decodable `config` root")
                createFlagOverridesFromConfig(configRoot, OverrideBehaviour.LOCAL_ONLY)
            }
            else -> {
                // Map mode — keep the existing flat-map consumption identical to ParityCorpusTest.
                val overridesMap = decodeOverridesMap(cfg["overridesMap"])
                FlagOverrides.localOnly(MapOverrideDataSource(overridesMap))
            }
        }

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(flagOverrides)
            .build()
        try {
            val key = tuple["key"]!!.jsonPrimitive.content
            val expected = decodeJsonElement(tuple["expected"])
            val user = buildUser(tuple["user"])

            // Typed default keyed on the setting's `t` discriminator (spec 152). The 4 decimal
            // tuples are a DOUBLE setting (t=3) whose corpus default is the JSON integer `-1`; the
            // evaluator's TYPE_MISMATCH guard is strict int-vs-double (Principle II), so a bare Int
            // default would fail the guard. We coerce the corpus default to the type the setting
            // declares (Double for t=3, Int for t=2) WITHOUT relaxing the evaluator. Map-mode tuples
            // (no setting `t`) keep the natural JSON-decoded default.
            val settingType = settingTypeFor(cfg, key)
            val defaultValue = typedDefault(tuple["defaultValue"], settingType)

            val expectedVariationId = tuple["expectedVariationId"]?.jsonPrimitive?.contentOrNull

            if (expectedVariationId != null) {
                // VariationId-bearing tuple (spec 152 / #475 US2): assert through the PUBLIC
                // getValueDetails — value AND variationId — so the override→details propagation
                // (the #395 gap class) is gated. Numeric-aware value compare keeps int-vs-double
                // strict at the evaluator but lets a DOUBLE result (e.g. 0.0) match an integral
                // corpus `expected` (e.g. 0).
                val details = runBlocking { client.getValueDetails(key, defaultValue, user) }
                assertValueEquals(expected, details.value, description)
                assertEquals(
                    expectedVariationId,
                    details.variationId,
                    "VariationId parity drift on $description — investigate the full-config " +
                        "override → getValueDetails propagation (the #395 gap class), do NOT mutate " +
                        "the corpus (Constitution Principle II is NON-NEGOTIABLE).",
                )
            } else {
                val actual = runBlocking { client.getValue(key, defaultValue, user) }
                assertValueEquals(expected, actual, description)
            }
        } finally {
            client.close()
        }
    }

    /** Returns the setting's `t` discriminator for [key] in the tuple's config, or null (map mode). */
    private fun settingTypeFor(cfg: JsonObject, key: String): Int? {
        val config = cfg["config"] as? JsonObject ?: return null
        val settings = config["f"] as? JsonObject ?: return null
        val setting = settings[key] as? JsonObject ?: return null
        return (setting["t"] as? JsonPrimitive)?.intOrNull
    }

    /**
     * Decodes the corpus `defaultValue`, coercing it to the type the setting's `t` declares so the
     * evaluator's strict int-vs-double TYPE_MISMATCH guard is satisfied without being relaxed:
     * t=3 (DOUBLE) → [Double]; t=2 (INT) → [Int]. Any other type (or map mode) keeps the natural
     * JSON-decoded value.
     */
    private fun typedDefault(raw: JsonElement?, settingType: Int?): Any? {
        val decoded = decodeJsonElement(raw)
        return when (settingType) {
            Evaluator.SETTING_TYPE_DOUBLE -> (decoded as? Number)?.toDouble() ?: decoded
            Evaluator.SETTING_TYPE_INT -> (decoded as? Number)?.toInt() ?: decoded
            else -> decoded
        }
    }

    /**
     * Value assertion that is numeric-aware: two [Number]s compare by their double value (so a
     * DOUBLE evaluator result like `0.0` matches an integral corpus `expected` like `0`), every
     * other type falls back to strict [assertEquals].
     */
    private fun assertValueEquals(expected: Any?, actual: Any?, description: String) {
        if (expected is Number && actual is Number) {
            assertEquals(
                expected.toDouble(),
                actual.toDouble(),
                "Rule parity drift on $description — investigate the full-config override route / " +
                    "Evaluator, do NOT mutate the corpus (Constitution Principle II is " +
                    "NON-NEGOTIABLE). A genuinely unresolved rule is a real engine gap.",
            )
            return
        }
        assertEquals(
            expected,
            actual,
            "Rule parity drift on $description — investigate the full-config override route / " +
                "Evaluator, do NOT mutate the corpus (Constitution Principle II is " +
                "NON-NEGOTIABLE). A genuinely unresolved rule is a real engine gap.",
        )
    }

    /** Decodes the `overridesMap` (map-mode only) into a `Map<String, Any>`; nullable slots drop. */
    private fun decodeOverridesMap(raw: JsonElement?): Map<String, Any> {
        if (raw == null || raw is JsonNull || raw !is JsonObject) return emptyMap()
        val out = LinkedHashMap<String, Any>(raw.size)
        for ((k, v) in raw) {
            val decoded = decodeJsonElement(v) ?: continue
            out[k] = decoded
        }
        return out
    }

    /**
     * Builds a [User] from the corpus `user` slot, or returns null.
     *
     * Custom attributes are deserialised per the spec-151 typed-attribute encoding (each `user.custom`
     * value carries its NATURAL JSON type): string → [String]; JSON number → [Number]; bool →
     * [Boolean]; string[] → `List<String>`; a Date object `{"$date": <epoch-seconds>}` → the epoch
     * SECONDS [Double] (the representation `ConfigCatUser` serialises a date to; matches the bare
     * numeric epoch tuple byte-for-byte); a non-finite-number object `{"$num": "NaN"|"Infinity"|
     * "-Infinity"}` (#479 tag, parallel to `{$date}`, because `JSON.stringify` collapses these to a
     * lossy `null`) → the corresponding [Double.NaN] / [Double.POSITIVE_INFINITY] /
     * [Double.NEGATIVE_INFINITY]. `null` attribute slots are skipped. The typed value is then fed
     * straight into the public typed [User.custom] (`Map<String, Any>`).
     */
    private fun buildUser(raw: JsonElement?): User? {
        if (raw == null || raw is JsonNull || raw !is JsonObject) return null
        val identifier = raw["identifier"]?.jsonPrimitive?.contentOrNull ?: ""
        val email = (raw["email"] as? JsonPrimitive)?.contentOrNull
        val country = (raw["country"] as? JsonPrimitive)?.contentOrNull
        val customRaw = raw["custom"]
        val custom: Map<String, Any> = if (customRaw is JsonObject) {
            val cm = LinkedHashMap<String, Any>(customRaw.size)
            for ((k, v) in customRaw) {
                decodeCustomAttribute(v)?.let { cm[k] = it }
            }
            cm
        } else {
            emptyMap()
        }
        return User(identifier = identifier, email = email, country = country, custom = custom)
    }

    /**
     * Decodes one typed `user.custom` value into the native Kotlin type the public [User] accepts, or
     * null when the slot must be skipped (JSON null). The `{"$date": n}` wrapper is unwrapped to its
     * epoch-seconds [Double]; the `{"$num": "NaN"|"Infinity"|"-Infinity"}` wrapper (#479) is unwrapped
     * to the corresponding non-finite [Double] (these would otherwise be lossy `null` under
     * `JSON.stringify`). Kotlin's `Double.NaN.toString()` / `POSITIVE_INFINITY` / `NEGATIVE_INFINITY`
     * render as "NaN" / "Infinity" / "-Infinity", matching the evaluator's canonical stringify, so the
     * 6 number/date-to-string non-finite tuples now RUN and PASS (previously deferred under #468).
     */
    private fun decodeCustomAttribute(v: JsonElement): Any? = when (v) {
        is JsonNull -> null
        is JsonObject -> {
            val num = v["\$num"]
            if (num != null) {
                require(num is JsonPrimitive && num.isString) {
                    "non-finite-number wrapper \$num must be a JSON string; got $num"
                }
                when (num.content) {
                    "NaN" -> Double.NaN
                    "Infinity" -> Double.POSITIVE_INFINITY
                    "-Infinity" -> Double.NEGATIVE_INFINITY
                    else -> throw AssertionError(
                        "unsupported \$num token: ${num.content} (expected NaN/Infinity/-Infinity)",
                    )
                }
            } else {
                val date = v["\$date"]
                require(date is JsonPrimitive && !date.isString) {
                    "unsupported typed custom-attribute object encoding: $v"
                }
                date.doubleOrNull
                    ?: throw AssertionError("Date wrapper \$date must be a JSON number; got $date")
            }
        }
        is JsonArray -> v.map { el ->
            (el as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw AssertionError("typed string-array custom attribute has a non-string element: $el")
        }
        is JsonPrimitive ->
            when {
                v.isString -> v.content
                v.booleanOrNull != null -> v.booleanOrNull
                else -> v.doubleOrNull
                    ?: throw AssertionError("unsupported typed custom-attribute primitive: $v")
            }
    }

    /** Recursively decodes a kotlinx JsonElement into Kotlin primitives / List / Map. */
    private fun decodeJsonElement(el: JsonElement?): Any? = when (el) {
        null, is JsonNull -> null
        is JsonObject -> el.mapValues { decodeJsonElement(it.value) }
        is JsonArray -> el.map { decodeJsonElement(it) }
        is JsonPrimitive -> decodePrimitive(el)
    }

    private fun decodePrimitive(p: JsonPrimitive): Any? {
        if (p.isString) return p.content
        p.booleanOrNull?.let { return it }
        p.intOrNull?.let { return it }
        p.longOrNull?.let { return if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else it }
        p.doubleOrNull?.let { return it }
        return p.contentOrNull
    }

    private fun loadList(path: java.nio.file.Path): List<JsonObject> {
        val raw = Files.readAllBytes(path)
        val parsed = Json.parseToJsonElement(String(raw, Charsets.UTF_8))
        require(parsed is JsonArray) { "expected JSON array at $path" }
        return parsed.jsonArray.map { it.jsonObject }
    }

    companion object {
        private const val PARITY_SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }
}
