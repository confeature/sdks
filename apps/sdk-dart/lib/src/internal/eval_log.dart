// SPDX-License-Identifier: MIT

/// ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
/// Dart slice of #501).
///
/// Dart port of the spec-117 TS reference
/// (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder`), cross-checked
/// against the Python (`apps/sdk-python/src/confeature_client/eval_log.py`),
/// Ruby (`apps/sdk-ruby/lib/confeature/internal/eval_log.rb`), Go, .NET, Rust,
/// and PHP (`apps/sdk-php/src/Internal/{EvalLog,EvaluateLogBuilder}.php`) ports.
/// Produces the byte-identical indented textual trace ConfigCat's SDKs emit
/// during flag evaluation — its `evaluationlog/` corpus (replayed via
/// `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is
/// the byte-oracle. This builder mirrors the TS class line-for-line so the
/// federation ports stay consistent.
///
/// The trace is emitted via the trace logger at INFO under event id 5000
/// (ConfigCat's verbosity contract) — see `evaluateTraced` in evaluator.dart.
/// The strings are ported VERBATIM from the canonical (Principle II).
library;

import 'comparators.dart';
import 'prerequisites.dart';
import 'segments.dart';

/// ConfigCat's event id for the "config evaluated" INFO log line.
const String evalLogEventId = '5000';

/// ConfigCat indents each nested eval-log line by two spaces per level.
const String _indentUnit = '  ';

// Placeholders ConfigCat substitutes for malformed condition parts (parity
// with configcat-common's EvaluateLogBuilder).
const String _invalidValuePlaceholder = '<invalid value>';
const String _invalidNamePlaceholder = '<invalid name>';
const String _invalidOperatorPlaceholder = '<invalid operator>';

/// Max IS-ONE-OF / list items rendered before truncation (configcat parity).
const int _stringListMaxLength = 10;

/// Per-comparator eval-log metadata (configcat-common parity), as
/// `(token, kind, sensitive)` — `token` is the operator rendering, `kind`
/// selects the condition value slot (`l`=list, `s`=string, `n`=number,
/// `dt`=datetime), `sensitive` masks the value as `<hashed value>`. One table
/// drives the condition rendering, mirroring eval-log.ts COMPARATOR_META.
const Map<int, (String, String, bool)> _comparatorMeta =
    <int, (String, String, bool)>{
  Cmp.textIsOneOf: ('IS ONE OF', 'l', false),
  Cmp.textIsNotOneOf: ('IS NOT ONE OF', 'l', false),
  Cmp.textContainsAnyOf: ('CONTAINS ANY OF', 'l', false),
  Cmp.textNotContainsAnyOf: ('NOT CONTAINS ANY OF', 'l', false),
  Cmp.semverIsOneOf: ('IS ONE OF', 'l', false),
  Cmp.semverIsNotOneOf: ('IS NOT ONE OF', 'l', false),
  Cmp.semverLess: ('<', 's', false),
  Cmp.semverLessOrEquals: ('<=', 's', false),
  Cmp.semverGreater: ('>', 's', false),
  Cmp.semverGreaterOrEquals: ('>=', 's', false),
  Cmp.numberEquals: ('=', 'n', false),
  Cmp.numberNotEquals: ('!=', 'n', false),
  Cmp.numberLess: ('<', 'n', false),
  Cmp.numberLessOrEquals: ('<=', 'n', false),
  Cmp.numberGreater: ('>', 'n', false),
  Cmp.numberGreaterOrEquals: ('>=', 'n', false),
  Cmp.sensitiveTextIsOneOf: ('IS ONE OF', 'l', true),
  Cmp.sensitiveTextIsNotOneOf: ('IS NOT ONE OF', 'l', true),
  Cmp.datetimeBefore: ('BEFORE', 'dt', false),
  Cmp.datetimeAfter: ('AFTER', 'dt', false),
  Cmp.sensitiveTextEquals: ('EQUALS', 's', true),
  Cmp.sensitiveTextNotEquals: ('NOT EQUALS', 's', true),
  Cmp.sensitiveTextStartsWithAnyOf: ('STARTS WITH ANY OF', 'l', true),
  Cmp.sensitiveTextNotStartsWithAnyOf: ('NOT STARTS WITH ANY OF', 'l', true),
  Cmp.sensitiveTextEndsWithAnyOf: ('ENDS WITH ANY OF', 'l', true),
  Cmp.sensitiveTextNotEndsWithAnyOf: ('NOT ENDS WITH ANY OF', 'l', true),
  Cmp.sensitiveArrayContainsAnyOf: ('ARRAY CONTAINS ANY OF', 'l', true),
  Cmp.sensitiveArrayNotContainsAnyOf: ('ARRAY NOT CONTAINS ANY OF', 'l', true),
  Cmp.textEquals: ('EQUALS', 's', false),
  Cmp.textNotEquals: ('NOT EQUALS', 's', false),
  Cmp.textStartsWithAnyOf: ('STARTS WITH ANY OF', 'l', false),
  Cmp.textNotStartsWithAnyOf: ('NOT STARTS WITH ANY OF', 'l', false),
  Cmp.textEndsWithAnyOf: ('ENDS WITH ANY OF', 'l', false),
  Cmp.textNotEndsWithAnyOf: ('NOT ENDS WITH ANY OF', 'l', false),
  Cmp.arrayContainsAnyOf: ('ARRAY CONTAINS ANY OF', 'l', false),
  Cmp.arrayNotContainsAnyOf: ('ARRAY NOT CONTAINS ANY OF', 'l', false),
};

