// SPDX-License-Identifier: MIT

/// The 36 ConfigCat `UserComparator` operations + attribute conversion.
/// Ported field-for-field from the spec-117 TS reference
/// (`packages/sdk-shared/src/comparators.ts`), cross-checked against the
/// spec-118/119/120/121/122 Python / Go / Ruby / PHP / .NET ports, itself
/// verified against common-js `RolloutEvaluator.ts` (`configcat-common@9.4.1`).
///
/// Each comparator returns a three-valued outcome: `true` (match), `false`
/// (no match), or a [ValidationError] (a validation / conversion failure —
/// bad semver, non-numeric number, non-array array). An error short-circuits
/// the AND group like `false` but is surfaced rather than silently swallowed
/// (FR-010).
///
/// The six families: text (cleartext, case-SENSITIVE, no trim); sensitive text
/// (SHA-256 SALTED, length-prefixed slice variants); semver (on
/// [SemVer.parse]); number (strict whole-string parse, `,`→`.`); datetime
/// (Before/After, Unix seconds); array (contains/notContains, cleartext +
/// sensitive).
library;

import 'dart:convert';

import 'hashing.dart';
import 'semver.dart';

/// UserComparator discriminators (mirror config-json.ts `UserComparator`).
abstract final class Cmp {
  static const int textIsOneOf = 0;
  static const int textIsNotOneOf = 1;
  static const int textContainsAnyOf = 2;
  static const int textNotContainsAnyOf = 3;
  static const int semverIsOneOf = 4;
  static const int semverIsNotOneOf = 5;
  static const int semverLess = 6;
  static const int semverLessOrEquals = 7;
  static const int semverGreater = 8;
  static const int semverGreaterOrEquals = 9;
  static const int numberEquals = 10;
  static const int numberNotEquals = 11;
  static const int numberLess = 12;
  static const int numberLessOrEquals = 13;
  static const int numberGreater = 14;
  static const int numberGreaterOrEquals = 15;
  static const int sensitiveTextIsOneOf = 16;
  static const int sensitiveTextIsNotOneOf = 17;
  static const int datetimeBefore = 18;
  static const int datetimeAfter = 19;
  static const int sensitiveTextEquals = 20;
  static const int sensitiveTextNotEquals = 21;
  static const int sensitiveTextStartsWithAnyOf = 22;
  static const int sensitiveTextNotStartsWithAnyOf = 23;
  static const int sensitiveTextEndsWithAnyOf = 24;
  static const int sensitiveTextNotEndsWithAnyOf = 25;
  static const int sensitiveArrayContainsAnyOf = 26;
  static const int sensitiveArrayNotContainsAnyOf = 27;
  static const int textEquals = 28;
  static const int textNotEquals = 29;
  static const int textStartsWithAnyOf = 30;
  static const int textNotStartsWithAnyOf = 31;
  static const int textEndsWithAnyOf = 32;
  static const int textNotEndsWithAnyOf = 33;
  static const int arrayContainsAnyOf = 34;
  static const int arrayNotContainsAnyOf = 35;
}

/// Three-valued condition outcome's error variant. A condition resolves to
/// `true` / `false` (a Dart `bool`) or a [ValidationError]; the latter
/// short-circuits an AND group like `false` but is surfaced (FR-010).
class ValidationError {
  /// Construct a validation error carrying a human-readable [message].
  const ValidationError(this.message);

  /// The surfaced reason string.
  final String message;
}

/// Build a [ValidationError] from a [message].
ValidationError error(String message) => ValidationError(message);

/// A malformed CONFIG comparison value (#509). configcat-common validates the
/// operand BEFORE the user attribute for the semver relations, number
/// relations, and datetime comparators; a malformed operand surfaces this
/// distinct `comparison value '<v>' is invalid (<reason>)` outcome (NO "please
/// check the User.<attr>…" suffix — the fault is in the config, not the user)
/// which wins even when the attribute is ALSO malformed. It short-circuits the
/// AND group like `false`. Mirrors the spec-117 TS `ComparisonValueError` arm
/// and the Python / Ruby / PHP ports.
class ComparisonValueError {
  /// Construct a comparison-value error carrying the surfaced [message].
  const ComparisonValueError(this.message);

