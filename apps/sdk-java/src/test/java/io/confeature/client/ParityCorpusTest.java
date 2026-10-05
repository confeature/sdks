// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.Evaluator;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * Spec 045 US1 parity gate — 58/58 byte-identical to ConfigCat.
 *
 * <p>Loads the TS-generated parity corpus + canonical configs from {@code
 * packages/test-fixtures-sdk-parity/fixtures/}, builds one {@link ConfeatureClient} per tuple with
 * {@code manualPoll() + FlagOverrides.localOnly(...)}, and asserts byte-identical evaluation
 * against the {@code expected} value.
 *
 * <p>Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST pass. If a tuple drifts, STOP
 * and investigate the override-eval / evaluator code — never mutate the corpus to make the test
 * green.
 *
 * <p>Type-coercion note: Jackson's default {@code Object} deserialiser decodes JSON numbers as
 * {@link Integer} when they fit, then {@link Long}, then {@link Double}. Corpus default values are
 * exclusively {@link Boolean}, {@link String}, {@link Integer} (e.g. default=42), and {@link
 * Double}, so {@code assertThat(actual).isEqualTo(expected)} holds across the canonical variants.
 */
final class ParityCorpusTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final String PARITY_SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /**
   * Spec 069 US2 typed-parity gate — the 13-tuple {@code parity-corpus-typed.json} corpus, spanning
   * the {@code string} / {@code int} / {@code double} SettingTypes (plus the TYPE_MISMATCH tuples).
   * Runs the same {@code manualPoll() + :memory: + LocalOnly} consumption mode as the boolean tier.
   * Numeric corpus values are canonicalised to the target setting's native JVM type ({@code
   * t:2→Integer}, {@code t:3→Double}) so boxed equality holds.
   */
  @TestFactory
  Stream<DynamicTest> typedCorpusBranches() throws Exception {
    final List<Map<String, Object>> tuples =
        loadList(WorkspaceRoot.parityCorpusTypedPath().toString());
    final List<Map<String, Object>> configs =
        loadList(WorkspaceRoot.parityConfigsTypedPath().toString());

    assertEquals(
        13,
        tuples.size(),
        "Expected 13 typed corpus tuples; regenerate via "
            + "`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.");

    final Map<String, Map<String, Object>> byId = new HashMap<>();
    for (Map<String, Object> cfg : configs) {
      byId.put((String) cfg.get("id"), cfg);
    }

    return tuples.stream()
        .map(
            tuple ->
                DynamicTest.dynamicTest(
                    (String) tuple.get("description"), () -> runTypedTuple(tuple, byId)));
  }

  /** Reads the {@code t} discriminator for {@code key} from a typed config, or {@code null}. */
  @SuppressWarnings("unchecked")
  private static Integer settingType(Map<String, Object> cfg, String key) {
    final Object configAny = cfg.get("config");
    if (!(configAny instanceof Map)) {
      return null;
    }
    final Object fAny = ((Map<String, Object>) configAny).get("f");
    if (!(fAny instanceof Map)) {
      return null;
    }
    final Object settingAny = ((Map<String, Object>) fAny).get(key);
    if (!(settingAny instanceof Map)) {
      return null;
    }
    final Object t = ((Map<String, Object>) settingAny).get("t");
    return t instanceof Number ? ((Number) t).intValue() : null;
  }

  /**
   * Canonicalises a corpus value to the target setting's native JVM type. Jackson decodes every
   * JSON integer literal as {@code Integer}; a {@code t:3} (double) setting needs its value /
   * default / expected as {@code Double} so boxed {@code equals} holds across the OverrideEval
   * class-equality check. Non-numeric values and non-typed targets pass through unchanged — a
   * string default against an {@code int} setting (a TYPE_MISMATCH tuple) is left as a {@code
   * String}.
   */
  private static Object canonicalise(Object value, Integer settingType) {
    if (settingType == null || !(value instanceof Number)) {
      return value;
    }
    if (settingType == Evaluator.SETTING_TYPE_DOUBLE) {
      return ((Number) value).doubleValue();
    }
    if (settingType == Evaluator.SETTING_TYPE_INT) {
      return ((Number) value).intValue();
    }
    return value;
  }

  /**
   * Runs one typed-corpus tuple. Mirrors {@link #runTuple} but canonicalises the override map, the
   * default, and the expected value to the target setting's native JVM type so boxed equality is
   * exact regardless of how Jackson decoded the JSON literal.
   */
  private static void runTypedTuple(
      Map<String, Object> tuple, Map<String, Map<String, Object>> configsById) {
    final String configId = (String) tuple.get("configId");
    final Map<String, Object> cfg = configsById.get(configId);
    if (cfg == null) {
      throw new AssertionError(
          "typed corpus references unknown configId=" + configId + "; regenerate fixtures");
    }

    final String key = (String) tuple.get("key");
    final Integer t = settingType(cfg, key);

    @SuppressWarnings("unchecked")
    final Map<String, Object> rawOverrides =
        cfg.get("overridesMap") instanceof Map
            ? (Map<String, Object>) cfg.get("overridesMap")
            : new LinkedHashMap<>();
    final Map<String, Object> overridesMap = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : rawOverrides.entrySet()) {
      overridesMap.put(e.getKey(), canonicalise(e.getValue(), settingType(cfg, e.getKey())));
    }

    final ConfeatureClient client =
        ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overridesMap)))
            .build();
    try {
      final Object defaultValue = canonicalise(tuple.get("defaultValue"), t);
      final Object expected = canonicalise(tuple.get("expected"), t);
      final User user = buildUser(tuple.get("user"));
      final Object actual = client.getValue(key, defaultValue, user);
      assertThat(actual)
          .as(
              "Typed parity drift on %s — investigate Evaluator / OverrideEval, "
                  + "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
              tuple.get("description"))
          .isEqualTo(expected);
    } finally {
      client.close();
    }
  }

  @TestFactory
  Stream<DynamicTest> corpusBranches() throws Exception {
    final List<Map<String, Object>> tuples = loadList(WorkspaceRoot.parityCorpusPath().toString());
    final List<Map<String, Object>> configs =
        loadList(WorkspaceRoot.parityConfigsPath().toString());

    assertEquals(
        58,
        tuples.size(),
        "Expected 58 corpus tuples; regenerate via "
            + "`pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.");

    final Map<String, Map<String, Object>> byId = new HashMap<>();
    for (Map<String, Object> cfg : configs) {
      byId.put((String) cfg.get("id"), cfg);
    }

    return tuples.stream()
        .map(
            tuple ->
                DynamicTest.dynamicTest(
                    (String) tuple.get("description"), () -> runTuple(tuple, byId)));
  }

  private static void runTuple(
      Map<String, Object> tuple, Map<String, Map<String, Object>> configsById) {
    final String configId = (String) tuple.get("configId");
    final Map<String, Object> cfg = configsById.get(configId);
    if (cfg == null) {
      throw new AssertionError(
          "corpus references unknown configId=" + configId + "; regenerate fixtures");
    }

    @SuppressWarnings("unchecked")
    final Map<String, Object> overridesMap =
        cfg.get("overridesMap") instanceof Map
            ? (Map<String, Object>) cfg.get("overridesMap")
            : new LinkedHashMap<>();

    final ConfeatureClient client =
        ConfeatureClient.builder(PARITY_SDK_KEY)
            .pollingMode(PollingMode.manualPoll())
            .cacheDirectory(":memory:")
            .flagOverrides(FlagOverrides.localOnly(new MapOverrideDataSource(overridesMap)))
            .build();
    try {
      final String key = (String) tuple.get("key");
      final Object defaultValue = tuple.get("defaultValue");
      final User user = buildUser(tuple.get("user"));
      final Object actual = client.getValue(key, defaultValue, user);
      assertThat(actual)
          .as(
              "Parity drift on %s — investigate Evaluator / OverrideEval, "
                  + "do NOT mutate the corpus (Constitution Principle II is NON-NEGOTIABLE).",
              tuple.get("description"))
          .isEqualTo(tuple.get("expected"));
    } finally {
      client.close();
    }
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
        if (e.getValue() instanceof String) {
          custom.put(e.getKey(), e.getValue());
        }
      }
      b.custom(custom);
    }
    return b.build();
  }

  private static List<Map<String, Object>> loadList(String path) throws Exception {
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> list =
        MAPPER.readValue(Files.readAllBytes(java.nio.file.Paths.get(path)), List.class);
    return list;
  }
}
