// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494, Java slice of #501).
 *
 * <p>Java port of the spec-117 TS reference ({@code packages/sdk-shared/src/eval-log.ts} {@code
 * EvaluateLogBuilder} + {@code COMPARATOR_META}) and the Go / Python / Rust / .NET ports ({@code
 * apps/sdk-go/internal/evaluator/eval_log.go}, {@code apps/sdk-python/.../eval_log.py}, {@code
 * apps/sdk-rust/.../eval_log.rs}, {@code apps/sdk-dotnet/.../Internal/EvalLog.cs}). Produces the
 * byte-identical indented textual trace ConfigCat's SDKs emit during flag evaluation — its {@code
 * evaluationlog/} corpus (replayed via {@code
 * packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json}) is the byte-oracle.
 *
 * <p>The trace is emitted via the trace sink at INFO under event id 5000 (ConfigCat's verbosity
 * contract) — see {@code Evaluator.evaluateTraced}. This capture seam is intentionally distinct
 * from the public {@link io.confeature.client.Logger} (the customer-facing logger): a customer
 * logger has the error/warning/info/debug shape, while the trace test taps a structured {@code
 * (level, eventId, message)} recorder. Keeping them separate matches the Go / Python / Rust / .NET
 * factoring and keeps the no-trace hot path zero-cost.
 */
final class EvalLog {

  /** ConfigCat's event id for the "config evaluated" INFO log line. */
  static final String EVENT_ID = "5000";

  /** ConfigCat indents each nested eval-log line by two spaces per level. */
  static final String INDENT_UNIT = "  ";

  /** Max IS-ONE-OF / list items rendered before truncation (configcat parity). */
  static final int STRING_LIST_MAX_LENGTH = 10;

  // Placeholders ConfigCat substitutes for malformed condition parts (parity with
  // configcat-common's EvaluateLogBuilder).
  static final String INVALID_VALUE_PLACEHOLDER = "<invalid value>";
  static final String INVALID_NAME_PLACEHOLDER = "<invalid name>";
  static final String INVALID_OPERATOR_PLACEHOLDER = "<invalid operator>";

  private static final DateTimeFormatter ISO =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private EvalLog() {
    // Utility class.
  }

  /**
   * Render a resolved SETTING value for the eval log (ConfigCat parity): boolean → {@code
   * true}/{@code false} (lowercase), string → verbatim, number → its decimal string. Mirrors the
   * {@code '<value>'} token in ConfigCat's {@code Returning '<value>'.} footer (eval-log.ts {@code
   * settingValueToString}).
   */
  static String settingValueToLogString(Object value) {
    if (value instanceof Boolean) {
      return boolToLogString((Boolean) value);
    }
    if (value instanceof String) {
      return (String) value;
    }
    if (value instanceof Double || value instanceof Float) {
      return Comparators.numberToCanonicalString(((Number) value).doubleValue());
    }
    if (value instanceof Number) {
      return value.toString();
    }
    return "";
  }

  /** Render a boolean as the lowercase {@code true}/{@code false} the oracle uses. */
  static String boolToLogString(boolean value) {
    return value ? "true" : "false";
  }

  // -------------------------------------------------------------------------
  // Comparator metadata (configcat-common parity, eval-log.ts COMPARATOR_META).
  // -------------------------------------------------------------------------

  /** Which slot a comparator reads: list / string / number / datetime. */
  enum ComparatorKind {
    LIST,
    STR,
    NUMBER,
    DATETIME
  }

  /** Per-comparator eval-log metadata: token rendering, value-slot kind, sensitive masking. */
  static final class ComparatorMeta {
    final String token;
    final ComparatorKind kind;
    final boolean sensitive;

    private ComparatorMeta(String token, ComparatorKind kind, boolean sensitive) {
      this.token = token;
      this.kind = kind;
      this.sensitive = sensitive;
    }

    private static final Map<Integer, ComparatorMeta> MAP = buildMap();

