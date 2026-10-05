// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Targeting-rule parity (spec 135 / #430, epic #382, US3) — the {@code CORPUS_RULES} corpus
 * injected through the full-config offline override.
 *
 * <p>Unlike the flat {@code parity-corpus} / {@code parity-corpus-typed} corpora (which feed a
 * value-only {@code overridesMap} via {@link MapOverrideDataSource}), the rule corpus carries the
 * whole {@code {p, f, s}} config and is injected via {@link FlagOverrides#localConfig} + {@link
 * OverrideBehaviour#LOCAL_ONLY}. The SDK then resolves targeting rules / segments / % options
 * offline through the real Java evaluator, exactly as it would against a CDN-served config — no
 * network round-trip.
 *
 * <p>Runner contract (mirrors {@code apps/sdk-node/tests/parity/parity-rules.test.ts}, sdk-python's
 * {@code test_parity_rules.py}, sdk-dotnet's {@code ParityRulesTests.cs}): every tuple branches on
 * the config's {@code injectionMode}:
 *
 * <ul>
 *   <li>{@code "full-config"} → capability-probe {@link FlagOverrides#localConfig}. If sdk-java
 *       exposes it, build the override and assert the PUBLIC {@code client.getValue} returns {@code
 *       tuple.expected}. If it does NOT, SKIP with a reason — NEVER fall back to the flat-map path
 *       (SC-004: no {@code "full-config"} tuple is ever resolved on the map path, and a skip is
 *       reported with its reason).
 * </ul>
 *
 * <p>sdk-java HAS adopted the full-config path, so every loaded rule tuple runs and passes; there
 * are no skips for this family.
 *
 * <p>AC4: if a tuple fails because of a real Java evaluator targeting-rule gap (not override
 * wiring), STOP and file a discrete #382 follow-up — never a corpus or test workaround.
 */
final class ParityRulesTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final String PARITY_SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /**
   * Capability probe: does this SDK expose the in-memory full-config override factory {@link
   * FlagOverrides#localConfig}? The full-config path is gated on this — never silently resolved on
   * the flat-map path (SC-004 / AC4).
   */
  private static final Method LOCAL_CONFIG_FACTORY = probeLocalConfigFactory();

  private static Method probeLocalConfigFactory() {
    try {
      return FlagOverrides.class.getMethod("localConfig", Map.class, OverrideBehaviour.class);
    } catch (NoSuchMethodException e) {
      return null;
    }
  }

  private static boolean hasFullConfigOverrides() {
    return LOCAL_CONFIG_FACTORY != null;
  }

  @TestFactory
  Stream<DynamicTest> ruleCorpusBranches() throws Exception {
    final List<Map<String, Object>> tuples =
        loadList(WorkspaceRoot.parityCorpusRulesPath().toString());
    final List<Map<String, Object>> configs =
        loadList(WorkspaceRoot.parityConfigsRulesPath().toString());

    // Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
    // foundational #383 tuples are never removed) and grows with every
    // comparator spec, so we assert only that the fixture actually loaded —
    // not a hardcoded total that re-trips on every growth. Per-tuple
    // correctness is covered by the per-tuple dynamic tests below, and
    // JSON↔TS sync is owned by the central `check:exports` gate, so this
    // guard is purely a non-empty smoke and never needs a per-spec bump.
    assertTrue(
        tuples.size() >= 8,
        "rule corpus is non-empty (append-only floor: at least the 8 foundational rule tuples); "
            + "got "
            + tuples.size()
            + " — looks empty/truncated, regenerate via `pnpm run export:corpus` in "
            + "packages/test-fixtures-sdk-parity/.");

    final Map<String, Map<String, Object>> byId = new HashMap<>();
    for (Map<String, Object> cfg : configs) {
      byId.put((String) cfg.get("id"), cfg);
    }

    return tuples.stream()
        .map(
            tuple ->
                DynamicTest.dynamicTest(
                    (String) tuple.get("description"), () -> runRuleTuple(tuple, byId)));
  }

  private static void runRuleTuple(
      Map<String, Object> tuple, Map<String, Map<String, Object>> configsById) {
    final String configId = (String) tuple.get("configId");
    final Map<String, Object> configRecord = configsById.get(configId);
    if (configRecord == null) {
      throw new AssertionError(
          "rule corpus references unknown configId=" + configId + "; regenerate fixtures");
    }

    final String injectionMode = (String) configRecord.get("injectionMode");
    // The rule corpus is full-config only; a flat-map tuple here would mean a
    // corpus regression, never a silent flat-map fallback (SC-004).
    assertThat(injectionMode)
        .as("rule corpus tuple %s must be full-config (SC-004)", tuple.get("description"))
        .isEqualTo("full-config");

    if (!hasFullConfigOverrides()) {
      // SC-004: NEVER fall back to the flat-map path — skip with a reason so a
      // CI run surfaces it explicitly rather than false-greening on the map path.
      Assumptions.abort("SDK has not adopted full-config overrides");
    }

    @SuppressWarnings("unchecked")
    final Map<String, Object> config = (Map<String, Object>) configRecord.get("config");

    final ConfeatureClient client =
        ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localConfig(config, OverrideBehaviour.LOCAL_ONLY))
            .build();
    try {
      final String key = (String) tuple.get("key");
      // Type the default to the setting's `t` (t=2 → Integer, t=3 → Double) so
      // the evaluator's TYPE_MISMATCH guard is satisfied for the numeric
      // settings (the int-vs-double contract stays STRICT — Principle II — the
      // runner adapts, the evaluator never relaxes). All other types pass the
      // corpus default through unchanged.
      final Object defaultValue = typedDefault(tuple.get("defaultValue"), settingType(config, key));
      final User user = buildUser(tuple.get("user"));
      final Object expected = tuple.get("expected");

      final boolean assertVariationId = tuple.containsKey("expectedVariationId");
      final Object actual;
      if (assertVariationId) {
        // Assert against the PUBLIC getValueDetails surface (Principle II): it
        // carries both the resolved value and the matched option's variationId.
        final EvaluationDetails<Object> details = client.getValueDetails(key, defaultValue, user);
        actual = details.getValue();
        assertThat(details.getVariationId())
            .as(
                "variationId parity drift on %s — getValueDetails().getVariationId() must match "
                    + "the corpus expectedVariationId. If this propagated as null through the "
                    + "full-config override path, fix the override→getValueDetails wiring "
                    + "(the #395 gap class); do NOT mutate the corpus.",
                tuple.get("description"))
            .isEqualTo(tuple.get("expectedVariationId"));
      } else {
        actual = client.getValue(key, defaultValue, user);
      }

      assertParityValue(actual, expected, (String) tuple.get("description"));
    } finally {
      client.close();
    }
  }

  /**
   * Asserts the resolved value equals the corpus expected value. Numbers are compared NUMERICALLY
   * (the corpus encodes a whole {@code 1} as a JSON integer while a t=3 DOUBLE setting resolves to
   * {@code 1.0}); every other type is compared structurally.
   */
  private static void assertParityValue(Object actual, Object expected, String description) {
    if (actual instanceof Number && expected instanceof Number) {
      assertThat(((Number) actual).doubleValue())
          .as(
              "Targeting-rule value parity drift on %s — investigate Evaluator / OverrideEval, "
                  + "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
              description)
          .isEqualTo(((Number) expected).doubleValue());
      return;
    }
    assertThat(actual)
        .as(
            "Targeting-rule parity drift on %s — investigate Evaluator / OverrideEval, "
                + "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE). "
                + "If this is a real Java targeting-rule engine gap (not an override-wiring "
                + "bug), STOP and file a discrete #382 follow-up (AC4).",
            description)
        .isEqualTo(expected);
  }

  /**
   * The setting's wire type {@code t} for {@code key} ({@code 0} bool / {@code 1} string / {@code
   * 2} int / {@code 3} double), or {@code -1} when the key is absent / untyped.
   */
  @SuppressWarnings("unchecked")
  private static int settingType(Map<String, Object> config, String key) {
    final Object fObj = config.get("f");
    if (!(fObj instanceof Map)) {
      return -1;
    }
    final Object settingObj = ((Map<String, Object>) fObj).get(key);
    if (!(settingObj instanceof Map)) {
      return -1;
    }
    final Object t = ((Map<String, Object>) settingObj).get("t");
    return t instanceof Number ? ((Number) t).intValue() : -1;
  }

  /**
   * Coerces the corpus default (which JSON-decodes a numeric {@code -1} to an {@link Integer}) to
   * the JVM box matching the setting's wire type {@code t}: t=3 (DOUBLE) → {@link Double}, t=2
   * (INT) → {@link Integer}. This satisfies the evaluator's STRICT int-vs-double TYPE_MISMATCH
   * guard without relaxing the evaluator. Non-numeric defaults and non-numeric settings pass
   * through unchanged.
   */
  private static Object typedDefault(Object corpusDefault, int settingType) {
    if (!(corpusDefault instanceof Number)) {
      return corpusDefault;
    }
    final Number n = (Number) corpusDefault;
    if (settingType == 3) {
      return n.doubleValue();
    }
    if (settingType == 2) {
      return n.intValue();
    }
    return corpusDefault;
  }

  /** The in-memory full-config override factory is exposed on this SDK (no skips). */
  @Test
  void fullConfigFactoryIsExposed() {
    assertThat(hasFullConfigOverrides())
        .as(
            "FlagOverrides.localConfig must be exposed; sdk-java has adopted the in-memory "
                + "full-config override path (#430).")
        .isTrue();
  }

  @SuppressWarnings("unchecked")
  private static User buildUser(Object userField) {
    if (!(userField instanceof Map)) {
      return null;
    }
    final Map<String, Object> m = (Map<String, Object>) userField;
    final String identifier = (String) m.getOrDefault("identifier", "");
    final User.Builder b = User.builder(identifier);
    if (m.get("email") instanceof String) {
      b.email((String) m.get("email"));
    }
    if (m.get("country") instanceof String) {
      b.country((String) m.get("country"));
    }
    if (m.get("custom") instanceof Map) {
      final Map<String, Object> rawCustom = (Map<String, Object>) m.get("custom");
      final Map<String, Object> custom = new LinkedHashMap<>();
      for (Map.Entry<String, Object> e : rawCustom.entrySet()) {
        final Object decoded = decodeTypedAttribute(e.getValue());
        // null attribute → skip (matches the canonical TS harness: absent, never present-as-null).
        if (decoded != null) {
          custom.put(e.getKey(), decoded);
        }
      }
      b.custom(custom);
    }
    return b.build();
  }

  /**
   * Decode the typed-attribute corpus encoding (spec 151) into the JVM value sdk-java's public
   * {@link User} carries, matching ConfigCat's typed custom map:
   *
   * <ul>
   *   <li>string → {@link String}
   *   <li>JSON number → {@link Number} (kept as Jackson's Integer / Long / Double)
   *   <li>bool → {@link Boolean}
   *   <li>array → {@code String[]}
   *   <li>{@code {"$date": <epoch-seconds>}} → {@link java.util.Date} at that instant (seconds →
   *       millis)
   *   <li>{@code {"$num": "NaN"|"Infinity"|"-Infinity"}} → the matching non-finite {@link Double}
   *       ({@link Double#NaN} / {@link Double#POSITIVE_INFINITY} / {@link
   *       Double#NEGATIVE_INFINITY}). This tag (#479, parallel to {@code $date}) carries the
   *       non-finite number-conversion tuples losslessly, because {@code
   *       JSON.stringify(NaN|Infinity|-Infinity)} collapses to a lossy {@code null} in the corpus.
   *       Finite numbers still arrive as a plain JSON {@link Number}.
   *   <li>null → {@code null} (caller skips the entry)
   * </ul>
   */
  @SuppressWarnings("unchecked")
  private static Object decodeTypedAttribute(Object raw) {
    if (raw == null) {
      return null;
    }
    if (raw instanceof Map) {
      final Map<String, Object> obj = (Map<String, Object>) raw;
      if (obj.size() == 1 && obj.containsKey("$date")) {
        final double epochSeconds = ((Number) obj.get("$date")).doubleValue();
        return new java.util.Date(Math.round(epochSeconds * 1000.0));
      }
      if (obj.size() == 1 && obj.containsKey("$num")) {
        // #479: non-finite number sentinel. The corpus encodes the JS literal
        // verbatim; sdk-java's evaluator stringifies the matching Double back to
        // exactly that token (numberToCanonicalString → "NaN"/"Infinity"/
        // "-Infinity"), so the TextEquals(28) comparison matches the oracle.
        final Object s = obj.get("$num");
        if ("NaN".equals(s)) {
          return Double.NaN;
        }
        if ("Infinity".equals(s)) {
          return Double.POSITIVE_INFINITY;
        }
        if ("-Infinity".equals(s)) {
          return Double.NEGATIVE_INFINITY;
        }
        throw new AssertionError("unexpected $num sentinel: " + s);
      }
      throw new AssertionError("unexpected object-typed custom attribute: " + obj);
    }
    if (raw instanceof List) {
      final List<Object> list = (List<Object>) raw;
      final String[] arr = new String[list.size()];
      for (int i = 0; i < list.size(); i++) {
        arr[i] = (String) list.get(i);
      }
      return arr;
    }
    // string / number / boolean pass through as the native JVM box Jackson produced.
    return raw;
  }

  private static List<Map<String, Object>> loadList(String path) throws Exception {
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> list =
        MAPPER.readValue(Files.readAllBytes(java.nio.file.Paths.get(path)), List.class);
    return list;
  }
}