  /// The surfaced reason string.
  final String message;
}

ComparisonValueError _invalidComparisonValue(String value, String reason) =>
    ComparisonValueError("comparison value '$value' is invalid ($reason)");

/// Config semver operand → semver, or a comparison-value error. The operand is
/// trimmed before parsing (parity with [evaluateSemverRelation]); the error
/// reports the UNTRIMMED operand.
Object comparisonValueAsSemver(String value) {
  final version = SemVer.parse(value.trim());
  if (version != null) return version;
  return _invalidComparisonValue(
      value, "'$value' is not a valid semantic version");
}

/// Render a numeric operand for the comparison-value error message. Mirrors
/// TS's `String(value)`: an absent operand prints "undefined", otherwise the
/// canonical number string.
String _comparisonValueNumberString(double? value) =>
    value == null ? 'undefined' : numberToCanonicalString(value);

/// Config number operand → number, or a comparison-value error. [value] is the
/// condition's `d` slot (null when absent).
Object comparisonValueAsNumber(double? value) {
  if (value != null && !value.isNaN) return value;
  final s = _comparisonValueNumberString(value);
  return _invalidComparisonValue(s, "'$s' is not a valid decimal number");
}

/// Config datetime operand → Unix seconds, or a comparison-value error.
Object comparisonValueAsUnixTimeSeconds(double? value) {
  if (value != null && !value.isNaN) return value;
  final s = _comparisonValueNumberString(value);
  return _invalidComparisonValue(
    s,
    "'$s' is not a valid Unix timestamp (number of seconds elapsed since Unix "
    'epoch)',
  );
}

/// True iff [value] is a list whose every element is a string
/// (common-js `isStringArray`).
bool isStringArray(Object? value) {
  if (value is! List) return false;
  for (final e in value) {
    if (e is! String) return false;
  }
  return true;
}

/// Stringify a user-attribute value (common-js `userAttributeValueToString`):
/// string verbatim; bool → "true"/"false" (JS lowercase); string array → JSON
/// (compact, no spaces); number → JS canonical string; `DateTime` →
/// second-based Unix epoch (mirrors `configcat_client`'s
/// `_userAttributeToString`); else cast to string.
String userAttributeValueToString(Object? value) {
  if (value is String) return value;
  if (value is bool) return value ? 'true' : 'false';
  if (isStringArray(value)) {
    return jsonEncode(value);
  }
  if (value is int) return numberToCanonicalString(value.toDouble());
  if (value is double) return numberToCanonicalString(value);
  if (value is DateTime) return _dateTimeToUnixSeconds(value).toString();
  return value.toString();
}

/// `DateTime` → second-based Unix epoch as a `double`. Byte-identical to
/// upstream `configcat_client`'s `userAttribute.millisecondsSinceEpoch / 1000`.
double _dateTimeToUnixSeconds(DateTime value) =>
    value.millisecondsSinceEpoch / 1000;

/// Stringify a number as ConfigCat's canonical string (JS `Number.toString`).
/// NaN / ±Infinity print as "NaN" / "Infinity" / "-Infinity"; otherwise the
/// SHORTEST round-tripping digit sequence, fixed-point unless the magnitude
/// warrants exponential. The corpus `numberToStringConversion*` cases hinge on
/// this — e.g. `-1.23456789e+96` must NOT expand to its full integer form.
String numberToCanonicalString(double value) {
  if (value.isNaN) return 'NaN';
  if (value.isInfinite) return value > 0 ? 'Infinity' : '-Infinity';
  if (value == 0.0) return '0';
  return _jsNumberToString(value);
}

