// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.Evaluator
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class EvaluatorTest {
    /** Wraps a settings map in the full `config_v6` root (`{f}`) the evaluator now consumes. */
    private fun config(settings: Map<String, Any?>): Map<String, Any?> = mapOf("f" to settings)

    private fun booleanConfig(value: Boolean): Map<String, Any?> {
        return config(mapOf("flag" to mapOf("t" to 0, "v" to mapOf("b" to value))))
    }

    /** Builds a single-flag config of arbitrary SettingType (`t`) and value slot. */
    private fun typedConfig(t: Int, valueSlotKey: String, value: Any?): Map<String, Any?> {
        return config(mapOf("flag" to mapOf("t" to t, "v" to mapOf(valueSlotKey to value))))
    }

    @Test
    fun evaluate_happyPathReturnsBoolean() {
        val r = Evaluator.evaluate(booleanConfig(true), "flag", false, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(true)
    }

    @Test
    fun evaluate_keyMissingReturnsDefault() {
        val r = Evaluator.evaluate(booleanConfig(true), "other.flag", false, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.KEY_NOT_FOUND)
        assertThat(r.value).isEqualTo(false)
    }

    @Test
    fun evaluate_nullConfigReturnsDefault() {
        val r = Evaluator.evaluate(null, "flag", true, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NO_CONFIG)
        assertThat(r.value).isEqualTo(true)
    }

    @Test
    fun evaluate_typeMismatchReturnsDefault() {
        val r = Evaluator.evaluate(booleanConfig(true), "flag", "fallback", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.TYPE_MISMATCH)
        assertThat(r.value).isEqualTo("fallback")
    }

    @Test
    fun evaluate_unsupportedTypeReturnsDefault() {
        // t:9 is not one of the four known SettingTypes (0/1/2/3) — fail-closed.
        val f = config(mapOf("flag" to mapOf("t" to 9, "v" to emptyMap<String, Any?>())))
        val r = Evaluator.evaluate(f, "flag", false, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.UNSUPPORTED_TYPE)
        assertThat(r.value).isEqualTo(false)
    }

    @Test
    fun evaluate_missingValueSlotReturnsDefault() {
        val f = config(mapOf<String, Any?>("flag" to mapOf<String, Any?>("t" to 0)))
        val r = Evaluator.evaluate(f, "flag", true, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_VALUE)
        assertThat(r.value).isEqualTo(true)
    }

    @Test
    fun evaluate_malformedSettingShapeReturnsDefault() {
        val f = config(mapOf<String, Any?>("flag" to "not a map"))
        val r = Evaluator.evaluate(f, "flag", false, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_CONFIG)
        assertThat(r.value).isEqualTo(false)
    }

    // --- typed-value paths (spec 069 / #256): string / int / double SettingTypes ---

    @Test
    fun evaluate_stringSettingResolvesToString() {
        val r = Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", "fallback", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo("hello")
    }

    @Test
    fun evaluate_emptyStringSettingResolvesToEmptyString() {
        val r = Evaluator.evaluate(typedConfig(1, "s", ""), "flag", "fallback", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo("")
    }

    @Test
    fun evaluate_intSettingResolvesToInt() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 5), "flag", -1, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(5)
    }

    @Test
    fun evaluate_zeroIntSettingResolvesToZero() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 0), "flag", -1, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(0)
    }

    @Test
    fun evaluate_negativeIntSettingResolvesToNegative() {
        val r = Evaluator.evaluate(typedConfig(2, "i", -3), "flag", 0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(-3)
    }

    @Test
    fun evaluate_intSettingDecodedAsLongStillResolvesToInt() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 7L), "flag", -1, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(7)
    }

    @Test
    fun evaluate_doubleSettingResolvesToDouble() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", 1.0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(0.25)
    }

    @Test
    fun evaluate_negativeDoubleSettingResolvesToNegative() {
        val r = Evaluator.evaluate(typedConfig(3, "d", -273.15), "flag", 0.0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(-273.15)
    }

    @Test
    fun evaluate_precisionSensitiveDoubleResolvesExactly() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.30000000000000004), "flag", 0.0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.NONE)
        assertThat(r.value).isEqualTo(0.30000000000000004)
    }

    @Test
    fun evaluate_stringSettingWithNumberDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", 0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.TYPE_MISMATCH)
        assertThat(r.value).isEqualTo(0)
    }

    @Test
    fun evaluate_intSettingWithStringDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(2, "i", 5), "flag", "not-a-number", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.TYPE_MISMATCH)
        assertThat(r.value).isEqualTo("not-a-number")
    }

    @Test
    fun evaluate_doubleSettingWithStringDefaultReturnsTypeMismatch() {
        val r = Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", "not-a-number", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.TYPE_MISMATCH)
        assertThat(r.value).isEqualTo("not-a-number")
    }

    @Test
    fun evaluate_stringSettingWithMissingValueSlotReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(1, "wrong", "hello"), "flag", "fallback", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_VALUE)
        assertThat(r.value).isEqualTo("fallback")
    }

    @Test
    fun evaluate_stringSettingWithWrongTypedValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(1, "s", 42), "flag", "fallback", null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_VALUE)
        assertThat(r.value).isEqualTo("fallback")
    }

    @Test
    fun evaluate_intSettingWithNonNumericValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(2, "i", "not-a-number"), "flag", -1, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_VALUE)
        assertThat(r.value).isEqualTo(-1)
    }

    @Test
    fun evaluate_doubleSettingWithNonNumericValueReturnsMalformed() {
        val r = Evaluator.evaluate(typedConfig(3, "d", "not-a-number"), "flag", 1.0, null)
        assertThat(r.error).isEqualTo(Evaluator.Error.MALFORMED_VALUE)
        assertThat(r.value).isEqualTo(1.0)
    }
}
