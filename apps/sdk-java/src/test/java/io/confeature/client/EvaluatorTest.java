// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.internal.Evaluator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class EvaluatorTest {

  /**
   * Wraps a settings map ({@code {key: setting}}) in a full {@code config_v6} root ({@code
   * {p,f,s}}), matching the post-spec-126 {@code Evaluator.evaluate} contract (it consumes the full
   * config and reads {@code config.f}, no longer the bare settings map).
   */
  private static Map<String, Object> config(Map<String, Object> settings) {
    final Map<String, Object> root = new LinkedHashMap<>();
    root.put("f", settings);
    return root;
  }

  private static Map<String, Object> booleanConfig(boolean value) {
    final Map<String, Object> setting = new LinkedHashMap<>();
    setting.put("t", 0);
    final Map<String, Object> v = new HashMap<>();
    v.put("b", value);
    setting.put("v", v);
    final Map<String, Object> f = new LinkedHashMap<>();
    f.put("flag", setting);
    return config(f);
  }

  /** Builds a single-flag config of arbitrary {@code SettingType} ({@code t}) and value slot. */
  private static Map<String, Object> typedConfig(int t, String valueSlotKey, Object value) {
    final Map<String, Object> setting = new LinkedHashMap<>();
    setting.put("t", t);
    final Map<String, Object> v = new HashMap<>();
    v.put(valueSlotKey, value);
    setting.put("v", v);
    final Map<String, Object> f = new LinkedHashMap<>();
    f.put("flag", setting);
    return config(f);
  }

  @Test
  void evaluate_happyPathReturnsBoolean() {
    final Evaluator.Result r = Evaluator.evaluate(booleanConfig(true), "flag", false, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(true);
  }

  @Test
  void evaluate_keyMissingReturnsDefault() {
    final Evaluator.Result r = Evaluator.evaluate(booleanConfig(true), "other.flag", false, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.KEY_NOT_FOUND);
    assertThat(r.getValue()).isEqualTo(false);
  }

  @Test
  void evaluate_nullConfigReturnsDefault() {
    final Evaluator.Result r = Evaluator.evaluate(null, "flag", true, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NO_CONFIG);
    assertThat(r.getValue()).isEqualTo(true);
  }

  @Test
  void evaluate_typeMismatchReturnsDefault() {
    // Default is a string but the setting is boolean — fail-closed.
    final Evaluator.Result r = Evaluator.evaluate(booleanConfig(true), "flag", "fallback", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.TYPE_MISMATCH);
    assertThat(r.getValue()).isEqualTo("fallback");
  }

  @Test
  void evaluate_unsupportedTypeReturnsDefault() {
    // t:9 is not one of the four known SettingTypes (0/1/2/3) — fail-closed.
    final Map<String, Object> setting = new LinkedHashMap<>();
    setting.put("t", 9);
    setting.put("v", new HashMap<>());
    final Map<String, Object> f = new LinkedHashMap<>();
    f.put("flag", setting);
    final Evaluator.Result r = Evaluator.evaluate(config(f), "flag", false, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.UNSUPPORTED_TYPE);
    assertThat(r.getValue()).isEqualTo(false);
  }

  @Test
  void evaluate_missingValueSlotReturnsDefault() {
    final Map<String, Object> setting = new LinkedHashMap<>();
    setting.put("t", 0);
    // missing "v"
    final Map<String, Object> f = new LinkedHashMap<>();
    f.put("flag", setting);
    final Evaluator.Result r = Evaluator.evaluate(config(f), "flag", true, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_VALUE);
    assertThat(r.getValue()).isEqualTo(true);
  }

  @Test
  void evaluate_malformedSettingShapeReturnsDefault() {
    final Map<String, Object> f = new LinkedHashMap<>();
    f.put("flag", "not a map");
    final Evaluator.Result r = Evaluator.evaluate(config(f), "flag", false, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_CONFIG);
    assertThat(r.getValue()).isEqualTo(false);
  }

  // --- typed-value paths (spec 069 / #256): string / int / double SettingTypes ---

  @Test
  void evaluate_stringSettingResolvesToString() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", "fallback", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo("hello");
  }

  @Test
  void evaluate_emptyStringSettingResolvesToEmptyString() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(1, "s", ""), "flag", "fallback", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo("");
  }

  @Test
  void evaluate_intSettingResolvesToInteger() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(2, "i", 5), "flag", -1, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(5);
  }

  @Test
  void evaluate_zeroIntSettingResolvesToZero() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(2, "i", 0), "flag", -1, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(0);
  }

  @Test
  void evaluate_negativeIntSettingResolvesToNegative() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(2, "i", -3), "flag", 0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(-3);
  }

  @Test
  void evaluate_intSettingDecodedAsLongStillResolvesToInteger() {
    // Jackson may decode a JSON integer as Long — readInt coerces permissively.
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(2, "i", 7L), "flag", -1, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(7);
  }

  @Test
  void evaluate_doubleSettingResolvesToDouble() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", 1.0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(0.25);
  }

  @Test
  void evaluate_negativeDoubleSettingResolvesToNegative() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(3, "d", -273.15), "flag", 0.0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(-273.15);
  }

  @Test
  void evaluate_precisionSensitiveDoubleResolvesExactly() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(3, "d", 0.30000000000000004), "flag", 0.0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.NONE);
    assertThat(r.getValue()).isEqualTo(0.30000000000000004);
  }

  @Test
  void evaluate_stringSettingWithNumberDefaultReturnsTypeMismatch() {
    final Evaluator.Result r = Evaluator.evaluate(typedConfig(1, "s", "hello"), "flag", 0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.TYPE_MISMATCH);
    assertThat(r.getValue()).isEqualTo(0);
  }

  @Test
  void evaluate_intSettingWithStringDefaultReturnsTypeMismatch() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(2, "i", 5), "flag", "not-a-number", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.TYPE_MISMATCH);
    assertThat(r.getValue()).isEqualTo("not-a-number");
  }

  @Test
  void evaluate_doubleSettingWithStringDefaultReturnsTypeMismatch() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(3, "d", 0.25), "flag", "not-a-number", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.TYPE_MISMATCH);
    assertThat(r.getValue()).isEqualTo("not-a-number");
  }

  @Test
  void evaluate_stringSettingWithMissingValueSlotReturnsMalformed() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(1, "wrong", "hello"), "flag", "fallback", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_VALUE);
    assertThat(r.getValue()).isEqualTo("fallback");
  }

  @Test
  void evaluate_stringSettingWithWrongTypedValueReturnsMalformed() {
    // t:1 string but v.s holds a number — fail-closed.
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(1, "s", 42), "flag", "fallback", null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_VALUE);
    assertThat(r.getValue()).isEqualTo("fallback");
  }

  @Test
  void evaluate_intSettingWithNonNumericValueReturnsMalformed() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(2, "i", "not-a-number"), "flag", -1, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_VALUE);
    assertThat(r.getValue()).isEqualTo(-1);
  }

  @Test
  void evaluate_doubleSettingWithNonNumericValueReturnsMalformed() {
    final Evaluator.Result r =
        Evaluator.evaluate(typedConfig(3, "d", "not-a-number"), "flag", 1.0, null);
    assertThat(r.getError()).isEqualTo(Evaluator.Error.MALFORMED_VALUE);
    assertThat(r.getValue()).isEqualTo(1.0);
  }
}