/// Render a finite non-zero double exactly as ECMAScript `Number.toString`.
String _jsNumberToString(double value) {
  final sign = value < 0 ? '-' : '';
  final av = value.abs();
  final (digits, point) = _shortestDigitsAndPoint(av);
  final k = digits.length;
  final n = point;

  if (n >= k && n <= 21) {
    return sign + digits + '0' * (n - k);
  }
  if (n > 0 && n <= 21) {
    return '$sign${digits.substring(0, n)}.${digits.substring(n)}';
  }
  if (n > -6 && n <= 0) {
    return '${sign}0.${'0' * -n}$digits';
  }
  final e = n - 1;
  final expSign = e >= 0 ? '+' : '-';
  final mant = k == 1 ? digits[0] : '${digits[0]}.${digits.substring(1)}';
  return '$sign${mant}e$expSign${e.abs()}';
}

/// Decompose the shortest round-tripping repr of a positive double into
/// `(digits, point)` — `point` is the count of significant digits before the
/// decimal point in normalized form (the ECMAScript `n`). Dart's
/// `double.toString()` produces the shortest round-tripping representation.
(String, int) _shortestDigitsAndPoint(double av) {
  final shortest = av.toString();
  String mant;
  int expVal;
  final lower = shortest.toLowerCase();
  if (lower.contains('e')) {
    final parts = lower.split('e');
    mant = parts[0];
    expVal = int.parse(parts[1]);
  } else {
    mant = shortest;
    expVal = 0;
  }
  String intPart;
  String fracPart;
  if (mant.contains('.')) {
    final dot = mant.indexOf('.');
    intPart = mant.substring(0, dot);
    fracPart = mant.substring(dot + 1);
  } else {
    intPart = mant;
    fracPart = '';
  }
  var raw = intPart + fracPart;
  var point = intPart.length + expVal;

  // Strip leading zeros (adjusting point), then trailing zeros.
  var lead = 0;
  final rawLen = raw.length;
  while (lead < rawLen - 1 && raw[lead] == '0') {
    lead++;
    point--;
  }
  raw = raw.substring(lead);
  // Trim trailing zeros.
  var end = raw.length;
  while (end > 1 && raw[end - 1] == '0') {
    end--;
  }
  raw = raw.substring(0, end);
  if (raw.isEmpty) raw = '0';
  return (raw, point);
}

