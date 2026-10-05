// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The 36 ConfigCat {@code UserComparator} operations, ported field-for-field from {@code
 * packages/sdk-shared/src/comparators.ts} (the spec-117 reference, verified against {@code
 * configcat-common}).
 *
 * <p>Six families: text (cleartext, case-sensitive, no trim), sensitive text (SHA-256 salted),
 * semver, number (strict whole-string parse, {@code ,}→{@code .}), datetime (Unix seconds), array
 * (cleartext + sensitive). Attribute-conversion entrypoints accept {@code Object} so the
 * conformance harness can feed native number/array/epoch attrs un-stringified; the public {@code
 * User.custom}'s String values flow through the same string-conversion path.
 */
final class Comparators {

  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Pattern NUMERIC_INT = Pattern.compile("^-?\\d+$");
  private static final Pattern LEADING_ZERO_REJECT = Pattern.compile("^\\s*$|^\\s*0[^\\d.eE]");
  private static final Pattern FLOAT_RE =
      Pattern.compile("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$");

  // UserComparator codes (config_v6).
  static final int TEXT_IS_ONE_OF = 0;
  static final int TEXT_IS_NOT_ONE_OF = 1;
  static final int TEXT_CONTAINS_ANY_OF = 2;
  static final int TEXT_NOT_CONTAINS_ANY_OF = 3;
  static final int SEMVER_IS_ONE_OF = 4;
  static final int SEMVER_IS_NOT_ONE_OF = 5;
  static final int SEMVER_LESS = 6;
  static final int SEMVER_LESS_OR_EQUALS = 7;
  static final int SEMVER_GREATER = 8;
  static final int SEMVER_GREATER_OR_EQUALS = 9;
  static final int NUMBER_EQUALS = 10;
  static final int NUMBER_NOT_EQUALS = 11;
  static final int NUMBER_LESS = 12;
  static final int NUMBER_LESS_OR_EQUALS = 13;
  static final int NUMBER_GREATER = 14;
  static final int NUMBER_GREATER_OR_EQUALS = 15;
  static final int SENSITIVE_TEXT_IS_ONE_OF = 16;
  static final int SENSITIVE_TEXT_IS_NOT_ONE_OF = 17;
  static final int DATETIME_BEFORE = 18;
  static final int DATETIME_AFTER = 19;
  static final int SENSITIVE_TEXT_EQUALS = 20;
  static final int SENSITIVE_TEXT_NOT_EQUALS = 21;
  static final int SENSITIVE_TEXT_STARTS_WITH_ANY_OF = 22;
  static final int SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF = 23;
  static final int SENSITIVE_TEXT_ENDS_WITH_ANY_OF = 24;
  static final int SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF = 25;
  static final int SENSITIVE_ARRAY_CONTAINS_ANY_OF = 26;
  static final int SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF = 27;
  static final int TEXT_EQUALS = 28;
  static final int TEXT_NOT_EQUALS = 29;
  static final int TEXT_STARTS_WITH_ANY_OF = 30;
  static final int TEXT_NOT_STARTS_WITH_ANY_OF = 31;
  static final int TEXT_ENDS_WITH_ANY_OF = 32;
  static final int TEXT_NOT_ENDS_WITH_ANY_OF = 33;
  static final int ARRAY_CONTAINS_ANY_OF = 34;
  static final int ARRAY_NOT_CONTAINS_ANY_OF = 35;

  private Comparators() {
    // Utility class.
  }

  // -------------------------------------------------------------------------
  // Attribute conversion helpers
  // -------------------------------------------------------------------------

  /**
   * Coerce {@code value} to a {@code List<String>} when it is a string collection: a {@link List}
   * whose every element is a {@link String}, or a {@code String[]} (ConfigCat's Java {@code User}
   * accepts {@code String[]} custom values). Returns {@code null} otherwise.
   */
  @SuppressWarnings("unchecked")
  static List<String> asStringList(Object value) {
    if (value instanceof List) {
      for (final Object e : (List<?>) value) {
        if (!(e instanceof String)) {
          return null;
        }
      }
      return (List<String>) value;
    }
    if (value instanceof String[]) {
      return java.util.Arrays.asList((String[]) value);
    }
    return null;
  }