/// Render a `UserComparator` as ConfigCat's eval-log operator token.
String formatUserComparator(int comparator) =>
    _comparatorMeta[comparator]?.$1 ?? _invalidOperatorPlaceholder;

/// Format a string list exactly as configcat-common's `formatStringList`:
/// `'a', 'b'` joined by `, `, with an optional truncation appendix once
/// [maxLength] is exceeded.
String formatStringList(List<String> items, int maxLength) {
  if (items.isEmpty) return '';
  var appendix = '';
  var shown = items;
  if (maxLength > 0 && items.length > maxLength) {
    shown = items.sublist(0, maxLength);
    final count = items.length - maxLength;
    final word = count == 1 ? 'value' : 'values';
    appendix = ', ... <$count more $word>';
  }
  return "'${shown.join("', '")}'$appendix";
}

/// Format a resolved SETTING value for the eval log (ConfigCat parity):
/// boolean → `true`/`false` (lowercase), string → verbatim, number → its
/// canonical decimal string. Mirrors the `'<value>'` token in ConfigCat's
/// `Returning '<value>'.` footer (eval-log.ts `settingValueToString`).
String settingValueToLogString(Object? value) {
  if (value is bool) return value ? 'true' : 'false';
  if (value is String) return value;
  if (value is int) return numberToCanonicalString(value.toDouble());
  if (value is double) return numberToCanonicalString(value);
  return '';
}

/// Render a Unix-seconds value as ConfigCat's eval-log datetime suffix:
/// JS `new Date(value*1000).toISOString()`, e.g. `2023-04-01T00:00:00.000Z`
/// (always millisecond precision, UTC). Returns null for non-finite values
/// (NaN / ±Inf), matching the JS `isNaN(date)` guard.
String? unixSecondsToIso(double seconds) {
  if (seconds.isNaN || seconds.isInfinite) return null;
  final ms = (seconds * 1000).round();
  final dt = DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
  final y = dt.year.toString().padLeft(4, '0');
  final mo = dt.month.toString().padLeft(2, '0');
  final d = dt.day.toString().padLeft(2, '0');
  final h = dt.hour.toString().padLeft(2, '0');
  final mi = dt.minute.toString().padLeft(2, '0');
  final s = dt.second.toString().padLeft(2, '0');
  final mil = dt.millisecond.toString().padLeft(3, '0');
  return '$y-$mo-${d}T$h:$mi:$s.${mil}Z';
}

String _boolToLogString(bool value) => value ? 'true' : 'false';

/// Three-valued THEN consequence (MATCH / no match / error string) for the
/// eval-log trace. Mirrors the TS `boolean | string` union and the PHP /
/// Python / Ruby ports' `MatchOrError`.
class MatchOrError {
  const MatchOrError._(this.kind, [this.errText = '']);