final RegExp _leadingZeroRe = RegExp(r'^\s*$|^\s*0[^\d.eE]');
final RegExp _floatRe = RegExp(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$');

/// Strict whole-string float parse (common-js `parseFloatStrict`). Rejects
/// empty / all-whitespace and a leading `0` followed by a non-digit/non-`.`/
/// non-`e` (octal / hex). Returns NaN on rejection.
double parseFloatStrict(String value) {
  if (value.isEmpty || _leadingZeroRe.hasMatch(value)) return double.nan;
  final stripped = value.trim();
  if (stripped == 'Infinity') return double.infinity;
  if (stripped == '-Infinity') return double.negativeInfinity;
  if (stripped == 'NaN') return double.nan;
  if (!_floatRe.hasMatch(stripped)) return double.nan;
  return double.parse(stripped);
}

// ---------------------------------------------------------------------------
// Text — cleartext (case-sensitive, no trim)
// ---------------------------------------------------------------------------

/// Cleartext equals / notEquals.
bool evaluateTextEquals(String text, String comparisonValue, bool negate) =>
    (text == comparisonValue) != negate;

/// Cleartext isOneOf / isNotOneOf.
bool evaluateTextIsOneOf(
  String text,
  List<String> comparisonValues,
  bool negate,
) =>
    comparisonValues.contains(text) != negate;

/// Cleartext contains / notContains any of.
bool evaluateTextContainsAnyOf(
  String text,
  List<String> comparisonValues,
  bool negate,
) {
  for (final item in comparisonValues) {
    if (text.contains(item)) return !negate;
  }
  return negate;
}

/// Cleartext startsWith/endsWith-any-of. Items longer than text skipped.
bool evaluateTextSliceEqualsAnyOf(
  String text,
  List<String> comparisonValues,
  bool startsWith,
  bool negate,
) {
  for (final item in comparisonValues) {
    if (text.length < item.length) continue;
    final matched = startsWith ? text.startsWith(item) : text.endsWith(item);
    if (matched) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Text — sensitive (SHA-256 salted)
// ---------------------------------------------------------------------------

/// Sensitive equals / notEquals.
bool evaluateSensitiveTextEquals(
  String text,
  String comparisonValue,
  String configSalt,
  String contextSalt,
  bool negate,
) {
  final hash = hashComparisonValue(text, configSalt, contextSalt);
  return (hash == comparisonValue) != negate;
}

/// Sensitive isOneOf / isNotOneOf.
bool evaluateSensitiveTextIsOneOf(
  String text,
  List<String> comparisonValues,
  String configSalt,
  String contextSalt,
  bool negate,
) {
  final hash = hashComparisonValue(text, configSalt, contextSalt);
  return comparisonValues.contains(hash) != negate;
}

final RegExp _digitsRe = RegExp(r'^\d+$');

/// Sensitive startsWith/endsWith-any-of. Each operand is "<byteLen>_<hash>";
/// the SDK hashes the matching-length BYTE prefix/suffix of the attribute and
/// compares to <hash>. Slicing is over the UTF-8 byte sequence (not code
/// points), matching common-js.
bool evaluateSensitiveTextSliceEqualsAnyOf(
  String text,
  List<String> comparisonValues,
  String configSalt,
  String contextSalt,
  bool startsWith,
  bool negate,
) {
  final textBytes = utf8.encode(text);
  final textLen = textBytes.length;
  for (final item in comparisonValues) {
    final index = item.indexOf('_');
    if (index < 0) continue;
    final sliceLengthStr = item.substring(0, index);
    if (!_digitsRe.hasMatch(sliceLengthStr)) continue;
    final sliceLength = int.parse(sliceLengthStr);
    if (textLen < sliceLength) continue;
    final sliceUtf8 = startsWith
        ? textBytes.sublist(0, sliceLength)
        : textBytes.sublist(textLen - sliceLength);
    final hash = hashComparisonValueSlice(sliceUtf8, configSalt, contextSalt);
    if (hash == item.substring(index + 1)) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

/// Semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5). Each operand is trimmed
/// first; an operand that is empty AFTER trimming (incl. whitespace-only) is
/// skipped — matching ConfigCat, which trims before the empty check. A
/// non-empty but unparseable operand makes the whole comparator `false`
/// (backward-compat). Iterates ALL operands (no early-out on match).
bool evaluateSemverIsOneOf(
  SemVer version,
  List<String> comparisonValues,
  bool negate,
) {
  var result = false;
  for (final rawItem in comparisonValues) {
    final item = rawItem.trim();
    if (item.isEmpty) continue;
    final version2 = SemVer.parse(item);
    if (version2 == null) return false;
    if (!result && version.compare(version2) == 0) result = true;
  }
  return result != negate;
}

/// Semver relations (comparators 6-9). Unparseable operand → `false`.
bool evaluateSemverRelation(
  SemVer version,
  int comparator,
  String comparisonValue,
) {
  final version2 = SemVer.parse(comparisonValue.trim());
  if (version2 == null) return false;
  final cmp = version.compare(version2);
  switch (comparator) {
    case Cmp.semverLess:
      return cmp < 0;
    case Cmp.semverLessOrEquals:
      return cmp <= 0;
    case Cmp.semverGreater:
      return cmp > 0;
    case Cmp.semverGreaterOrEquals:
      return cmp >= 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

/// Number relations (comparators 10-15).
bool evaluateNumberRelation(
    double num, int comparator, double comparisonValue) {
  switch (comparator) {
    case Cmp.numberEquals:
      return num == comparisonValue;
    case Cmp.numberNotEquals:
      return num != comparisonValue;
    case Cmp.numberLess:
      return num < comparisonValue;
    case Cmp.numberLessOrEquals:
      return num <= comparisonValue;
    case Cmp.numberGreater:
      return num > comparisonValue;
    case Cmp.numberGreaterOrEquals:
      return num >= comparisonValue;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Datetime (Unix seconds)
// ---------------------------------------------------------------------------

/// Datetime relations (Before/After, Unix seconds).
bool evaluateDatetimeRelation(
        double seconds, double comparisonValue, bool before) =>
    before ? seconds < comparisonValue : seconds > comparisonValue;

// ---------------------------------------------------------------------------
// Array (cleartext + sensitive)
// ---------------------------------------------------------------------------

/// Cleartext array contains / notContains any of.
bool evaluateArrayContainsAnyOf(
  List<String> array,
  List<String> comparisonValues,
  bool negate,
) {
  for (final item in array) {
    if (comparisonValues.contains(item)) return !negate;
  }
  return negate;
}

/// Sensitive array contains / notContains any of.
bool evaluateSensitiveArrayContainsAnyOf(
  List<String> array,
  List<String> comparisonValues,
  String configSalt,
  String contextSalt,
  bool negate,
) {
  for (final item in array) {
    final hash = hashComparisonValue(item, configSalt, contextSalt);
    if (comparisonValues.contains(hash)) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Attribute → typed value, with three-valued error outcome (FR-010)
// ---------------------------------------------------------------------------

ValidationError _invalidAttr(String attr, String reason) =>
    error('cannot evaluate, the User.$attr attribute is invalid ($reason)');

bool _isNumericNonBool(Object? value) =>
    (value is int || value is double) && value is! bool;

double _asDouble(Object value) =>
    value is int ? value.toDouble() : value as double;

/// Attribute → text (string verbatim; else stringified — never errors).
String attributeAsText(Object? value) =>
    value is String ? value : userAttributeValueToString(value);

/// Attribute → semver, or a validation error.
Object attributeAsSemver(String attr, Object? value) {
  if (value is String) {
    final version = SemVer.parse(value.trim());
    if (version != null) return version;
  }
  return _invalidAttr(
    attr,
    "'${userAttributeValueToString(value)}' is not a valid semantic version",
  );
}

/// Attribute → number, or a validation error.
Object attributeAsNumber(String attr, Object? value) {
  if (_isNumericNonBool(value)) return _asDouble(value!);
  if (value is String) {
    final num = parseFloatStrict(value.replaceFirst(',', '.'));
    if (!num.isNaN || value.trim() == 'NaN') return num;
  }
  return _invalidAttr(
    attr,
    "'${userAttributeValueToString(value)}' is not a valid decimal number",
  );
}

/// Attribute → Unix seconds, or a validation error. A `DateTime` is
/// converted to second-based epoch (mirrors upstream
/// `_getUserAttributeForDate`); a numeric attribute is already seconds; a
/// string is parsed strictly.
Object attributeAsUnixTimeSeconds(String attr, Object? value) {
  if (value is DateTime) return _dateTimeToUnixSeconds(value);
  if (_isNumericNonBool(value)) return _asDouble(value!);
  if (value is String) {
    final num = parseFloatStrict(value.replaceFirst(',', '.'));
    if (!num.isNaN || value.trim() == 'NaN') return num;
  }
  return _invalidAttr(
    attr,
    "'${userAttributeValueToString(value)}' is not a valid Unix timestamp "
    '(number of seconds elapsed since Unix epoch)',
  );
}

/// Attribute → string array, or a validation error. A string attribute is
/// JSON-parsed; the result must be a string array.
Object attributeAsStringArray(String attr, Object? value) {
  Object? arr = value;
  if (arr is String) {
    try {
      final decoded = jsonDecode(arr);
      if (decoded != null) arr = decoded;
      // ignore: avoid_catches_without_on_clauses — non-JSON falls through.
    } catch (_) {
      // A non-JSON string is simply not a valid array (matches common-js
      // no-op catch); falls through to the validation error below.
    }
  }
  if (isStringArray(arr)) {
    return List<String>.from(arr! as List);
  }
  return _invalidAttr(
    attr,
    "'${userAttributeValueToString(value)}' is not a valid string array",
  );
}
