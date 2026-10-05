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

/**
 * 58-tuple ConfigCat parity gate — JVM target authoritative.
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
 * The KMP `ConfeatureClient.getValue` is `suspend`; this test runs each tuple inside
 * [runBlocking] on the JVM `Default` dispatcher. The KMP iOS / JS targets verify the same
 * algorithm via the pure-common `OverrideEvalTest` + `EvaluatorTest`, so this corpus gate runs
 * only on JVM where parity expectations are authoritative.
 */
class ParityCorpusTest {

    /**
     * Spec 069 US2 typed-parity gate — the 13-tuple `parity-corpus-typed.json` corpus, spanning
     * the `string` / `int` / `double` SettingTypes (plus the TYPE_MISMATCH tuples). Runs the same
     * `manualPoll() + :memory: + LocalOnly` consumption mode as the boolean tier. Numeric corpus
     * values are canonicalised to the target setting's native Kotlin type (`t:2→Int`, `t:3→Double`)
     * so equality holds across the OverrideEval class-equality check.
     */
    @TestFactory
    fun typedCorpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusTypedPath())
        val configs = loadList(WorkspaceRoot.parityConfigsTypedPath())

        assertEquals(
            13,
            tuples.size,
            "Expected 13 typed corpus tuples; regenerate via `pnpm run export:corpus` in " +
                "packages/test-fixtures-sdk-parity/.",
        )

        val byId: Map<String, JsonObject> = configs.associateBy { obj ->
            obj["id"]!!.jsonPrimitive.content
        }

        return tuples.map { tuple ->
            val description = tuple["description"]!!.jsonPrimitive.content
            DynamicTest.dynamicTest(description) { runTypedTuple(tuple, byId) }
        }
    }

    /** Reads the `t` discriminator for [key] from a typed config, or null. */
    private fun settingType(cfg: JsonObject, key: String): Int? {
        val config = cfg["config"] as? JsonObject ?: return null
        val f = config["f"] as? JsonObject ?: return null
        val setting = f[key] as? JsonObject ?: return null
        return (setting["t"] as? JsonPrimitive)?.intOrNull
    }

    /**
     * Canonicalises a decoded corpus value to the target setting's native Kotlin type. kotlinx
     * decodes a JSON integer literal as `Int`; a `t:3` (double) setting needs its value / default
     * / expected as `Double` so equality holds across the OverrideEval class-equality check.
     * Non-numeric values and non-typed targets pass through unchanged.
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
     * exact regardless of how kotlinx decoded the JSON literal.
     */
    private fun runTypedTuple(tuple: JsonObject, configsById: Map<String, JsonObject>) {
        val description = tuple["description"]!!.jsonPrimitive.content
        val configId = tuple["configId"]!!.jsonPrimitive.content
        val cfg = configsById[configId]
            ?: throw AssertionError(
                "typed corpus references unknown configId=$configId; regenerate fixtures",
            )

        val key = tuple["key"]!!.jsonPrimitive.content
        val t = settingType(cfg, key)

        val rawOverrides = decodeOverridesMap(cfg["overridesMap"])
        val overridesMap = LinkedHashMap<String, Any>(rawOverrides.size)
        for ((k, v) in rawOverrides) {
            val canon = canonicalise(v, settingType(cfg, k)) ?: continue
            overridesMap[k] = canon
        }

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overridesMap)))
            .build()
        try {
            val defaultValue = canonicalise(decodeJsonElement(tuple["defaultValue"]), t)
            val expected = canonicalise(decodeJsonElement(tuple["expected"]), t)
            val user = buildUser(tuple["user"])
            val actual = runBlocking { client.getValue(key, defaultValue, user) }
            assertEquals(
                expected,
                actual,
                "Typed parity drift on $description — investigate Evaluator / OverrideEval, do " +
                    "NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
            )
        } finally {
            client.close()
        }
    }

    @TestFactory
    fun corpusBranches(): List<DynamicTest> {
        val tuples = loadList(WorkspaceRoot.parityCorpusPath())
        val configs = loadList(WorkspaceRoot.parityConfigsPath())

        assertEquals(
            58,
            tuples.size,
            "Expected 58 corpus tuples; regenerate via `pnpm run export:corpus` in " +
                "packages/test-fixtures-sdk-parity/.",
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
                "corpus references unknown configId=$configId; regenerate fixtures",
            )

        val overridesMap = decodeOverridesMap(cfg["overridesMap"])

        val client = ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(overridesMap)))
            .build()
        try {
            val key = tuple["key"]!!.jsonPrimitive.content
            val defaultValue = decodeJsonElement(tuple["defaultValue"])
            val expected = decodeJsonElement(tuple["expected"])
            val user = buildUser(tuple["user"])
            val actual = runBlocking { client.getValue(key, defaultValue, user) }
            assertEquals(
                expected,
                actual,
                "Parity drift on $description — investigate Evaluator / OverrideEval, do NOT " +
                    "mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
            )
        } finally {
            client.close()
        }
    }

    /** Decodes the corpus `overridesMap` (JSON object) into a `Map<String, Any>` accepted by
     *  [MapOverrideDataSource]. Nullable slots are dropped (Branch 5 covers the null path
     *  independently).
     */
    private fun decodeOverridesMap(raw: JsonElement?): Map<String, Any> {
        if (raw == null || raw is JsonNull || raw !is JsonObject) return emptyMap()
        val out = LinkedHashMap<String, Any>(raw.size)
        for ((k, v) in raw) {
            val decoded = decodeJsonElement(v) ?: continue
            out[k] = decoded
        }
        return out
    }

    /** Builds a [User] from the corpus `user` slot, or returns null. */
    private fun buildUser(raw: JsonElement?): User? {
        if (raw == null || raw is JsonNull || raw !is JsonObject) return null
        val identifier = raw["identifier"]?.jsonPrimitive?.contentOrNull ?: ""
        val email = (raw["email"] as? JsonPrimitive)?.contentOrNull
        val country = (raw["country"] as? JsonPrimitive)?.contentOrNull
        val customRaw = raw["custom"]
        val custom: Map<String, String> = if (customRaw is JsonObject) {
            val cm = LinkedHashMap<String, String>(customRaw.size)
            for ((k, v) in customRaw) {
                if (v is JsonPrimitive) {
                    v.contentOrNull?.let { cm[k] = it }
                }
            }
            cm
        } else {
            emptyMap()
        }
        return User(identifier = identifier, email = email, country = country, custom = custom)
    }

    /** Recursively decodes a kotlinx JsonElement into Kotlin primitives / List / Map. Mirrors
     *  the canonical Jackson decoding the JVM Java SDK uses so corpus tuples compare equal.
     */
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