  /// A matched rule.
  factory MatchOrError.match() => const MatchOrError._(matchKind);

  /// A non-matched rule.
  factory MatchOrError.noMatch() => const MatchOrError._(noMatchKind);

  /// An errored rule carrying the reason [text].
  factory MatchOrError.error(String text) => MatchOrError._(erroredKind, text);

  /// `MATCH` discriminator.
  static const String matchKind = 'match';

  /// `no match` discriminator.
  static const String noMatchKind = 'no_match';

  /// `errored` discriminator.
  static const String erroredKind = 'errored';

  /// One of [matchKind] / [noMatchKind] / [erroredKind].
  final String kind;

  /// The reason text for the error case.
  final String errText;
}

/// indent / newLine / append primitives + the condition-rendering helpers
/// (ADR 0003). Mirrors eval-log.ts `EvaluateLogBuilder` line-for-line.
///
/// `eol` defaults to `"\n"` — the byte the upstream oracle uses.
class EvaluateLogBuilder {
  /// Construct a builder with an optional end-of-line sequence.
  EvaluateLogBuilder([this._eol = '\n']);

  final String _eol;
  final List<String> _chunks = <String>[];
  int _indentLevel = 0;

  /// Append text to the current line.
  EvaluateLogBuilder append(String text) {
    _chunks.add(text);
    return this;
  }

  /// Break to a new line at the current indent, then optionally append [text].
  EvaluateLogBuilder newLine([String? text]) {
    _chunks.add(_eol + (_indentUnit * _indentLevel));
    if (text != null) _chunks.add(text);
    return this;
  }

  /// Increase the indentation by one level.
  EvaluateLogBuilder increaseIndent() {
    _indentLevel++;
    return this;
  }

  /// Decrease the indentation by one level (never below zero).
  EvaluateLogBuilder decreaseIndent() {
    if (_indentLevel > 0) _indentLevel--;
    return this;
  }

  // ---- condition formatting ------------------------------------------------

  /// Render one user condition (`User.<attr> <COMP> <value>`). The compact
  /// condition carries the value in `l` (list), `s` (string / sensitive-equals),
  /// or `d` (number / datetime), selected by the comparator kind.
  EvaluateLogBuilder appendUserCondition(Map<dynamic, dynamic> condition) {
    final rawAttr = condition['a'];
    final attr = rawAttr is String ? rawAttr : _invalidNamePlaceholder;
    final rawCmp = condition['c'];
    final cmp = rawCmp is int ? rawCmp : -1;
    final meta = _comparatorMeta[cmp];
    if (meta == null) {
      return _appendUnknownUserCondition(attr, cmp, condition);
    }
    final kind = meta.$2;
    final sensitive = meta.$3;
    switch (kind) {
      case 'l':
        final raw = condition['l'];
        return _appendUserConditionStringList(
            attr, cmp, raw is List ? _stringList(raw) : null, sensitive);
      case 's':
        return _appendUserConditionString(attr, cmp, condition['s'], sensitive);
      case 'n':
        return _appendUserConditionNumber(
            attr, cmp, _floatOrNull(condition['d']), false);
      default:
        return _appendUserConditionNumber(
            attr, cmp, _floatOrNull(condition['d']), true);
    }
  }

  /// Append a single condition's boolean result (` => true` / ` => false…`).
  EvaluateLogBuilder appendConditionConsequence(bool result) {
    append(' => ${_boolToLogString(result)}');
    return result ? this : append(', skipping the remaining AND conditions');
  }

  /// Append a targeting rule's THEN consequence. [thenValue] is the rule's
  /// formatted served value (e.g. `Dog`) for a fixed-value rule, or null for a
  /// rule serving `% options`. [match] is MATCH / no match / an error.
  EvaluateLogBuilder appendTargetingRuleConsequence(
    String? thenValue,
    MatchOrError match,
    bool newLineBeforeThen,
  ) {
    increaseIndent();
    // `newLineBeforeThen` (the param) must NOT shadow the `newLine` builder
    // method: break to a fresh line when the rule had conditions, else a single
    // space before `THEN` (mirrors eval-log.ts appendTargetingRuleConsequence).
    if (newLineBeforeThen) {
      newLine();
    } else {
      append(' ');
    }
    append('THEN');
    append(thenValue == null ? ' % options' : " '$thenValue'");
    append(' => ');
    switch (match.kind) {
      case MatchOrError.matchKind:
        append('MATCH, applying rule');
        break;
      case MatchOrError.noMatchKind:
        append('no match');
        break;
      default:
        append(match.errText);
        break;
    }
    return decreaseIndent();
  }