  /** True iff {@code value} is a string collection ({@link List}-of-String or {@code String[]}). */
  static boolean isStringArray(Object value) {
    return asStringList(value) != null;
  }

  /**
   * Stringify a user-attribute value (common-js {@code userAttributeValueToString}): String
   * verbatim; bool → "true"/"false"; string array → compact JSON; number → JS canonical string;
   * Date / Instant → Unix epoch SECONDS as a canonical number string; else {@code toString}.
   *
   * <p>ConfigCat converts a Date attribute to its Unix-epoch-seconds (fractional) representation
   * before stringifying, so e.g. {@code Date(1680307199999)} → {@code "1680307199.999"}, matching a
   * bare numeric epoch-seconds attribute.
   */
  static String userAttributeValueToString(Object value) {
    if (value instanceof String) {
      return (String) value;
    }
    if (value instanceof Boolean) {
      return ((Boolean) value) ? "true" : "false";
    }
    if (isStringArray(value)) {
      try {
        return JSON.writeValueAsString(value);
      } catch (Exception e) {
        return "";
      }
    }
    final Double epochSeconds = dateToUnixSeconds(value);
    if (epochSeconds != null) {
      return numberToCanonicalString(epochSeconds);
    }
    if (value instanceof Number) {
      return numberToCanonicalString(((Number) value).doubleValue());
    }
    return String.valueOf(value);
  }

  /**
   * If {@code value} is a {@link java.util.Date} or {@link java.time.Instant}, return its Unix
   * epoch SECONDS (fractional, millis / 1000); otherwise {@code null}. ConfigCat's {@code
   * UserAttributeConverter} treats a Date attribute as the moment expressed in epoch seconds.
   */
  static Double dateToUnixSeconds(Object value) {
    if (value instanceof java.util.Date) {
      return ((java.util.Date) value).getTime() / 1000.0;
    }
    if (value instanceof java.time.Instant) {
      final java.time.Instant instant = (java.time.Instant) value;
      return instant.getEpochSecond() + instant.getNano() / 1_000_000_000.0;
    }
    return null;
  }

  /**
   * Stringify a number as ConfigCat's canonical string (JS {@code Number.toString}). NaN /
   * ±Infinity print as "NaN" / "Infinity" / "-Infinity"; otherwise the SHORTEST round-tripping
   * digit sequence, fixed-point unless the magnitude warrants exponential. The corpus {@code
   * numberToStringConversion*} cases hinge on this — e.g. {@code -1.23456789e+96} must NOT expand
   * to its full integer form.
   */
  static String numberToCanonicalString(double value) {
    if (Double.isNaN(value)) {
      return "NaN";
    }
    if (Double.isInfinite(value)) {
      return value > 0 ? "Infinity" : "-Infinity";
    }
    if (value == 0.0) {
      return "0";
    }
    return jsNumberToString(value);
  }

  /** Render a finite non-zero double exactly as ECMAScript {@code Number.toString}. */
  private static String jsNumberToString(double value) {
    final String sign = value < 0 ? "-" : "";
    final double av = Math.abs(value);
    final String[] dp = shortestDigitsAndPoint(av);
    final String digits = dp[0];
    final int k = digits.length();
    final int n = Integer.parseInt(dp[1]);

    if (n >= k && n <= 21) {
      return sign + digits + repeat('0', n - k);
    }
    if (n > 0 && n <= 21) {
      return sign + digits.substring(0, n) + "." + digits.substring(n);
    }
    if (n > -6 && n <= 0) {
      return sign + "0." + repeat('0', -n) + digits;
    }
    final int e = n - 1;
    final String expSign = e >= 0 ? "+" : "-";
    final String mant =
        k == 1 ? digits.substring(0, 1) : digits.charAt(0) + "." + digits.substring(1);
    return sign + mant + "e" + expSign + Math.abs(e);
  }

