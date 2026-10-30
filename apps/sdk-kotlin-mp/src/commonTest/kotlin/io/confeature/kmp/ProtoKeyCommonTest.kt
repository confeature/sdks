// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.extractSettingsMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #826 on every target, JS included, where a Kotlin map is backed by a JS object and a key named
 * `__proto__` is the one that could fall onto a prototype. Parses a served config_v6 body the way
 * the client does and evaluates through [Snapshot], the same override-first / evaluator flow as
 * [ConfeatureClient.getValue]. The JVM-only [ProtoKeyTest] covers the HTTP path.
 */
class ProtoKeyCommonTest {

    private val served = "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"}," +
        "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}"

    @Test
    fun servedProtoFlagReturnsItsServedValue() {
        val parsed = extractSettingsMap(Json.parseToJsonElement(served).jsonObject)
        assertEquals(setOf("__proto__"), parsed?.keys)
        val settings = HashMap<String, Any?>()
        settings["__proto__"] = mapOf("t" to 0, "v" to mapOf("b" to true), "i" to "v-proto")
        val s = Snapshot(settings, mapOf("f" to settings), null, null)
        assertEquals(true, s.getValue("__proto__", false))
        assertEquals(listOf("__proto__"), s.getAllKeys().toList())
    }

    @Test
    fun localOnlyOverrideKeyedProtoReturnsTheOverride() {
        val fo = FlagOverrides.localOnly(MapOverrideDataSource(mapOf("__proto__" to true)))
        val s = Snapshot(emptyMap(), mapOf("f" to emptyMap<String, Any?>()), fo, null)
        assertEquals(true, s.getValue("__proto__", false))
        assertEquals(false, s.getValue("constructor", false))
    }
}
