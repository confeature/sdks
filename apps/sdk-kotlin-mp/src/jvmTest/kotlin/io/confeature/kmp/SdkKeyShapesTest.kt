// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.SdkKey
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * SDK-key shape gate (#802), JVM target authoritative.
 *
 * Reads the shared `sdk-key-shapes.json` — the ONE accept/reject list every Confeature SDK
 * validator is tested against — and asserts [SdkKey.isValidConfeatureKeyFormat] accepts every
 * `valid` entry and rejects every `invalid` one. Never copy the list into this SDK: add cases to the
 * shared fixture instead.
 */
class SdkKeyShapesTest {

    private fun shapes(bucket: String): List<JsonObject> {
        val raw = String(Files.readAllBytes(WorkspaceRoot.sdkKeyShapesPath()), Charsets.UTF_8)
        val list = Json.parseToJsonElement(raw).jsonObject[bucket]?.jsonArray
            ?: error("sdk-key-shapes.json has no '$bucket' list")
        require(list.isNotEmpty()) { "sdk-key-shapes.json '$bucket' list is empty" }
        return list.map { it.jsonObject }
    }

    private fun JsonObject.field(name: String): String =
        this[name]?.jsonPrimitive?.content ?: error("missing '$name' in sdk-key-shapes entry")

    @TestFactory
    fun acceptsEverySharedValidShape(): List<DynamicTest> = shapes("valid").map { entry ->
        val name = entry.field("name")
        val key = entry.field("key")
        DynamicTest.dynamicTest("valid: $name") {
            assertTrue(
                SdkKey.isValidConfeatureKeyFormat(key),
                "sdk-key-shapes.json valid case '$name' was rejected",
            )
        }
    }

    @TestFactory
    fun rejectsEverySharedInvalidShape(): List<DynamicTest> = shapes("invalid").map { entry ->
        val name = entry.field("name")
        val key = entry.field("key")
        DynamicTest.dynamicTest("invalid: $name") {
            assertFalse(
                SdkKey.isValidConfeatureKeyFormat(key),
                "sdk-key-shapes.json invalid case '$name' was accepted",
            )
        }
    }
}