  /**
   * Decompose the shortest round-tripping repr of a positive double into {@code [digits, point]} —
   * {@code point} is the count of significant digits before the decimal point in normalized form
   * (the ECMAScript {@code n}). Java's {@code Double.toString} produces a shortest round-tripping
   * mantissa, so its digits + exponent reconstruct the JS form.
   */
  private static String[] shortestDigitsAndPoint(double av) {
    final String shortest = Double.toString(av).toLowerCase();
    final String mant;
    final int expVal;
    final int eIdx = shortest.indexOf('e');
    if (eIdx >= 0) {
      mant = shortest.substring(0, eIdx);
      expVal = Integer.parseInt(shortest.substring(eIdx + 1));
    } else {
      mant = shortest;
      expVal = 0;
    }
    final String intPart;
    final String fracPart;
    final int dot = mant.indexOf('.');
    if (dot >= 0) {
      intPart = mant.substring(0, dot);
      fracPart = mant.substring(dot + 1);
    } else {
      intPart = mant;
      fracPart = "";
    }
    String raw = intPart + fracPart;
    int point = intPart.length() + expVal;

    int lead = 0;
    final int rawLen = raw.length();
    while (lead < rawLen - 1 && raw.charAt(lead) == '0') {
      lead++;
      point--;
    }
    raw = raw.substring(lead);
    int end = raw.length();
    while (end > 1 && raw.charAt(end - 1) == '0') {
      end--;
    }
    raw = raw.substring(0, end);
    if (raw.isEmpty()) {
      raw = "0";
    }
    return new String[] {raw, Integer.toString(point)};
  }

  private static String repeat(char c, int count) {
    if (count <= 0) {
      return "";
    }
    final char[] arr = new char[count];
    java.util.Arrays.fill(arr, c);
    return new String(arr);
  }

  /**
   * Strict whole-string float parse (common-js {@code parseFloatStrict}). Rejects empty /
   * all-whitespace and a leading {@code 0} followed by a non-digit/non-{@code .}/non-{@code e}
   * (octal / hex). Returns NaN on rejection.
   */
  static double parseFloatStrict(String value) {
    if (value.isEmpty() || LEADING_ZERO_REJECT.matcher(value).find()) {
      return Double.NaN;
    }
    final String stripped = value.trim();
    if (stripped.equals("Infinity") || stripped.equals("+Infinity")) {
      return Double.POSITIVE_INFINITY;
    }
    if (stripped.equals("-Infinity")) {
      return Double.NEGATIVE_INFINITY;
    }
    if (stripped.equals("NaN")) {
      return Double.NaN;
    }
    if (!FLOAT_RE.matcher(stripped).matches()) {
      return Double.NaN;
    }
    return Double.parseDouble(stripped);
  }

  // -------------------------------------------------------------------------
  // Text — cleartext (case-sensitive, no trim)
  // -------------------------------------------------------------------------

  static boolean evaluateTextEquals(String text, String comparisonValue, boolean negate) {
    return text.equals(comparisonValue) != negate;
  }

  static boolean evaluateTextIsOneOf(String text, List<String> comparisonValues, boolean negate) {
    return comparisonValues.contains(text) != negate;
  }

  static boolean evaluateTextContainsAnyOf(
      String text, List<String> comparisonValues, boolean negate) {
    for (final String item : comparisonValues) {
      if (text.contains(item)) {
        return !negate;
      }
    }
    return negate;
  }

  /** Cleartext startsWith/endsWith-any-of. Items longer than the text are skipped. */
  static boolean evaluateTextSliceEqualsAnyOf(
      String text, List<String> comparisonValues, boolean startsWith, boolean negate) {
    for (final String item : comparisonValues) {
      if (text.length() < item.length()) {
        continue;
      }
      final boolean result = startsWith ? text.startsWith(item) : text.endsWith(item);
      if (result) {
        return !negate;
      }
    }
    return negate;
  }

