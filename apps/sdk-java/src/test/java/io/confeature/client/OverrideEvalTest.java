// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.internal.OverrideEval;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class OverrideEvalTest {

  // Branch 1: no overrides → fall through.
  @Test
  void branch1_noOverridesFallsThrough() {
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(null, "key", false);
    assertThat(r.isFound()).isFalse();
    assertThat(r.getValue()).isNull();
  }

  // Branch 2: non-LocalOnly behaviours short-circuit. We can't actually
  // construct a non-LocalOnly behaviour in v1 (the enum declares only
  // LOCAL_ONLY), so this branch is covered by construction — the runtime
  // guard is preserved for forward compatibility.

  // Branch 3: data source returns null → fall through.
  @Test
  void branch3_nullDataSourceMapFallsThrough() {
    final FlagOverrides fo = new FlagOverrides(() -> null, OverrideBehaviour.LOCAL_ONLY);
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "key", false);
    assertThat(r.isFound()).isFalse();
    assertThat(r.getValue()).isNull();
  }

  // Branch 4: key absent → default.
  @Test
  void branch4_keyAbsentReturnsDefault() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("other.key", true);
    final FlagOverrides fo = FlagOverrides.localOnly(new MapOverrideDataSource(overrides));
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "missing.key", false);
    assertThat(r.isFound()).isTrue();
    assertThat(r.getValue()).isEqualTo(false);
  }

  // Branch 5: override slot null → default.
  @Test
  void branch5_nullValueReturnsDefault() {
    final Map<String, Object> overrides = new LinkedHashMap<>();
    overrides.put("nullable", null);
    final FlagOverrides fo = FlagOverrides.localOnly(new MapOverrideDataSource(overrides));
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "nullable", true);
    assertThat(r.isFound()).isTrue();
    assertThat(r.getValue()).isEqualTo(true);
  }

  // Branch 6: type mismatch → default.
  @Test
  void branch6_typeMismatchReturnsDefault() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", "not a boolean");
    final FlagOverrides fo = FlagOverrides.localOnly(new MapOverrideDataSource(overrides));
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "flag", false);
    assertThat(r.isFound()).isTrue();
    assertThat(r.getValue()).isEqualTo(false);
  }

  // Branch 6b: null default bypasses the type check.
  @Test
  void branch6_nullDefaultBypassesTypeCheck() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", "stringy");
    final FlagOverrides fo = FlagOverrides.localOnly(new MapOverrideDataSource(overrides));
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "flag", null);
    assertThat(r.isFound()).isTrue();
    assertThat(r.getValue()).isEqualTo("stringy");
  }

  // Branch 7: happy path → typed override value.
  @Test
  void branch7_happyPathReturnsOverride() {
    final Map<String, Object> overrides = new HashMap<>();
    overrides.put("flag", true);
    final FlagOverrides fo = FlagOverrides.localOnly(new MapOverrideDataSource(overrides));
    final OverrideEval.EvalResult r = OverrideEval.evaluateSync(fo, "flag", false);
    assertThat(r.isFound()).isTrue();
    assertThat(r.getValue()).isEqualTo(true);
  }
}
