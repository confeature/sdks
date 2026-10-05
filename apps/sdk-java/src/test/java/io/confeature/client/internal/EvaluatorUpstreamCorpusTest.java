// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.WorkspaceRoot;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * ConfigCat conformance gate (spec 126, SC-001) — the Java engine replays the vendored upstream
 * evaluation matrix. Mirrors the spec-117 TS reference suite ({@code
 * packages/sdk-shared/tests/parity-upstream.test.ts}) and the spec-118..125 Python / Go / Ruby /
 * PHP / .NET / Dart / Elixir / Rust ports. The corpus ({@code
 * packages/test-fixtures-sdk-parity/fixtures/upstream/}, anchor {@code configcat/go-sdk@08c4882} v9
 * — see {@code fixtures/upstream/PROVENANCE.md}) is the oracle: each {@code (config, key, user) →
 * expected} tuple is checked against {@code Evaluator.evaluateWith(...).getValue()} (and {@code
 * getVariationId()} for the variation-id matrix).
 *
 * <p>Scope = the full conformance surface: US1 targeting rules, US2 the 36 comparators, US3
 * percentage rollout, US4 segments / prerequisites (incl. multilevel + circular detection) /
 * AND-groups, US5 attribute conversion + trimming + typed-attribute validation + variationId /
 * matched detail. Per FR-018 only structured value / identity is asserted — never a textual trace.
 *
 * <p>The loaders port {@code packages/test-fixtures-sdk-parity/src/upstream-corpus.ts} faithfully —
 * most critically the Go {@code csv.Reader} LazyQuotes semantics (a {@code "} only opens a quoted
 * field at the field start), without which every JSON-array attribute cell is corrupted. The CSV is
 * parsed by a hand-rolled LazyQuotes reader; a naive split mis-parses the JSON-array cells.
 *
 * <p>Custom attributes are fed through {@link CorpusUserView} (a typed user view the evaluator
 * reads duck-typed) so the conversion-driver cases can deliver numbers / arrays / epochs
 * un-stringified — the public {@code io.confeature.client.User} stringifies custom values by
 * contract (Map&lt;String,String&gt;), which would defeat those cases.
 */
final class EvaluatorUpstreamCorpusTest {

  private static final String NULL_TOKEN = "##null##";

  private static final String PKD = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/";
  private static final String JCP = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/";

  /**
   * {@code dependentFeatureMultipleLevels} is the ONE corpus case whose config blob was NOT
   * captured by the spec-117 vendoring (known DATA gap #401, not an engine gap). The
   * multilevel-prerequisite path IS exercised by the 3-level circular_dep chain + the
   * reconstructed-chain test below. Excluded LOUDLY (the same marker the TS / Python / Ruby / PHP
   * references use), never silently.
   */
  private static final List<String> UNVENDORED_EVAL_LOG_KEYS =
      Arrays.asList("dependentFeatureMultipleLevels");

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private static Map<String, Object> contentByKeyCache;
  private static Map<String, Object> evalLogConfigsCache;

  // -----------------------------------------------------------------------
  // Matrix → SDK key mapping (verbatim from upstream-corpus.ts).
  // -----------------------------------------------------------------------

  private static final class MatrixEntry {
    final String matrix;
    final String sdkKey;
    final boolean variation;

    MatrixEntry(String matrix, String sdkKey, boolean variation) {
      this.matrix = matrix;
      this.sdkKey = sdkKey;
      this.variation = variation;
    }
  }

  private static MatrixEntry matrixEntry(String matrix) {
    final MatrixEntry[] map = {
      new MatrixEntry("testmatrix.csv", PKD + "AG6C1ngVb0CvM07un6JisQ", false),
      new MatrixEntry("testmatrix_semantic.csv", PKD + "iV8vH2MBakKxkFZylxHmTg", false),
      new MatrixEntry("testmatrix_number.csv", PKD + "FCWN-k1dV0iBf8QZrDgjdw", false),
      new MatrixEntry("testmatrix_semantic_2.csv", PKD + "U8nt3zEhDEO5S2ulubCopA", false),
      new MatrixEntry("testmatrix_sensitive.csv", PKD + "-0YmVOUNgEGKkgRF-rU65g", false),
      new MatrixEntry("testmatrix_segments_old.csv", PKD + "y_ZB7o-Xb0Swxth-ZlMSeA", false),
      new MatrixEntry("testmatrix_and_or.csv", JCP + "ByMO9yZNn02kXcm72lnY1A", false),
      new MatrixEntry("testmatrix_comparators_v6.csv", JCP + "OfQqcTjfFUGBwMKqtyEOrQ", false),
      new MatrixEntry("testmatrix_prerequisite_flag.csv", JCP + "JoGwdqJZQ0K2xDy7LnbyOg", false),
      new MatrixEntry("testmatrix_segments.csv", JCP + "h99HYXWWNE2bH8eWyLAVMA", false),
      new MatrixEntry("testmatrix_unicode.csv", JCP + "Da6w8dBbmUeMUBhh0iEeQQ", false),
      new MatrixEntry("testmatrix_variationId.csv", PKD + "spQnkRTIPEWVivZkWM84lQ", true),
    };
    for (final MatrixEntry e : map) {
      if (e.matrix.equals(matrix)) {
        return e;
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Config loaders (cached).
  // -----------------------------------------------------------------------

  private static Map<String, Object> contentByKey() {
    if (contentByKeyCache == null) {
      contentByKeyCache = WorkspaceRoot.upstreamJson("content-by-key.json");
    }
    return contentByKeyCache;
  }

  private static Map<String, Object> evalLogConfigs() {
    if (evalLogConfigsCache == null) {
      evalLogConfigsCache = WorkspaceRoot.upstreamJson("evaluationlog/_configs-by-key.json");
    }
    return evalLogConfigsCache;
  }

  // -----------------------------------------------------------------------
  // CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port). A `"`
  // only opens a quoted field when it is the FIRST char of the field; anywhere
  // else it is a literal quote. Getting this wrong corrupts every JSON-array
  // attribute cell.
  // -----------------------------------------------------------------------

  private static List<String> parseCsvLine(String line) {
    final List<String> fields = new ArrayList<>();
    final StringBuilder field = new StringBuilder();
    boolean inQuotes = false;
    boolean fieldStart = true;
    final int n = line.length();
    int i = 0;
    while (i < n) {
      final char ch = line.charAt(i);
      if (inQuotes && ch == '"' && i + 1 < n && line.charAt(i + 1) == '"') {
        field.append('"');
        i++;
      } else if (inQuotes && ch == '"') {
        inQuotes = false;
      } else if (inQuotes) {
        field.append(ch);
      } else if (ch == '"' && fieldStart) {
        inQuotes = true;
        fieldStart = false;
      } else if (ch == ';') {
        fields.add(field.toString());
        field.setLength(0);
        fieldStart = true;
        i++;
        continue;
      } else {
        field.append(ch);
        fieldStart = false;
      }
      i++;
    }
    fields.add(field.toString());
    return fields;
  }

  /** Parse a CSV cell to its primitive (mirrors upstream {@code parseCell}). */
  private static Object parseCell(String s) {
    if (s.matches("-?\\d+")) {
      try {
        final long v = Long.parseLong(s);
        if (Math.abs(v) <= 9007199254740991L && Long.toString(v).equals(s)) {
          if (v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE) {
            return (int) v;
          }
          return v;
        }
      } catch (NumberFormatException ignored) {
        // fall through
      }
    }
    if (s.matches("-?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")) {
      return Double.parseDouble(s);
    }
    if (s.equals("True")) {
      return Boolean.TRUE;
    }
    if (s.equals("False")) {
      return Boolean.FALSE;
    }
    return s;
  }

  private static String setOrNull(String v) {
    return (v == null || v.isEmpty() || v.equals(NULL_TOKEN)) ? null : v;
  }

  /** Build a CorpusUserView from the first four CSV columns (port {@code userFromRow}). */
  private static CorpusUserView userFromRow(List<String> line, String customKey) {
    if (line.isEmpty() || NULL_TOKEN.equals(line.get(0))) {
      return null;
    }
    final String identifier = line.get(0);
    final String email = setOrNull(get(line, 1));
    final String country = setOrNull(get(line, 2));
    final String customVal = setOrNull(get(line, 3));
    final Map<String, Object> custom;
    if (customVal == null) {
      custom = null;
    } else {
      custom = new LinkedHashMap<>();
      custom.put(customKey, customVal);
    }
    return new CorpusUserView(identifier, email, country, custom);
  }

  private static String get(List<String> list, int idx) {
    return idx < list.size() ? list.get(idx) : null;
  }

  private static final class MatrixTuple {
    final String matrix;
    final String key;
    final CorpusUserView user;
    final boolean variation;
    final Object expected;
    final Map<String, Object> config;

    MatrixTuple(
        String matrix,
        String key,
        CorpusUserView user,
        boolean variation,
        Object expected,
        Map<String, Object> config) {
      this.matrix = matrix;
      this.key = key;
      this.user = user;
      this.variation = variation;
      this.expected = expected;
      this.config = config;
    }
  }

  @SuppressWarnings("unchecked")
  private static List<MatrixTuple> loadMatrix(String matrix) {
    final MatrixEntry entry = matrixEntry(matrix);
    if (entry == null) {
      throw new IllegalStateException("Unknown testmatrix file: " + matrix);
    }
    final Object configAny = contentByKey().get(entry.sdkKey);
    if (!(configAny instanceof Map)) {
      throw new IllegalStateException(
          "No config for matrix " + matrix + " (sdkKey " + entry.sdkKey + ")");
    }
    final Map<String, Object> config = (Map<String, Object>) configAny;

    final String text = WorkspaceRoot.upstreamText(matrix);
    final List<String> lines = new ArrayList<>();
    for (final String l : text.split("\r?\n", -1)) {
      if (!l.isEmpty()) {
        lines.add(l);
      }
    }
    final List<String> header = parseCsvLine(lines.get(0));
    final String customKey = header.size() > 3 ? header.get(3) : "Custom1";
    final List<String> settingKeys = header.subList(4, header.size());

    final List<MatrixTuple> tuples = new ArrayList<>();
    for (int r = 1; r < lines.size(); r++) {
      final List<String> cols = parseCsvLine(lines.get(r));
      final CorpusUserView user = userFromRow(cols, customKey);
      for (int c = 0; c < settingKeys.size(); c++) {
        final String key = settingKeys.get(c);
        final String raw = (c + 4) < cols.size() ? cols.get(c + 4) : "";
        final Object expected = entry.variation ? raw : parseCell(raw);
        tuples.add(new MatrixTuple(matrix, key, user, entry.variation, expected, config));
      }
    }
    return tuples;
  }

  // -----------------------------------------------------------------------
  // evaluationlog/<scenario> (port loadEvalLogScenario).
  // -----------------------------------------------------------------------

  private static CorpusUserView evalLogUser(Map<String, Object> raw) {
    if (raw == null || raw.isEmpty()) {
      return null;
    }
    String identifier = "";
    String email = null;
    String country = null;
    final Map<String, Object> custom = new LinkedHashMap<>();
    for (final Map.Entry<String, Object> e : raw.entrySet()) {
      final Object v = e.getValue();
      switch (e.getKey()) {
        case "Identifier":
          identifier = v == null ? "" : String.valueOf(v);
          break;
        case "Email":
          email = v == null ? null : String.valueOf(v);
          break;
        case "Country":
          country = v == null ? null : String.valueOf(v);
          break;
        default:
          // Custom attrs keep their native JSON-decoded type so a numeric / bool
          // custom attr reaches the comparator un-stringified.
          custom.put(e.getKey(), v);
      }
    }
    return new CorpusUserView(identifier, email, country, custom.isEmpty() ? null : custom);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> evalLogConfig(Map<String, Object> suite) {
    final Object jsonOverride = suite.get("jsonOverride");
    if (jsonOverride instanceof String) {
      return WorkspaceRoot.upstreamJson("evaluationlog/_overrides/" + jsonOverride);
    }
    final Object sdkKey = suite.get("sdkKey");
    if (sdkKey instanceof String) {
      Object config = contentByKey().get(sdkKey);
      if (config == null) {
        config = evalLogConfigs().get(sdkKey);
      }
      if (!(config instanceof Map)) {
        throw new IllegalStateException("No config for eval-log sdkKey " + sdkKey);
      }
      return (Map<String, Object>) config;
    }
    throw new IllegalStateException("Eval-log suite has neither jsonOverride nor sdkKey");
  }

  private static final class EvalLogTuple {
    final String scenario;
    final String key;
    final Object defaultValue;
    final boolean hasDefault;
    final CorpusUserView user;
    final Object expectedValue;
    final Map<String, Object> config;

    EvalLogTuple(
        String scenario,
        String key,
        Object defaultValue,
        boolean hasDefault,
        CorpusUserView user,
        Object expectedValue,
        Map<String, Object> config) {
      this.scenario = scenario;
      this.key = key;
      this.defaultValue = defaultValue;
      this.hasDefault = hasDefault;
      this.user = user;
      this.expectedValue = expectedValue;
      this.config = config;
    }
  }

  @SuppressWarnings("unchecked")
  private static List<EvalLogTuple> loadEvalLogScenario(String scenario) {
    final Map<String, Object> suite =
        WorkspaceRoot.upstreamJson("evaluationlog/" + scenario + ".json");
    final Map<String, Object> config = evalLogConfig(suite);
    final Object testsAny = suite.get("tests");
    final List<EvalLogTuple> out = new ArrayList<>();
    if (testsAny instanceof List) {
      for (final Object tAny : (List<Object>) testsAny) {
        if (!(tAny instanceof Map)) {
          continue;
        }
        final Map<String, Object> t = (Map<String, Object>) tAny;
        final boolean hasDefault = t.containsKey("defaultValue");
        final Object userAny = t.get("user");
        out.add(
            new EvalLogTuple(
                scenario,
                String.valueOf(t.getOrDefault("key", "")),
                t.get("defaultValue"),
                hasDefault,
                evalLogUser(userAny instanceof Map ? (Map<String, Object>) userAny : null),
                t.get("returnValue"),
                config));
      }
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // Assertion helpers.
  // -----------------------------------------------------------------------

  @SuppressWarnings("unchecked")
  private static Integer settingType(Map<String, Object> config, String key) {
    final Object settings = config.get("f");
    if (!(settings instanceof Map)) {
      return null;
    }
    final Object setting = ((Map<String, Object>) settings).get(key);
    if (!(setting instanceof Map)) {
      return null;
    }
    final Object t = ((Map<String, Object>) setting).get("t");
    return (t instanceof Number && !(t instanceof Boolean)) ? ((Number) t).intValue() : null;
  }

  /** Type-appropriate default matching the resolved primitive type. */
  private static Object defaultFor(Object expected, Integer settingType) {
    if (expected instanceof Boolean) {
      return Boolean.FALSE;
    }
    if (expected instanceof Number) {
      return (settingType != null && settingType == Evaluator.SETTING_TYPE_DOUBLE)
          ? (Object) Double.valueOf(0.0)
          : (Object) Integer.valueOf(0);
    }
    return "__default__";
  }

  /** Cast a JSON-decoded eval-log default to the type implied by {@code t}. */
  private static Object coerceDefault(Object def, Integer settingType) {
    if (def instanceof Boolean) {
      return def;
    }
    if (settingType != null
        && settingType == Evaluator.SETTING_TYPE_DOUBLE
        && def instanceof Number) {
      return ((Number) def).doubleValue();
    }
    if (settingType != null
        && settingType == Evaluator.SETTING_TYPE_INT
        && def instanceof Number
        && !(def instanceof Boolean)) {
      return ((Number) def).intValue();
    }
    return def;
  }

  /** Numeric-tolerant equality (5 == 5.0); booleans must not equate with numbers. */
  private static boolean valueEqual(Object actual, Object expected) {
    if (expected instanceof Number && !(expected instanceof Boolean)) {
      if (actual instanceof Boolean || !(actual instanceof Number)) {
        return false;
      }
      final double e = ((Number) expected).doubleValue();
      final double a = ((Number) actual).doubleValue();
      if (Double.isNaN(e)) {
        return Double.isNaN(a);
      }
      return a == e;
    }
    if ((expected instanceof Boolean) != (actual instanceof Boolean)) {
      return false;
    }
    return expected == null ? actual == null : expected.equals(actual);
  }

  private static String userRepr(CorpusUserView user) {
    if (user == null) {
      return "null";
    }
    return "id="
        + user.identifier()
        + " email="
        + user.attribute("Email")
        + " country="
        + user.attribute("Country")
        + " custom="
        + user.customRepr();
  }

  private static void assertMatrixTuple(MatrixTuple tuple, List<String> failures) {
    final String label = tuple.matrix + " " + tuple.key + " user=" + userRepr(tuple.user);
    if (tuple.variation) {
      final Evaluator.Result result =
          Evaluator.evaluateWith(tuple.config, tuple.key, null, tuple.user);
      if (!java.util.Objects.equals(result.getVariationId(), tuple.expected)) {
        failures.add(label + ": actual=" + result.getVariationId() + " expected=" + tuple.expected);
      }
      return;
    }
    final Object def = defaultFor(tuple.expected, settingType(tuple.config, tuple.key));
    final Evaluator.Result result =
        Evaluator.evaluateWith(tuple.config, tuple.key, def, tuple.user);
    if (!valueEqual(result.getValue(), tuple.expected)) {
      failures.add(label + ": actual=" + result.getValue() + " expected=" + tuple.expected);
    }
  }

  private static void assertEvalLogValue(EvalLogTuple tuple, List<String> failures) {
    final Object expected = tuple.expectedValue;
    final Integer st = settingType(tuple.config, tuple.key);
    final Object def =
        (!tuple.hasDefault || tuple.defaultValue == null)
            ? defaultFor(expected, st)
            : coerceDefault(tuple.defaultValue, st);
    final String label = tuple.scenario + " " + tuple.key + " user=" + userRepr(tuple.user);
    final Evaluator.Result result =
        Evaluator.evaluateWith(tuple.config, tuple.key, def, tuple.user);
    if (!valueEqual(result.getValue(), expected)) {
      failures.add(label + ": actual=" + result.getValue() + " expected=" + expected);
    }
  }

  private static Map<String, Object> comparisonConfig(String fixture) {
    return WorkspaceRoot.upstreamJson(fixture + ".json");
  }

  private static EvalLogTuple firstWhere(
      List<EvalLogTuple> cases, java.util.function.Predicate<EvalLogTuple> p) {
    for (final EvalLogTuple c : cases) {
      if (p.test(c)) {
        return c;
      }
    }
    throw new IllegalStateException("No matching case in corpus scenario");
  }

  // =======================================================================
  // US1 / US2 — value + comparator matrices
  // =======================================================================

  @TestFactory
  Stream<DynamicTest> valueMatrices() {
    final String[] matrices = {
      "testmatrix.csv",
      "testmatrix_comparators_v6.csv",
      "testmatrix_semantic.csv",
      "testmatrix_semantic_2.csv",
      "testmatrix_number.csv",
      "testmatrix_sensitive.csv",
      "testmatrix_unicode.csv",
    };
    return Arrays.stream(matrices).map(m -> DynamicTest.dynamicTest(m, () -> runMatrix(m)));
  }

  private void runMatrix(String matrix) {
    final List<MatrixTuple> tuples = loadMatrix(matrix);
    assertThat(tuples).as("%s produced no tuples", matrix).isNotEmpty();
    final List<String> failures = new ArrayList<>();
    for (final MatrixTuple t : tuples) {
      assertMatrixTuple(t, failures);
    }
    assertThat(failures)
        .as("%d drift:\n%s", failures.size(), String.join("\n", failures))
        .isEmpty();
  }

  // =======================================================================
  // US1 — targeting-rule eval-log scenarios
  // =======================================================================

  @TestFactory
  Stream<DynamicTest> targetingRuleScenarios() {
    return Stream.of("1_targeting_rule", "2_targeting_rules", "simple_value")
        .map(s -> DynamicTest.dynamicTest(s, () -> runEvalLog(s)));
  }

  private void runEvalLog(String scenario) {
    final List<String> failures = new ArrayList<>();
    for (final EvalLogTuple t : loadEvalLogScenario(scenario)) {
      assertEvalLogValue(t, failures);
    }
    assertThat(failures)
        .as("%d drift:\n%s", failures.size(), String.join("\n", failures))
        .isEmpty();
  }

  @Test
  void matchedTargetingRuleIsReported() {
    final List<EvalLogTuple> cases = loadEvalLogScenario("1_targeting_rule");
    final EvalLogTuple matching = firstWhere(cases, c -> "Dog".equals(c.expectedValue));
    final Evaluator.Result result =
        Evaluator.evaluateWith(matching.config, matching.key, "default", matching.user);
    assertThat(result.getValue()).isEqualTo("Dog");
    assertThat(result.hasMatchedTargetingRule()).isTrue();
    assertThat(result.hasMatchedPercentageOption()).isFalse();
    assertThat(result.getVariationId()).isEqualTo("d0cd8f06");
  }

  @Test
  void noUserServesFallbackWithReasonAndNeverThrows() {
    final List<EvalLogTuple> cases = loadEvalLogScenario("1_targeting_rule");
    final EvalLogTuple noUser = firstWhere(cases, c -> c.user == null);
    final Evaluator.Result result =
        Evaluator.evaluateWith(noUser.config, noUser.key, "default", null);
    assertThat(result.getValue()).isEqualTo("Cat"); // fallback
    assertThat(result.getError()).isEqualTo(Evaluator.Error.NONE); // a value resolved cleanly
    assertThat(result.getEvalError()).isNotNull();
    assertThat(result.getEvalError()).contains("User Object is missing");
    assertThat(result.hasMatchedTargetingRule()).isFalse();
  }

  // =======================================================================
  // US3 — percentage rollout
  // =======================================================================

  @TestFactory
  Stream<DynamicTest> percentageScenarios() {
    return Stream.of(
            "options_based_on_user_id",
            "options_based_on_custom_attr",
            "options_after_targeting_rule",
            "options_within_targeting_rule")
        .map(s -> DynamicTest.dynamicTest(s, () -> runEvalLog(s)));
  }

  @Test
  void percentageBucketingIsDeterministic() {
    final List<EvalLogTuple> cases = loadEvalLogScenario("options_based_on_user_id");
    final EvalLogTuple withUser = firstWhere(cases, c -> c.user != null);
    final Evaluator.Result first =
        Evaluator.evaluateWith(withUser.config, withUser.key, "default", withUser.user);
    for (int i = 0; i < 20; i++) {
      final Evaluator.Result again =
          Evaluator.evaluateWith(withUser.config, withUser.key, "default", withUser.user);
      assertThat(again.getValue())
          .as("percentage bucketing must be repeat-invariant")
          .isEqualTo(first.getValue());
      assertThat(again.getVariationId()).isEqualTo(first.getVariationId());
    }
    assertThat(valueEqual(first.getValue(), withUser.expectedValue)).isTrue();
    assertThat(first.hasMatchedPercentageOption()).isTrue();
  }

  // =======================================================================
  // US4 — segments / prerequisites / AND-OR matrices + scenarios
  // =======================================================================

  @TestFactory
  Stream<DynamicTest> us4Matrices() {
    final String[] matrices = {
      "testmatrix_and_or.csv",
      "testmatrix_segments.csv",
      "testmatrix_segments_old.csv",
      "testmatrix_prerequisite_flag.csv",
    };
    return Arrays.stream(matrices).map(m -> DynamicTest.dynamicTest(m, () -> runMatrix(m)));
  }

  @TestFactory
  Stream<DynamicTest> us4EvalLogScenarios() {
    return Stream.of("segment", "prerequisite_flag", "and_rules")
        .map(s -> DynamicTest.dynamicTest(s, () -> runEvalLogExcludingUnvendored(s)));
  }

  private void runEvalLogExcludingUnvendored(String scenario) {
    final List<String> failures = new ArrayList<>();
    for (final EvalLogTuple t : loadEvalLogScenario(scenario)) {
      if (UNVENDORED_EVAL_LOG_KEYS.contains(t.key)) {
        continue; // #401 data gap — covered by the reconstructed-chain test below.
      }
      assertEvalLogValue(t, failures);
    }
    assertThat(failures)
        .as("%d drift:\n%s", failures.size(), String.join("\n", failures))
        .isEmpty();
  }

  @Test
  void multilevelPrerequisiteResolvesThroughReconstructedChain() {
    // Reconstructed from evaluationlog/prerequisite_flag (its config blob was not
    // vendored, #401). Proves the engine recurses A -> B -> C correctly.
    final Map<String, Object> config =
        cfg(
            map(
                "mainFeatureWithoutUserCondition",
                setting(0, boolV(true), "main", listOf()),
                "intermediateFeature",
                setting(
                    0,
                    boolV(false),
                    "inter",
                    listOf(
                        rule(
                            listOf(
                                prereqCond("mainFeatureWithoutUserCondition", 0, boolV(true)),
                                prereqCond("mainFeatureWithoutUserCondition", 0, boolV(true))),
                            served(boolV(true), "interT")))),
                "dependentFeatureMultipleLevels",
                setting(
                    1,
                    strV("Cat"),
                    "dep",
                    listOf(
                        rule(
                            listOf(prereqCond("intermediateFeature", 0, boolV(true))),
                            served(strV("Dog"), "depDog"))))));
    final Evaluator.Result result =
        Evaluator.evaluate(config, "dependentFeatureMultipleLevels", "default", null);
    assertThat(result.getValue()).isEqualTo("Dog");
    assertThat(result.hasMatchedTargetingRule()).isTrue();
  }

  // =======================================================================
  // US4 — circular-dependency termination (SC-004)
  // =======================================================================

  @Test
  void circularDepScenariosBoundedFallback() {
    final List<String> failures = new ArrayList<>();
    for (final EvalLogTuple t : loadEvalLogScenario("circular_dep")) {
      final long start = System.nanoTime();
      final Evaluator.Result result = Evaluator.evaluateWith(t.config, t.key, "default", t.user);
      final double elapsed = (System.nanoTime() - start) / 1_000_000_000.0;
      if (elapsed >= 1.0) {
        failures.add(t.key + " took too long (" + elapsed + "s) — cycle not bounded");
      }
      if (!"default".equals(result.getValue())) {
        failures.add(t.key + " value=" + result.getValue() + " (expected fail-closed default)");
      }
      if (result.getError() == Evaluator.Error.NONE) {
        failures.add(t.key + " resolved with no error code");
      }
    }
    assertThat(failures).as(String.join("\n", failures)).isEmpty();
  }

  @Test
  void directTwoFlagCycleTerminates() {
    final Map<String, Object> config =
        cfg(
            map(
                "flagA",
                setting(
                    1,
                    strV("A"),
                    "a",
                    listOf(
                        rule(
                            listOf(prereqCond("flagB", 0, boolV(true))),
                            served(strV("AA"), "aa")))),
                "flagB",
                setting(
                    1,
                    strV("B"),
                    "b",
                    listOf(
                        rule(
                            listOf(prereqCond("flagA", 0, boolV(true))),
                            served(strV("BB"), "bb"))))));
    final long start = System.nanoTime();
    final Evaluator.Result result = Evaluator.evaluate(config, "flagA", "default", null);
    final double elapsed = (System.nanoTime() - start) / 1_000_000_000.0;
    assertThat(elapsed).as("a direct two-flag cycle must terminate bounded").isLessThan(1.0);
    assertThat(result.getValue()).isEqualTo("default");
    assertThat(result.getError()).isNotEqualTo(Evaluator.Error.NONE);
  }

  // =======================================================================
  // US5 — normalization / conversion / trimming (comparison_*.json drivers)
  // =======================================================================

  @Test
  void comparisonAttributeConversion() {
    final Map<String, Object> config = comparisonConfig("comparison_attribute_conversion");
    final Object[][] driver = {
      {"numberToStringConversion", 0.12345, "1"},
      {"numberToStringConversionInt", 125, "4"},
      {"numberToStringConversionPositiveExp", -1.23456789e96, "2"},
      {"numberToStringConversionNegativeExp", -1.23456789e-96, "4"},
      {"numberToStringConversionNaN", Double.NaN, "3"},
      {"numberToStringConversionPositiveInf", Double.POSITIVE_INFINITY, "4"},
      {"numberToStringConversionNegativeInf", Double.NEGATIVE_INFINITY, "3"},
      {"dateToStringConversion", 1680307199.999, "3"},
      {"dateToStringConversionNaN", Double.NaN, "3"},
      {"dateToStringConversionPositiveInf", Double.POSITIVE_INFINITY, "1"},
      {"dateToStringConversionNegativeInf", Double.NEGATIVE_INFINITY, "5"},
      {"stringArrayToStringConversion", Arrays.asList("read", "Write", " eXecute "), "4"},
      {"stringArrayToStringConversionEmpty", new ArrayList<String>(), "5"},
      {"stringArrayToStringConversionSpecialChars", Arrays.asList("+<>%\"'\\/\t\r\n"), "3"},
      {"stringArrayToStringConversionUnicode", Arrays.asList("äöüÄÖÜçéèñışğâ¢™✓😀"), "2"},
    };
    final List<String> failures = new ArrayList<>();
    for (final Object[] c : driver) {
      final Map<String, Object> custom = new LinkedHashMap<>();
      custom.put("Custom1", c[1]);
      final CorpusUserView user = new CorpusUserView("12345", null, null, custom);
      final Evaluator.Result result =
          Evaluator.evaluateWith(config, (String) c[0], "default", user);
      if (!java.util.Objects.equals(result.getValue(), c[2])) {
        failures.add(c[0] + ": actual=" + result.getValue() + " expected=" + c[2]);
      }
    }
    assertThat(failures).as(String.join("\n", failures)).isEmpty();
  }

  /**
   * Native-typed custom attributes must reach the numeric comparator un-stringified and evaluate
   * identically to their string spelling. Exercises CorpusUserView's native-numeric branch, not
   * only the string-&gt;float coercion path the matrix CSVs / eval-log scenarios cover.
   */
  @Test
  void nativeNumericCustomAttributeMatchesStringForm() {
    final Map<String, Object> rule =
        rule(
            listOf(userCond("Custom1", Comparators.NUMBER_GREATER_OR_EQUALS, 18.0)),
            served(strV("match"), "m"));
    final Map<String, Object> setting = setting(1, strV("no-match"), "ng", listOf(rule));
    setting.put("a", "Custom1");
    final Map<String, Object> config = cfg(map("numericGate", setting));

    final Object[][] cases = {
      {21, "match"},
      {18.0, "match"},
      {17, "no-match"},
      {17.999, "no-match"},
      {"21", "match"},
      {"18.0", "match"},
      {"17", "no-match"},
    };
    final List<String> failures = new ArrayList<>();
    for (final Object[] c : cases) {
      final Map<String, Object> custom = new LinkedHashMap<>();
      custom.put("Custom1", c[0]);
      final CorpusUserView user = new CorpusUserView("12345", null, null, custom);
      final Evaluator.Result result =
          Evaluator.evaluateWith(config, "numericGate", "default", user);
      if (!java.util.Objects.equals(result.getValue(), c[1])) {
        failures.add(c[0] + ": actual=" + result.getValue() + " expected=" + c[1]);
      }
    }
    assertThat(failures).as(String.join("\n", failures)).isEmpty();
  }

  @Test
  void comparisonAttributeTrimming() {
    final Map<String, Object> config = comparisonConfig("comparison_attribute_trimming");
    final Map<String, Object> custom = new LinkedHashMap<>();
    custom.put("Version", " 1.0.0 ");
    custom.put("Number", " 3 ");
    custom.put("Date", " 1705253400 ");
    final CorpusUserView user = new CorpusUserView(" 12345 ", null, "[\" USA \"]", custom);
    final List<String> failures = new ArrayList<>();
    for (final String[] c : trimmingDriver()) {
      final Evaluator.Result result = Evaluator.evaluateWith(config, c[0], "default", user);
      if (!java.util.Objects.equals(result.getValue(), c[1])) {
        failures.add(c[0] + ": actual=" + result.getValue() + " expected=" + c[1]);
      }
    }
    assertThat(failures).as(String.join("\n", failures)).isEmpty();
  }

  @Test
  void comparisonValueTrimming() {
    final Map<String, Object> config = comparisonConfig("comparison_value_trimming");
    final Map<String, Object> custom = new LinkedHashMap<>();
    custom.put("Version", "1.0.0");
    custom.put("Number", "3");
    custom.put("Date", "1705253400");
    final CorpusUserView user = new CorpusUserView("12345", null, "[\"USA\"]", custom);
    final List<String> failures = new ArrayList<>();
    for (final String[] c : valueTrimmingDriver()) {
      final Evaluator.Result result = Evaluator.evaluateWith(config, c[0], "default", user);
      if (!java.util.Objects.equals(result.getValue(), c[1])) {
        failures.add(c[0] + ": actual=" + result.getValue() + " expected=" + c[1]);
      }
    }
    assertThat(failures).as(String.join("\n", failures)).isEmpty();
  }

  // =======================================================================
  // US5 — typed-attribute validation outcomes (FR-010) + list truncation
  // =======================================================================

  @TestFactory
  Stream<DynamicTest> validationScenarios() {
    return Stream.of(
            "semver_validation", "number_validation", "epoch_date_validation", "list_truncation")
        .map(s -> DynamicTest.dynamicTest(s, () -> runEvalLog(s)));
  }

  // =======================================================================
  // US5 — variationId + matched rule/option detail (FR-011)
  // =======================================================================

  @Test
  void variationIdMatrix() {
    runMatrix("testmatrix_variationId.csv");
  }

  @Test
  void segmentMatchedFlagReportsValueAndVariationId() {
    final List<EvalLogTuple> cases = loadEvalLogScenario("segment");
    final EvalLogTuple match =
        firstWhere(cases, c -> "featureWithSegmentTargeting".equals(c.key) && c.user != null);
    final Evaluator.Result result =
        Evaluator.evaluateWith(match.config, match.key, false, match.user);
    assertThat(result.getValue()).isEqualTo(Boolean.TRUE);
    assertThat(result.hasMatchedTargetingRule()).isTrue();
    assertThat(result.getVariationId()).isNotNull();
  }

  // -----------------------------------------------------------------------
  // Trimming driver tables (ported verbatim from upstream-corpus.ts).
  // -----------------------------------------------------------------------

  private static List<String[]> trimmingDriver() {
    final String[] noTrim = {
      "isoneof",
      "isnotoneof",
      "isoneofhashed",
      "isnotoneofhashed",
      "equalshashed",
      "notequalshashed",
      "arraycontainsanyofhashed",
      "arraynotcontainsanyofhashed",
      "equals",
      "notequals",
      "startwithanyof",
      "notstartwithanyof",
      "endswithanyof",
      "notendswithanyof",
      "arraycontainsanyof",
      "arraynotcontainsanyof",
      "startwithanyofhashed",
      "notstartwithanyofhashed",
      "endswithanyofhashed",
      "notendswithanyofhashed",
    };
    final List<String[]> out = new ArrayList<>();
    for (final String k : noTrim) {
      out.add(new String[] {k, "no trim"});
    }
    final String[][] trim = {
      {"semverisoneof", "4 trim"},
      {"semverisnotoneof", "5 trim"},
      {"semverless", "6 trim"},
      {"semverlessequals", "7 trim"},
      {"semvergreater", "8 trim"},
      {"semvergreaterequals", "9 trim"},
      {"numberequals", "10 trim"},
      {"numbernotequals", "11 trim"},
      {"numberless", "12 trim"},
      {"numberlessequals", "13 trim"},
      {"numbergreater", "14 trim"},
      {"numbergreaterequals", "15 trim"},
      {"datebefore", "18 trim"},
      {"dateafter", "19 trim"},
    };
    out.addAll(Arrays.asList(trim));
    out.add(new String[] {"containsanyof", "no trim"});
    out.add(new String[] {"notcontainsanyof", "no trim"});
    return out;
  }

  private static List<String[]> valueTrimmingDriver() {
    final String[] noTrim = {
      "isoneof",
      "isnotoneof",
      "containsanyof",
      "notcontainsanyof",
      "isoneofhashed",
      "isnotoneofhashed",
      "equalshashed",
      "notequalshashed",
      "arraycontainsanyofhashed",
      "arraynotcontainsanyofhashed",
      "equals",
      "notequals",
      "startwithanyof",
      "notstartwithanyof",
      "endswithanyof",
      "notendswithanyof",
      "arraycontainsanyof",
      "arraynotcontainsanyof",
      "startwithanyofhashed",
      "notstartwithanyofhashed",
      "endswithanyofhashed",
      "notendswithanyofhashed",
    };
    final List<String[]> out = new ArrayList<>();
    for (final String k : noTrim) {
      out.add(new String[] {k, "no trim"});
    }
    final String[][] trim = {
      {"semverisoneof", "4 trim"},
      {"semverisnotoneof", "5 trim"},
      {"semverless", "6 trim"},
      {"semverlessequals", "7 trim"},
      {"semvergreater", "8 trim"},
      {"semvergreaterequals", "9 trim"},
    };
    out.addAll(Arrays.asList(trim));
    return out;
  }

  // -----------------------------------------------------------------------
  // Tiny config-builder helpers for the reconstructed-chain / cycle / numeric
  // tests (so the inline blobs stay readable).
  // -----------------------------------------------------------------------

  private static Map<String, Object> cfg(Map<String, Object> flags) {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("u", "");
    p.put("r", 0);
    p.put("s", "salt");
    final Map<String, Object> root = new LinkedHashMap<>();
    root.put("p", p);
    root.put("s", new ArrayList<>());
    root.put("f", flags);
    return root;
  }

  private static Map<String, Object> map(Object... kv) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }

  private static Map<String, Object> setting(
      int t, Map<String, Object> v, String i, List<Object> r) {
    final Map<String, Object> s = new LinkedHashMap<>();
    s.put("t", t);
    s.put("v", v);
    s.put("i", i);
    s.put("r", r);
    return s;
  }

  private static Map<String, Object> boolV(boolean b) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("b", b);
    return m;
  }

  private static Map<String, Object> strV(String s) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("s", s);
    return m;
  }

  private static Map<String, Object> served(Map<String, Object> v, String i) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("v", v);
    m.put("i", i);
    return m;
  }

  private static Map<String, Object> rule(List<Object> conditions, Map<String, Object> served) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("c", conditions);
    m.put("s", served);
    return m;
  }

  private static Map<String, Object> prereqCond(String flag, int cmp, Map<String, Object> v) {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("f", flag);
    p.put("c", cmp);
    p.put("v", v);
    final Map<String, Object> cond = new LinkedHashMap<>();
    cond.put("p", p);
    return cond;
  }

  private static Map<String, Object> userCond(String attr, int cmp, double d) {
    final Map<String, Object> u = new LinkedHashMap<>();
    u.put("a", attr);
    u.put("c", cmp);
    u.put("d", d);
    final Map<String, Object> cond = new LinkedHashMap<>();
    cond.put("u", u);
    return cond;
  }

  private static List<Object> listOf(Object... items) {
    return new ArrayList<>(Arrays.asList(items));
  }

  // ==========================================================================
  // Evaluation-log TRACE fidelity (ADR 0003 / epic #494, #501 Java slice).
  //
  // Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
  // (the cross-language byte-oracle; each tuple carries a Confeature-canonical
  // expectedTrace) through Evaluator.evaluateTraced and asserts the emitted
  // trace is byte-identical. Mirrors the Go / Python / Rust / .NET / Ruby / PHP
  // / Dart / Elixir / C++ ports.
  // ==========================================================================

  private static final List<String> TRACE_SCENARIOS =
      Arrays.asList(
          "simple_value",
          "1_targeting_rule",
          "2_targeting_rules",
          "and_rules",
          "options_based_on_user_id",
          "options_based_on_custom_attr",
          "options_after_targeting_rule",
          "options_within_targeting_rule",
          "list_truncation",
          "number_validation",
          "circular_dep",
          "prerequisite_flag",
          "semver_validation",
          "epoch_date_validation");

  @Test
  @SuppressWarnings("unchecked")
  void evalLogTraceFidelity() throws Exception {
    final List<Map<String, Object>> tuples =
        MAPPER.readValue(
            WorkspaceRoot.repoRoot()
                .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json")
                .toFile(),
            List.class);
    assertThat(tuples).isNotEmpty();

    final Map<String, Integer> seen = new LinkedHashMap<>();
    final List<String> failures = new ArrayList<>();

    for (final Map<String, Object> t : tuples) {
      final Object expectedObj = t.get("expectedTrace");
      final Object scenarioObj = t.get("scenario");
      if (!(expectedObj instanceof String) || !(scenarioObj instanceof String)) {
        continue;
      }
      final String scenario = (String) scenarioObj;
      if (!TRACE_SCENARIOS.contains(scenario)) {
        continue;
      }

      final String key = (String) t.get("key");
      final Map<String, Object> config = (Map<String, Object>) t.get("config");
      final Integer st = settingType(config, key);
      final Object def = coerceDefault(t.get("defaultValue"), st);
      final CorpusUserView user =
          traceUser(t.get("user") instanceof Map ? (Map<String, Object>) t.get("user") : null);

      final CaptureSink sink = new CaptureSink();
      Evaluator.evaluateTraced(config, key, def, user, sink);
      final String actual = String.join("\n", sink.lines);

      seen.merge(scenario, 1, Integer::sum);
      if (!actual.equals(expectedObj)) {
        failures.add(
            "trace mismatch for "
                + scenario
                + "/"
                + key
                + "\n--- want ---\n"
                + expectedObj
                + "\n--- got ---\n"
                + actual);
      }
    }

    assertThat(failures).as(String.join("\n\n", failures)).isEmpty();

    // Every trace-bearing scenario must have asserted >=1 tuple.
    for (final String scenario : TRACE_SCENARIOS) {
      assertThat(seen.getOrDefault(scenario, 0))
          .as("trace scenario %s carried no asserted tuples", scenario)
          .isGreaterThan(0);
    }
  }

  /**
   * Build a {@link CorpusUserView} from the corpus tuple's LOWERCASE user object ({@code
   * {identifier, email?, country?, custom?}}) by reshaping it into the capitalized flat form {@link
   * #evalLogUser} expects, then reusing it.
   */
  @SuppressWarnings("unchecked")
  private static CorpusUserView traceUser(Map<String, Object> raw) {
    if (raw == null || raw.isEmpty()) {
      return null;
    }
    final Map<String, Object> reshaped = new LinkedHashMap<>();
    final Object id = raw.get("identifier");
    if (id != null) {
      reshaped.put("Identifier", id);
    }
    final Object email = raw.get("email");
    if (email != null) {
      reshaped.put("Email", email);
    }
    final Object country = raw.get("country");
    if (country != null) {
      reshaped.put("Country", country);
    }
    if (raw.get("custom") instanceof Map) {
      reshaped.putAll((Map<String, Object>) raw.get("custom"));
    }
    return evalLogUser(reshaped);
  }

  /** INFO-level eval-log capture sink reconstructing the parity byte-string. */
  private static final class CaptureSink implements EvalTraceLog.Sink {
    private final List<String> lines = new ArrayList<>();

    @Override
    public EvalTraceLog.Level level() {
      return EvalTraceLog.Level.INFO;
    }

    @Override
    public void log(EvalTraceLog.Level level, String eventId, String message) {
      lines.add(traceLabel(level) + ": [" + eventId + "] " + message);
    }
  }

  private static String traceLabel(EvalTraceLog.Level level) {
    switch (level) {
      case ERROR:
        return "ERROR";
      case WARN:
        return "WARN";
      case INFO:
        return "INFO";
      case DEBUG:
        return "DEBUG";
      default:
        return "?";
    }
  }
}