  // -------------------------------------------------------------------------
  // Text — sensitive (SHA-256 salted)
  // -------------------------------------------------------------------------

  static boolean evaluateSensitiveTextEquals(
      String text, String comparisonValue, String configSalt, String contextSalt, boolean negate) {
    final String hash = Hashing.hashComparisonValue(text, configSalt, contextSalt);
    return hash.equals(comparisonValue) != negate;
  }

  static boolean evaluateSensitiveTextIsOneOf(
      String text,
      List<String> comparisonValues,
      String configSalt,
      String contextSalt,
      boolean negate) {
    final String hash = Hashing.hashComparisonValue(text, configSalt, contextSalt);
    return comparisonValues.contains(hash) != negate;
  }

  /**
   * Sensitive startsWith/endsWith-any-of. Each operand is {@code "<byteLen>_<hash>"}; the SDK
   * hashes the matching-length BYTE prefix/suffix of the attribute and compares to {@code <hash>}.
   */
  static boolean evaluateSensitiveTextSliceEqualsAnyOf(
      String text,
      List<String> comparisonValues,
      String configSalt,
      String contextSalt,
      boolean startsWith,
      boolean negate) {
    final byte[] textUtf8 = text.getBytes(StandardCharsets.UTF_8);
    for (final String item : comparisonValues) {
      final int index = item.indexOf('_');
      if (index < 0) {
        continue;
      }
      final int sliceLength;
      try {
        sliceLength = Integer.parseInt(item.substring(0, index));
      } catch (NumberFormatException e) {
        continue;
      }
      if (textUtf8.length < sliceLength) {
        continue;
      }
      final byte[] sliceUtf8 = new byte[sliceLength];
      if (startsWith) {
        System.arraycopy(textUtf8, 0, sliceUtf8, 0, sliceLength);
      } else {
        System.arraycopy(textUtf8, textUtf8.length - sliceLength, sliceUtf8, 0, sliceLength);
      }
      final String hash = Hashing.hashComparisonValueSlice(sliceUtf8, configSalt, contextSalt);
      if (hash.equals(item.substring(index + 1))) {
        return !negate;
      }
    }
    return negate;
  }

  // -------------------------------------------------------------------------
  // Semver
  // -------------------------------------------------------------------------

  /**
   * Semver IS-ONE-OF / IS-NOT-ONE-OF. Each operand is trimmed first; an operand that is empty AFTER
   * trimming (incl. whitespace-only) is skipped — matching ConfigCat, which trims before the empty
   * check. A non-empty but unparseable operand makes the whole comparator {@code false}. Iterates
   * ALL operands (no early-out on match).
   */
  static boolean evaluateSemVerIsOneOf(
      Semver version, List<String> comparisonValues, boolean negate) {
    boolean result = false;
    for (String rawItem : comparisonValues) {
      final String item = rawItem.trim();
      if (item.isEmpty()) {
        continue;
      }
      final Semver version2 = Semver.parse(item);
      if (version2 == null) {
        return false;
      }
      if (!result && version.compare(version2) == 0) {
        result = true;
      }
    }
    return result != negate;
  }