  /// Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`).
  EvaluateLogBuilder appendPrerequisiteFlagCondition(
    String prereqKey,
    int comparator,
    String comparisonValue,
  ) {
    final op = comparator == prerequisiteNotEquals ? 'NOT EQUALS' : 'EQUALS';
    return append("Flag '$prereqKey' $op '$comparisonValue'");
  }

  /// Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`).
  EvaluateLogBuilder appendSegmentCondition(
      String segmentName, int comparator) {
    final op =
        comparator == segmentIsNotIn ? 'IS NOT IN SEGMENT' : 'IS IN SEGMENT';
    return append("User $op '$segmentName'");
  }

  /// Append a bare boolean condition result (`true` / `false`).
  EvaluateLogBuilder appendConditionResult(bool result) =>
      append(_boolToLogString(result));

  @override
  String toString() => _chunks.join();

  // ---- internal ------------------------------------------------------------

  EvaluateLogBuilder _appendUnknownUserCondition(
    String attr,
    int cmp,
    Map<dynamic, dynamic> condition,
  ) {
    final sv = condition['s'];
    if (sv is String) {
      return _appendUserConditionCore(attr, cmp, sv);
    }
    final dv = condition['d'];
    if (dv is int || dv is double) {
      return _appendUserConditionCore(
          attr, cmp, numberToCanonicalString((dv as num).toDouble()));
    }
    final lv = condition['l'];
    if (lv is List && lv.isNotEmpty) {
      final first = lv.first;
      return _appendUserConditionCore(
          attr, cmp, first is String ? first : first.toString());
    }
    return _appendUserConditionCore(attr, cmp, '');
  }

  EvaluateLogBuilder _appendUserConditionCore(
    String attr,
    int comparator,
    String value,
  ) {
    final v = value.isEmpty ? _invalidValuePlaceholder : value;
    return append("User.$attr ${formatUserComparator(comparator)} '$v'");
  }

  EvaluateLogBuilder _appendUserConditionString(
    String attr,
    int comparator,
    Object? value,
    bool isSensitive,
  ) {
    if (value is! String) {
      return _appendUserConditionCore(attr, comparator, '');
    }
    if (isSensitive) {
      return _appendUserConditionCore(attr, comparator, '<hashed value>');
    }
    return _appendUserConditionCore(attr, comparator, value);
  }

  EvaluateLogBuilder _appendUserConditionStringList(
    String attr,
    int comparator,
    List<String>? values,
    bool isSensitive,
  ) {
    if (values == null) {
      return _appendUserConditionCore(attr, comparator, '');
    }
    final comparatorText = formatUserComparator(comparator);
    if (isSensitive) {
      final word = values.length == 1 ? 'value' : 'values';
      return append('User.$attr $comparatorText '
          '[<${values.length} hashed $word>]');
    }
    final listText = formatStringList(values, _stringListMaxLength);
    return append('User.$attr $comparatorText [$listText]');
  }

  EvaluateLogBuilder _appendUserConditionNumber(
    String attr,
    int comparator,
    double? value,
    bool isDatetime,
  ) {
    if (value == null) {
      return _appendUserConditionCore(attr, comparator, '');
    }
    final comparatorText = formatUserComparator(comparator);
    final valueText = numberToCanonicalString(value);
    if (isDatetime) {
      final iso = unixSecondsToIso(value);
      if (iso != null) {
        return append("User.$attr $comparatorText '$valueText' ($iso UTC)");
      }
    }
    return append("User.$attr $comparatorText '$valueText'");
  }

  double? _floatOrNull(Object? value) {
    if (value is int) return value.toDouble();
    if (value is double) return value;
    return null;
  }

  List<String> _stringList(List<dynamic> raw) {
    final out = <String>[];
    for (final item in raw) {
      out.add(item is String ? item : item.toString());
    }
    return out;
  }
}