    private static Map<Integer, ComparatorMeta> buildMap() {
      final Map<Integer, ComparatorMeta> m = new HashMap<>();
      m.put(Comparators.TEXT_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, false));
      m.put(Comparators.TEXT_IS_NOT_ONE_OF, of("IS NOT ONE OF", ComparatorKind.LIST, false));
      m.put(Comparators.TEXT_CONTAINS_ANY_OF, of("CONTAINS ANY OF", ComparatorKind.LIST, false));
      m.put(
          Comparators.TEXT_NOT_CONTAINS_ANY_OF,
          of("NOT CONTAINS ANY OF", ComparatorKind.LIST, false));
      m.put(Comparators.SEMVER_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, false));
      m.put(Comparators.SEMVER_IS_NOT_ONE_OF, of("IS NOT ONE OF", ComparatorKind.LIST, false));
      m.put(Comparators.SEMVER_LESS, of("<", ComparatorKind.STR, false));
      m.put(Comparators.SEMVER_LESS_OR_EQUALS, of("<=", ComparatorKind.STR, false));
      m.put(Comparators.SEMVER_GREATER, of(">", ComparatorKind.STR, false));
      m.put(Comparators.SEMVER_GREATER_OR_EQUALS, of(">=", ComparatorKind.STR, false));
      m.put(Comparators.NUMBER_EQUALS, of("=", ComparatorKind.NUMBER, false));
      m.put(Comparators.NUMBER_NOT_EQUALS, of("!=", ComparatorKind.NUMBER, false));
      m.put(Comparators.NUMBER_LESS, of("<", ComparatorKind.NUMBER, false));
      m.put(Comparators.NUMBER_LESS_OR_EQUALS, of("<=", ComparatorKind.NUMBER, false));
      m.put(Comparators.NUMBER_GREATER, of(">", ComparatorKind.NUMBER, false));
      m.put(Comparators.NUMBER_GREATER_OR_EQUALS, of(">=", ComparatorKind.NUMBER, false));
      m.put(Comparators.SENSITIVE_TEXT_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF, of("IS NOT ONE OF", ComparatorKind.LIST, true));
      m.put(Comparators.DATETIME_BEFORE, of("BEFORE", ComparatorKind.DATETIME, false));
      m.put(Comparators.DATETIME_AFTER, of("AFTER", ComparatorKind.DATETIME, false));
      m.put(Comparators.SENSITIVE_TEXT_EQUALS, of("EQUALS", ComparatorKind.STR, true));
      m.put(Comparators.SENSITIVE_TEXT_NOT_EQUALS, of("NOT EQUALS", ComparatorKind.STR, true));
      m.put(
          Comparators.SENSITIVE_TEXT_STARTS_WITH_ANY_OF,
          of("STARTS WITH ANY OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
          of("NOT STARTS WITH ANY OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_TEXT_ENDS_WITH_ANY_OF,
          of("ENDS WITH ANY OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
          of("NOT ENDS WITH ANY OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_ARRAY_CONTAINS_ANY_OF,
          of("ARRAY CONTAINS ANY OF", ComparatorKind.LIST, true));
      m.put(
          Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
          of("ARRAY NOT CONTAINS ANY OF", ComparatorKind.LIST, true));
      m.put(Comparators.TEXT_EQUALS, of("EQUALS", ComparatorKind.STR, false));
      m.put(Comparators.TEXT_NOT_EQUALS, of("NOT EQUALS", ComparatorKind.STR, false));
      m.put(
          Comparators.TEXT_STARTS_WITH_ANY_OF,
          of("STARTS WITH ANY OF", ComparatorKind.LIST, false));
      m.put(
          Comparators.TEXT_NOT_STARTS_WITH_ANY_OF,
          of("NOT STARTS WITH ANY OF", ComparatorKind.LIST, false));
      m.put(Comparators.TEXT_ENDS_WITH_ANY_OF, of("ENDS WITH ANY OF", ComparatorKind.LIST, false));
      m.put(
          Comparators.TEXT_NOT_ENDS_WITH_ANY_OF,
          of("NOT ENDS WITH ANY OF", ComparatorKind.LIST, false));
      m.put(
          Comparators.ARRAY_CONTAINS_ANY_OF,
          of("ARRAY CONTAINS ANY OF", ComparatorKind.LIST, false));
      m.put(
          Comparators.ARRAY_NOT_CONTAINS_ANY_OF,
          of("ARRAY NOT CONTAINS ANY OF", ComparatorKind.LIST, false));
      return m;
    }

    private static ComparatorMeta of(String token, ComparatorKind kind, boolean sensitive) {
      return new ComparatorMeta(token, kind, sensitive);
    }

    static ComparatorMeta get(int comparator) {
      return MAP.get(comparator);
    }

    /** Render a comparator as its eval-log operator token, or the invalid-operator placeholder. */
    static String formatUserComparator(int comparator) {
      final ComparatorMeta meta = MAP.get(comparator);
      return meta != null ? meta.token : INVALID_OPERATOR_PLACEHOLDER;
    }
  }

  // -------------------------------------------------------------------------
  // Three-valued THEN consequence (MATCH / no match / error string), mirroring
  // TS's `boolean | string` (eval-log.ts appendTargetingRuleConsequence).
  // -------------------------------------------------------------------------

  static final class MatchOrError {
    static final int MATCH = 0;
    static final int NO_MATCH = 1;
    static final int ERROR = 2;

    final int kind;
    final String error;

    private MatchOrError(int kind, String error) {
      this.kind = kind;
      this.error = error;
    }

    static MatchOrError match() {
      return new MatchOrError(MATCH, null);
    }

    static MatchOrError noMatch() {
      return new MatchOrError(NO_MATCH, null);
    }

    static MatchOrError err(String text) {
      return new MatchOrError(ERROR, text == null ? "" : text);
    }
  }

  /**
   * Java analogue of eval-log.ts {@code EvaluateLogBuilder}: the indent / newLine / append
   * primitives + the condition-rendering helpers. EOL is {@code "\n"} — the byte the upstream
   * oracle uses.
   */
  static final class EvaluateLogBuilder {
    private static final char EOL = '\n';

    private final StringBuilder chunks = new StringBuilder();
    private int indentLevel;

    /** Append text to the current line. */
    EvaluateLogBuilder append(String text) {
      chunks.append(text);
      return this;
    }

    /** Break to a new line at the current indent, then append {@code text}. */
    EvaluateLogBuilder newLine(String text) {
      chunks.append(EOL);
      for (int i = 0; i < indentLevel; i++) {
        chunks.append(INDENT_UNIT);
      }
      if (text != null && !text.isEmpty()) {
        chunks.append(text);
      }
      return this;
    }

    EvaluateLogBuilder newLine() {
      return newLine(null);
    }

    EvaluateLogBuilder increaseIndent() {
      indentLevel++;
      return this;
    }

    EvaluateLogBuilder decreaseIndent() {
      if (indentLevel > 0) {
        indentLevel--;
      }
      return this;
    }

    /** Render one user condition ({@code User.<attr> <COMP> <value>}). */
    EvaluateLogBuilder appendUserCondition(
        String attr,
        int comparator,
        String stringValue,
        Double numberValue,
        List<String> listValue) {
      final String attrName = attr != null ? attr : INVALID_NAME_PLACEHOLDER;
      final ComparatorMeta meta = ComparatorMeta.get(comparator);
      if (meta == null) {
        return appendUserConditionFallback(
            attrName, comparator, stringValue, numberValue, listValue);
      }
      switch (meta.kind) {
        case LIST:
          return appendUserConditionStringList(attrName, comparator, listValue, meta.sensitive);
        case STR:
          return appendUserConditionString(attrName, comparator, stringValue, meta.sensitive);
        case NUMBER:
          return appendUserConditionNumber(attrName, comparator, numberValue, false);
        case DATETIME:
          return appendUserConditionNumber(attrName, comparator, numberValue, true);
        default:
          return this;
      }
    }

    /** Append a single condition's boolean result ({@code => true} / {@code => false, …}). */
    EvaluateLogBuilder appendConditionConsequence(boolean result) {
      append(" => " + boolToLogString(result));
      return result ? this : append(", skipping the remaining AND conditions");
    }

    /**
     * Append a targeting rule's THEN consequence. {@code thenValue} is the rule's formatted served
     * value (e.g. {@code Dog}) for a fixed-value rule, or {@code null} for a rule serving {@code %
     * options}.
     */
    EvaluateLogBuilder appendTargetingRuleConsequence(
        String thenValue, MatchOrError matchKind, boolean newLine) {
      increaseIndent();
      if (newLine) {
        newLine();
      } else {
        append(" ");
      }
      append("THEN");
      append(thenValue != null ? " '" + thenValue + "'" : " % options");
      append(" => ");
      switch (matchKind.kind) {
        case MatchOrError.MATCH:
          append("MATCH, applying rule");
          break;
        case MatchOrError.NO_MATCH:
          append("no match");
          break;
        default:
          append(matchKind.error);
          break;
      }
      return decreaseIndent();
    }

    /** Append a prerequisite-flag condition ({@code Flag 'X' EQUALS 'Y'}). */
    EvaluateLogBuilder appendPrerequisiteFlagCondition(
        String prereqKey, int comparator, String comparisonValue) {
      final String op = comparator == Evaluator.PREREQ_NOT_EQUALS ? "NOT EQUALS" : "EQUALS";
      return append("Flag '" + prereqKey + "' " + op + " '" + comparisonValue + "'");
    }

    /** Append a segment condition ({@code User IS [NOT] IN SEGMENT 'X'}). */
    EvaluateLogBuilder appendSegmentCondition(String segmentName, int comparator) {
      final String op =
          comparator == Evaluator.SEGMENT_IS_NOT_IN ? "IS NOT IN SEGMENT" : "IS IN SEGMENT";
      return append("User " + op + " '" + segmentName + "'");
    }

    /** Append a bare boolean condition result ({@code true} / {@code false}). */
    EvaluateLogBuilder appendConditionResult(boolean result) {
      return append(boolToLogString(result));
    }

    @Override
    public String toString() {
      return chunks.toString();
    }

    private EvaluateLogBuilder appendUserConditionCore(String attr, int comparator, String value) {
      final String v = (value == null || value.isEmpty()) ? INVALID_VALUE_PLACEHOLDER : value;
      return append(
          "User." + attr + " " + ComparatorMeta.formatUserComparator(comparator) + " '" + v + "'");
    }

    private EvaluateLogBuilder appendUserConditionString(
        String attr, int comparator, String value, boolean isSensitive) {
      if (value == null) {
        return appendUserConditionCore(attr, comparator, "");
      }
      return appendUserConditionCore(attr, comparator, !isSensitive ? value : "<hashed value>");
    }

    private EvaluateLogBuilder appendUserConditionStringList(
        String attr, int comparator, List<String> values, boolean isSensitive) {
      if (values == null) {
        return appendUserConditionCore(attr, comparator, "");
      }
      final String comparatorText = ComparatorMeta.formatUserComparator(comparator);
      if (isSensitive) {
        final String word = values.size() == 1 ? "value" : "values";
        return append(
            "User."
                + attr
                + " "
                + comparatorText
                + " [<"
                + values.size()
                + " hashed "
                + word
                + ">]");
      }
      final String listText = formatStringList(values, STRING_LIST_MAX_LENGTH);
      return append("User." + attr + " " + comparatorText + " [" + listText + "]");
    }

    private EvaluateLogBuilder appendUserConditionNumber(
        String attr, int comparator, Double value, boolean isDateTime) {
      if (value == null) {
        return appendUserConditionCore(attr, comparator, "");
      }
      final String comparatorText = ComparatorMeta.formatUserComparator(comparator);
      final String valueText = Comparators.numberToCanonicalString(value);
      final String iso = isDateTime ? unixSecondsToIso(value) : null;
      if (iso != null) {
        return append(
            "User." + attr + " " + comparatorText + " '" + valueText + "' (" + iso + " UTC)");
      }
      return append("User." + attr + " " + comparatorText + " '" + valueText + "'");
    }

    private EvaluateLogBuilder appendUserConditionFallback(
        String attr,
        int comparator,
        String stringValue,
        Double numberValue,
        List<String> listValue) {
      if (stringValue != null) {
        return appendUserConditionCore(attr, comparator, stringValue);
      }
      if (numberValue != null) {
        return appendUserConditionCore(
            attr, comparator, Comparators.numberToCanonicalString(numberValue));
      }
      if (listValue != null && !listValue.isEmpty()) {
        return appendUserConditionCore(attr, comparator, listValue.get(0));
      }
      return appendUserConditionCore(attr, comparator, "");
    }

    /**
     * Format a string list exactly as configcat-common's {@code formatStringList} (Utils.ts):
     * {@code 'a', 'b'} joined by {@code , }, with an optional truncation appendix once {@code
     * maxLength} is exceeded.
     */
    private static String formatStringList(List<String> items, int maxLength) {
      if (items.isEmpty()) {
        return "";
      }
      List<String> shown = items;
      String appendix = "";
      if (maxLength > 0 && items.size() > maxLength) {
        shown = new ArrayList<>(items.subList(0, maxLength));
        final int count = items.size() - maxLength;
        final String word = count == 1 ? "value" : "values";
        appendix = ", ... <" + count + " more " + word + ">";
      }
      return "'" + String.join("', '", shown) + "'" + appendix;
    }

    /**
     * Render a Unix-seconds value as ConfigCat's eval-log datetime suffix — JS {@code new
     * Date(value*1000).toISOString()}, e.g. {@code 2023-04-01T00:00:00.000Z} (always millisecond
     * precision, UTC). Returns {@code null} for non-finite values (NaN / ±Inf), matching the JS
     * {@code isNaN(date)} guard.
     */
    private static String unixSecondsToIso(double seconds) {
      if (Double.isNaN(seconds) || Double.isInfinite(seconds)) {
        return null;
      }
      final long ms = Math.round(seconds * 1000.0);
      return ISO.format(Instant.ofEpochMilli(ms));
    }
  }
}