  /** Semver relations. An unparseable operand is a non-match ({@code false}). */
  static boolean evaluateSemVerRelation(Semver version, int comparator, String comparisonValue) {
    final Semver version2 = Semver.parse(comparisonValue.trim());
    if (version2 == null) {
      return false;
    }
    final int cmp = version.compare(version2);
    switch (comparator) {
      case SEMVER_LESS:
        return cmp < 0;
      case SEMVER_LESS_OR_EQUALS:
        return cmp <= 0;
      case SEMVER_GREATER:
        return cmp > 0;
      case SEMVER_GREATER_OR_EQUALS:
        return cmp >= 0;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Number
  // -------------------------------------------------------------------------

  static boolean evaluateNumberRelation(double num, int comparator, double comparisonValue) {
    switch (comparator) {
      case NUMBER_EQUALS:
        return num == comparisonValue;
      case NUMBER_NOT_EQUALS:
        return num != comparisonValue;
      case NUMBER_LESS:
        return num < comparisonValue;
      case NUMBER_LESS_OR_EQUALS:
        return num <= comparisonValue;
      case NUMBER_GREATER:
        return num > comparisonValue;
      case NUMBER_GREATER_OR_EQUALS:
        return num >= comparisonValue;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Datetime (Unix seconds)
  // -------------------------------------------------------------------------

  static boolean evaluateDateTimeRelation(double seconds, double comparisonValue, boolean before) {
    return before ? seconds < comparisonValue : seconds > comparisonValue;
  }

  // -------------------------------------------------------------------------
  // Array (cleartext + sensitive)
  // -------------------------------------------------------------------------

  static boolean evaluateArrayContainsAnyOf(
      List<String> array, List<String> comparisonValues, boolean negate) {
    for (final String item : array) {
      if (comparisonValues.contains(item)) {
        return !negate;
      }
    }
    return negate;
  }

  static boolean evaluateSensitiveArrayContainsAnyOf(
      List<String> array,
      List<String> comparisonValues,
      String configSalt,
      String contextSalt,
      boolean negate) {
    for (final String item : array) {
      final String hash = Hashing.hashComparisonValue(item, configSalt, contextSalt);
      if (comparisonValues.contains(hash)) {
        return !negate;
      }
    }
    return negate;
  }

  // -------------------------------------------------------------------------
  // Attribute → typed value, with a validation-error outcome (FR-010)
  // -------------------------------------------------------------------------

  /** Result of an attribute conversion: the typed value, or a validation error string. */
  static final class Convert<T> {
    final boolean ok;
    final T value;
    final String error;

    /**
     * The offending attribute name + the parenthesised reason, when this is a typed-attribute
     * conversion failure (drives the WARN 3004 {@code userObjectAttributeIsInvalid} trace line).
     * {@code null} for the comparison-value-invalid (#509) outcomes, which take the distinct {@code
     * comparisonValueIsInvalid} WARN.
     */
    final String attribute;

    final String reason;

    private Convert(boolean ok, T value, String error, String attribute, String reason) {
      this.ok = ok;
      this.value = value;
      this.error = error;
      this.attribute = attribute;
      this.reason = reason;
    }

    static <T> Convert<T> ok(T value) {
      return new Convert<>(true, value, null, null, null);
    }

    static <T> Convert<T> err(String error) {
      return new Convert<>(false, null, error, null, null);
    }

    static <T> Convert<T> errAttr(String error, String attribute, String reason) {
      return new Convert<>(false, null, error, attribute, reason);
    }
  }

  private static String invalidAttr(String attr, String reason) {
    return "cannot evaluate, the User." + attr + " attribute is invalid (" + reason + ")";
  }

  /** Attribute → text (String verbatim; else stringified — never errors). */
  static String attributeAsText(Object value) {
    return value instanceof String ? (String) value : userAttributeValueToString(value);
  }

  /** Attribute → semver, or a validation error. */
  static Convert<Semver> attributeAsSemVer(String attr, Object value) {
    if (value instanceof String) {
      final Semver version = Semver.parse(((String) value).trim());
      if (version != null) {
        return Convert.ok(version);
      }
    }
    {
      final String reason =
          "'" + userAttributeValueToString(value) + "' is not a valid semantic version";
      return Convert.errAttr(invalidAttr(attr, reason), attr, reason);
    }
  }

  /** Attribute → number, or a validation error. */
  static Convert<Double> attributeAsNumber(String attr, Object value) {
    if (value instanceof Number && !(value instanceof Boolean)) {
      return Convert.ok(((Number) value).doubleValue());
    }
    if (value instanceof String) {
      final String s = (String) value;
      final double num = parseFloatStrict(s.replace(",", "."));
      if (!Double.isNaN(num) || s.trim().equals("NaN")) {
        return Convert.ok(num);
      }
    }
    {
      final String reason =
          "'" + userAttributeValueToString(value) + "' is not a valid decimal number";
      return Convert.errAttr(invalidAttr(attr, reason), attr, reason);
    }
  }

  /**
   * Attribute → Unix seconds, or a validation error. A numeric attribute is already seconds; a
   * string is parsed strictly. (Java has no native Date attribute on {@code User}; the corpus feeds
   * epoch numbers / strings.)
   */
  static Convert<Double> attributeAsUnixTimeSeconds(String attr, Object value) {
    final Double epochSeconds = dateToUnixSeconds(value);
    if (epochSeconds != null) {
      return Convert.ok(epochSeconds);
    }
    if (value instanceof Number && !(value instanceof Boolean)) {
      return Convert.ok(((Number) value).doubleValue());
    }
    if (value instanceof String) {
      final String s = (String) value;
      final double num = parseFloatStrict(s.replace(",", "."));
      if (!Double.isNaN(num) || s.trim().equals("NaN")) {
        return Convert.ok(num);
      }
    }
    {
      final String reason =
          "'"
              + userAttributeValueToString(value)
              + "' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)";
      return Convert.errAttr(invalidAttr(attr, reason), attr, reason);
    }
  }

  /** Attribute → string array, or a validation error. A string attribute is JSON-parsed. */
  static Convert<List<String>> attributeAsStringArray(String attr, Object value) {
    Object arr = value;
    if (arr instanceof String) {
      try {
        arr = JSON.readValue((String) arr, Object.class);
      } catch (Exception ignored) {
        // A non-JSON string is simply not a valid array.
      }
    }
    final List<String> list = asStringList(arr);
    if (list != null) {
      return Convert.ok(list);
    }
    {
      final String reason =
          "'" + userAttributeValueToString(value) + "' is not a valid string array";
      return Convert.errAttr(invalidAttr(attr, reason), attr, reason);
    }
  }

  /** Detect whether {@code s} parses as a positive (non-negative) integer string. */
  static boolean isIntegerString(String s) {
    return NUMERIC_INT.matcher(s).matches();
  }

  // -------------------------------------------------------------------------
  // Comparison value (config operand) → typed value, same three-valued error
  // outcome (validation-order parity, #509). configcat-common validates the
  // CONFIG comparison value BEFORE the user attribute for the semver relations,
  // number relations, and datetime comparators; a malformed operand surfaces a
  // distinct "comparison value '<v>' is invalid (<reason>)" error, which wins
  // even when the user attribute is ALSO malformed.
  // -------------------------------------------------------------------------

  private static String invalidComparisonValue(String value, String reason) {
    return "comparison value '" + value + "' is invalid (" + reason + ")";
  }

  /** Comparison value → semver (config operand for the semver relations). */
  static Convert<Semver> comparisonValueAsSemVer(String value) {
    final String v = value == null ? "" : value;
    final Semver version = Semver.parse(v.trim());
    if (version != null) {
      return Convert.ok(version);
    }
    return Convert.err(invalidComparisonValue(v, "'" + v + "' is not a valid semantic version"));
  }

  /** Comparison value → number (config operand for the number relations). */
  static Convert<Double> comparisonValueAsNumber(Double value) {
    if (value != null && !Double.isNaN(value)) {
      return Convert.ok(value);
    }
    final String v = jsStringOf(value);
    return Convert.err(invalidComparisonValue(v, "'" + v + "' is not a valid decimal number"));
  }

  /** Comparison value → Unix seconds (config operand for the datetime comparators). */
  static Convert<Double> comparisonValueAsUnixTimeSeconds(Double value) {
    if (value != null && !Double.isNaN(value)) {
      return Convert.ok(value);
    }
    final String v = jsStringOf(value);
    return Convert.err(
        invalidComparisonValue(
            v,
            "'"
                + v
                + "' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"));
  }

  /** JS {@code String(value)} for a {@code number | undefined} operand. */
  private static String jsStringOf(Double value) {
    return value == null ? "undefined" : numberToCanonicalString(value);
  }
}
