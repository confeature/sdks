// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.Evaluator
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Boolean-evaluator parity gate. Mirrors `apps/sdk-java/.../EvaluatorTest.java` 1:1 — runs on every
 * platform via `kotlin-test`.
 */
class EvaluatorTest {

    /** Wraps a settings map (`{key: setting}`) into the full `config_v6` root the evaluator reads. */
    private fun config(settings: Map<String, Any?>): Map<String, Any?> = mapOf("f" to settings)

    private fun booleanConfig(value: Boolean): Map<String, Any?> = config(
        mapOf(
            "flag" to mapOf(
                "t" to 0,
                "v" to mapOf("b" to value),
            ),
        ),
    )

    /** Builds a single-flag config of arbitrary SettingType (`t`) and value slot. */
    private fun typedConfig(t: Int, valueSlotKey: String, value: Any?): Map<String, Any?> = config(
        mapOf(
            "flag" to mapOf(
                "t" to t,
                "v" to mapOf(valueSlotKey to value),
            ),
        ),
    )

    @Test
    fun evaluate_happyPathReturnsBoolean() {
        val r = Evaluator.evaluate(booleanConfig(true), "flag", false, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(true, r.value)
    }

    @Test
    fun evaluate_keyMissingReturnsDefault() {
        val r = Evaluator.evaluate(booleanConfig(true), "other.flag", false, null)
        assertEquals(Evaluator.Error.KEY_NOT_FOUND, r.error)
        assertEquals(false, r.value)
    }

    @Test
    fun evaluate_nullConfigReturnsDefault() {
        val r = Evaluator.evaluate(null, "flag", true, null)
        assertEquals(Evaluator.Error.NO_CONFIG, r.error)
        assertEquals(true, r.value)
    }

    @Test
    fun evaluate_typeMismatchReturnsDefault() {
        // Default is a string but the setting is boolean — fail-closed.
        val r = Evaluator.evaluate(booleanConfig(true), "flag", "fallback", null)
        assertEquals(Evaluator.Error.TYPE_MISMATCH, r.error)
        assertEquals("fallback", r.value)
    }

    @Test
    fun evaluate_unsupportedTypeReturnsDefault() {
        // t:9 is not one of the four known SettingTypes (0/1/2/3) — fail-closed.
        val settings = config(
            mapOf("flag" to mapOf("t" to 9, "v" to emptyMap<String, Any?>())),
        )
        val r = Evaluator.evaluate(settings, "flag", false, null)
        assertEquals(Evaluator.Error.UNSUPPORTED_TYPE, r.error)
        assertEquals(false, r.value)
    }

    @Test
    fun evaluate_missingValueSlotReturnsDefault() {
        val settings = config(mapOf("flag" to mapOf("t" to 0)))
        val r = Evaluator.evaluate(settings, "flag", true, null)
        assertEquals(Evaluator.Error.MALFORMED_VALUE, r.error)
        assertEquals(true, r.value)
    }

    @Test
    fun evaluate_malformedSettingShapeReturnsDefault() {
        val settings = config(mapOf("flag" to "not a map"))
        val r = Evaluator.evaluate(settings, "flag", false, null)
        assertEquals(Evaluator.Error.MALFORMED_CONFIG, r.error)
        assertEquals(false, r.value)
    }

    @Test
    fun evaluate_nullBooleanDefaultIsTolerated() {
        val r = Evaluator.evaluate(booleanConfig(true), "flag", null, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(true, r.value)
    }

    // --- typed-value paths (spec 069 / #256): string / int / double SettingTypes ---

    @Test
    fun evaluate_stringSettingResolvesToString() {
        val r = Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", "fallback", null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals("hello", r.value)
    }

    @Test
    fun evaluate_emptyStringSettingResolvesToEmptyString() {
        val r = Evaluator.evaluate(typedConfig(1, "s", ""), "flag", "fallback", null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals("", r.value)
    }

    @Test
    fun evaluate_intSettingResolvesToInt() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 5), "flag", -1, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(5, r.value)
    }

    @Test
    fun evaluate_zeroIntSettingResolvesToZero() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 0), "flag", -1, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(0, r.value)
    }

    @Test
    fun evaluate_negativeIntSettingResolvesToNegative() {
        val r = Evaluator.evaluate(typedConfig(2, "i", -3), "flag", 0, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(-3, r.value)
    }

    @Test
    fun evaluate_intSettingDecodedAsLongStillResolvesToInt() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 7L), "flag", -1, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(7, r.value)
    }

    @Test
    fun evaluate_doubleSettingResolvesToDouble() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", 1.0, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(0.25, r.value)
    }

    @Test
    fun evaluate_negativeDoubleSettingResolvesToNegative() {
        val r = Evaluator.evaluate(typedConfig(3, "d", -273.15), "flag", 0.0, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(-273.15, r.value)
    }

    @Test
    fun evaluate_precisionSensitiveDoubleResolvesExactly() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.30000000000000004), "flag", 0.0, null)
        assertEquals(Evaluator.Error.NONE, r.error)
        assertEquals(0.30000000000000004, r.value)
    }

    @Test
    fun evaluate_stringSettingWithNumberDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", 0, null)
        assertEquals(Evaluator.Error.TYPE_MISMATCH, r.error)
        assertEquals(0, r.value)
    }

    @Test
    fun evaluate_intSettingWithStringDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 5), "flag", "not-a-number", null)
        assertEquals(Evaluator.Error.TYPE_MISMATCH, r.error)
        assertEquals("not-a-number", r.value)
    }

    @Test
    fun evaluate_doubleSettingWithStringDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", "not-a-number", null)
        assertEquals(Evaluator.Error.TYPE_MISMATCH, r.error)
        assertEquals("not-a-number", r.value)
    }

    @Test
    fun evaluate_stringSettingWithMissingValueSlotReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(1, "wrong", "hello"), "flag", "fallback", null)
        assertEquals(Evaluator.Error.MALFORMED_VALUE, r.error)
        assertEquals("fallback", r.value)
    }

    @Test
    fun evaluate_stringSettingWithWrongTypedValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(1, "s", 42), "flag", "fallback", null)
        assertEquals(Evaluator.Error.MALFORMED_VALUE, r.error)
        assertEquals("fallback", r.value)
    }

    @Test
    fun evaluate_intSettingWithNonNumericValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(2, "i", "not-a-number"), "flag", -1, null)
        assertEquals(Evaluator.Error.MALFORMED_VALUE, r.error)
        assertEquals(-1, r.value)
    }

    @Test
    fun evaluate_doubleSettingWithNonNumericValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(3, "d", "not-a-number"), "flag", 1.0, null)
        assertEquals(Evaluator.Error.MALFORMED_VALUE, r.error)
        assertEquals(1.0, r.value)
    }
}
