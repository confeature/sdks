// SPDX-License-Identifier: MIT

/// ConfigCat conformance gate (spec 123, SC-001) — the Dart engine replays the
/// vendored upstream evaluation matrix. Mirrors the spec-117 TS reference suite
/// and the spec-118/119/120/121/122 Python / Go / Ruby / PHP / .NET ports
/// (PHP `EvaluatorUpstreamCorpusTest` is the closest precedent). The corpus
/// (`packages/test-fixtures-sdk-parity/fixtures/upstream/`) is the oracle: each
/// `(config, key, user) → expected` tuple is checked against the Dart
/// `evaluateWith(...).value` (and `.variationId` for the variation matrix).
///
/// Scope = the full conformance surface: US1 targeting rules, US2 the 36
/// comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
/// multilevel + circular detection) / AND-groups, US5 attribute conversion +
/// trimming + typed-attribute validation + variationId / matched detail. Per
/// FR-017 only structured value / identity is asserted — never a textual trace.
///
/// The CSV reader ports the Go `csv.Reader` LazyQuotes semantics (a `"` only
/// opens a quoted field at the field start) — without it every JSON-array
/// attribute cell is corrupted. Custom attributes are fed through [_CorpusUser]
/// (a duck-typed [EvalUser]) so the conversion-driver cases deliver numbers /
/// arrays / epochs un-stringified.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/evaluator.dart';
// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/trace_log.dart';

import 'workspace_root.dart';

const String _nullToken = '##null##';
const String _pkd = 'configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/';
const String _jcp = 'configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/';

/// `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob
/// was NOT vendored (known DATA gap #401, not an engine gap). The multilevel
/// path is exercised by the 3-level circular_dep chain + the reconstructed
/// chain test below. Excluded LOUDLY (the same marker the references use).
const List<String> _unvendoredEvalLogKeys = <String>[
  'dependentFeatureMultipleLevels'
];

// ---------------------------------------------------------------------------
// Duck-typed corpus user (typed custom attributes).
// ---------------------------------------------------------------------------

class _CorpusUser implements EvalUser {
  const _CorpusUser(this.identifier, this.email, this.country, this._custom);

  @override
  final String identifier;
  @override
  final String? email;
  @override
  final String? country;
  final Map<String, Object?>? _custom;

  @override
  Object? customAttribute(String name) => _custom?[name];

  @override
  Map<String, Object?>? get customAttributes => _custom;

  @override
  String toString() =>
      'id=$identifier email=$email country=$country custom=$_custom';
}

// ---------------------------------------------------------------------------
// Matrix → SDK key mapping (verbatim from upstream-corpus.ts / the PHP port).
// ---------------------------------------------------------------------------

class _MatrixEntry {
  const _MatrixEntry(this.matrix, this.sdkKey, this.kind);
  final String matrix;
  final String sdkKey;
  final String kind; // 'value' | 'variation'
}

const List<_MatrixEntry> _matrixEntries = <_MatrixEntry>[
  _MatrixEntry('testmatrix.csv', '${_pkd}AG6C1ngVb0CvM07un6JisQ', 'value'),
  _MatrixEntry(
      'testmatrix_semantic.csv', '${_pkd}iV8vH2MBakKxkFZylxHmTg', 'value'),
  _MatrixEntry(
      'testmatrix_number.csv', '${_pkd}FCWN-k1dV0iBf8QZrDgjdw', 'value'),
  _MatrixEntry(
      'testmatrix_semantic_2.csv', '${_pkd}U8nt3zEhDEO5S2ulubCopA', 'value'),
  _MatrixEntry(
      'testmatrix_sensitive.csv', '$_pkd-0YmVOUNgEGKkgRF-rU65g', 'value'),
  _MatrixEntry(
      'testmatrix_segments_old.csv', '${_pkd}y_ZB7o-Xb0Swxth-ZlMSeA', 'value'),
  _MatrixEntry(
      'testmatrix_and_or.csv', '${_jcp}ByMO9yZNn02kXcm72lnY1A', 'value'),
  _MatrixEntry('testmatrix_comparators_v6.csv', '${_jcp}OfQqcTjfFUGBwMKqtyEOrQ',
      'value'),
  _MatrixEntry('testmatrix_prerequisite_flag.csv',
      '${_jcp}JoGwdqJZQ0K2xDy7LnbyOg', 'value'),
  _MatrixEntry(
      'testmatrix_segments.csv', '${_jcp}h99HYXWWNE2bH8eWyLAVMA', 'value'),
  _MatrixEntry(
      'testmatrix_unicode.csv', '${_jcp}Da6w8dBbmUeMUBhh0iEeQQ', 'value'),
  _MatrixEntry('testmatrix_variationId.csv', '${_pkd}spQnkRTIPEWVivZkWM84lQ',
      'variation'),
];

_MatrixEntry _matrixEntry(String matrix) =>
    _matrixEntries.firstWhere((e) => e.matrix == matrix,
        orElse: () => throw StateError('Unknown testmatrix file: $matrix'));

// ---------------------------------------------------------------------------
// Cached config loaders.
// ---------------------------------------------------------------------------

Map<String, dynamic>? _contentByKeyCache;
Map<String, dynamic>? _evalLogConfigsCache;

Map<String, dynamic> _upstreamJson(String relativePath) {
  final raw = File(upstreamPath(relativePath)).readAsStringSync();
  final data = jsonDecode(raw);
  if (data is! Map) {
    throw StateError('Upstream fixture is not a JSON object: $relativePath');
  }
  return Map<String, dynamic>.from(data);
}

String _upstreamText(String relativePath) =>
    File(upstreamPath(relativePath)).readAsStringSync();

Map<String, dynamic> _contentByKey() =>
    _contentByKeyCache ??= _upstreamJson('content-by-key.json');

Map<String, dynamic> _evalLogConfigs() => _evalLogConfigsCache ??=
    _upstreamJson('evaluationlog/_configs-by-key.json');

// ---------------------------------------------------------------------------
// CSV parsing — Go csv.Reader, Comma=';', LazyQuotes=true.
// ---------------------------------------------------------------------------

List<String> _parseCsvLine(String line) {
  final fields = <String>[];
  final field = StringBuffer();
  var inQuotes = false;
  var fieldStart = true;
  var i = 0;
  final n = line.length;
  while (i < n) {
    final ch = line[i];
    if (inQuotes && ch == '"' && i + 1 < n && line[i + 1] == '"') {
      field.write('"');
      i++;
    } else if (inQuotes && ch == '"') {
      inQuotes = false;
    } else if (inQuotes) {
      field.write(ch);
    } else if (ch == '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch == ';') {
      fields.add(field.toString());
      field.clear();
      fieldStart = true;
    } else {
      field.write(ch);
      fieldStart = false;
    }
    i++;
  }
  fields.add(field.toString());
  return fields;
}

final RegExp _intRe = RegExp(r'^-?\d+$');
final RegExp _floatCellRe = RegExp(r'^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$');

/// Parse a CSV cell to its primitive (mirrors upstream `parseCell`).
Object _parseCell(String s) {
  if (_intRe.hasMatch(s)) {
    final n = int.tryParse(s);
    if (n != null && n.abs() <= 9007199254740991 && n.toString() == s) {
      return n;
    }
  }
  if (_floatCellRe.hasMatch(s)) {
    final d = double.tryParse(s);
    if (d != null) return d;
  }
  if (s == 'True') return true;
  if (s == 'False') return false;
  return s;
}

String? _setOrNull(String? v) =>
    (v == null || v.isEmpty || v == _nullToken) ? null : v;

_CorpusUser? _userFromRow(List<String> line, String customKey) {
  if (line.isEmpty || (line.isNotEmpty ? line[0] : '') == _nullToken) {
    return null;
  }
  final identifier = line.isNotEmpty && line[0].isNotEmpty ? line[0] : '';
  final email = _setOrNull(line.length > 1 ? line[1] : null);
  final country = _setOrNull(line.length > 2 ? line[2] : null);
  final customVal = _setOrNull(line.length > 3 ? line[3] : null);
  final custom =
      customVal == null ? null : <String, Object?>{customKey: customVal};
  return _CorpusUser(identifier, email, country, custom);
}

class _MatrixTuple {
  const _MatrixTuple(
      this.key, this.user, this.kind, this.expected, this.config);
  final String key;
  final _CorpusUser? user;
  final String kind;
  final Object? expected;
  final Map<String, dynamic> config;
}

List<_MatrixTuple> _loadMatrix(String matrix) {
  final entry = _matrixEntry(matrix);
  final config = _contentByKey()[entry.sdkKey];
  if (config is! Map) {
    throw StateError('No config for matrix $matrix (sdkKey ${entry.sdkKey})');
  }
  final cfg = Map<String, dynamic>.from(config);

  final text = _upstreamText(matrix);
  final lines = text
      .split(RegExp(r'\r?\n'))
      .where((l) => l.isNotEmpty)
      .toList(growable: false);
  final header = _parseCsvLine(lines[0]);
  final customKey = header.length > 3 ? header[3] : 'Custom1';
  final settingKeys = header.sublist(4);

  final tuples = <_MatrixTuple>[];
  for (var r = 1; r < lines.length; r++) {
    final cols = _parseCsvLine(lines[r]);
    final user = _userFromRow(cols, customKey);
    for (var c = 0; c < settingKeys.length; c++) {
      final raw = (c + 4) < cols.length ? cols[c + 4] : '';
      final Object expected = entry.kind == 'value' ? _parseCell(raw) : raw;
      tuples.add(_MatrixTuple(settingKeys[c], user, entry.kind, expected, cfg));
    }
  }
  return tuples;
}

// ---------------------------------------------------------------------------
// evaluationlog/<scenario> loader.
// ---------------------------------------------------------------------------

_CorpusUser? _evalLogUser(Map<String, dynamic>? raw) {
  if (raw == null || raw.isEmpty) return null;
  var identifier = '';
  String? email;
  String? country;
  final custom = <String, Object?>{};
  raw.forEach((k, v) {
    switch (k) {
      case 'Identifier':
        identifier = v?.toString() ?? '';
        break;
      case 'Email':
        email = v?.toString();
        break;
      case 'Country':
        country = v?.toString();
        break;
      default:
        // Custom attrs keep their native JSON-decoded type.
        custom[k] = v;
    }
  });
  return _CorpusUser(
      identifier, email, country, custom.isEmpty ? null : custom);
}

Map<String, dynamic> _evalLogConfig(Map<String, dynamic> suite) {
  final jsonOverride = suite['jsonOverride'];
  if (jsonOverride is String) {
    return _upstreamJson('evaluationlog/_overrides/$jsonOverride');
  }
  final sdkKey = suite['sdkKey'];
  if (sdkKey is String) {
    final config = _contentByKey()[sdkKey] ?? _evalLogConfigs()[sdkKey];
    if (config is! Map) {
      throw StateError('No config for eval-log sdkKey $sdkKey');
    }
    return Map<String, dynamic>.from(config);
  }
  throw StateError('Eval-log suite has neither jsonOverride nor sdkKey');
}

class _EvalLogTuple {
  const _EvalLogTuple(this.scenario, this.key, this.defaultValue, this.user,
      this.expected, this.config);
  final String scenario;
  final String key;
  final Object? defaultValue;
  final _CorpusUser? user;
  final Object? expected;
  final Map<String, dynamic> config;
}

List<_EvalLogTuple> _loadEvalLogScenario(String scenario) {
  final suite = _upstreamJson('evaluationlog/$scenario.json');
  final config = _evalLogConfig(suite);
  final tests = suite['tests'];
  final out = <_EvalLogTuple>[];
  if (tests is List) {
    for (final t in tests) {
      if (t is! Map) continue;
      out.add(_EvalLogTuple(
        scenario,
        (t['key'] ?? '').toString(),
        t['defaultValue'],
        _evalLogUser(t['user'] is Map
            ? Map<String, dynamic>.from(t['user'] as Map)
            : null),
        t['returnValue'],
        config,
      ));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

int? _settingType(Map<String, dynamic> config, String key) {
  final settings = config['f'];
  final setting = settings is Map ? settings[key] : null;
  final t = setting is Map ? setting['t'] : null;
  return (t is int) ? t : null;
}

/// Type-appropriate default matching the resolved primitive type. The strict
/// evaluator distinguishes int (t=2) from double (t=3).
Object _defaultFor(Object? expected, int? settingType) {
  if (expected is bool) return false;
  if (expected is num) return settingType == 3 ? 0.0 : 0;
  return '__default__';
}

/// Cast a JSON-decoded eval-log default to the type implied by `t`.
Object? _coerceDefault(Object? def, int? settingType) {
  if (def is bool) return def;
  if (settingType == 3 && def is int) return def.toDouble();
  if (settingType == 2 && def is double) return def.toInt();
  return def;
}

/// Numeric-tolerant equality (5 == 5.0); booleans must not equate with ints.
bool _valueEqual(Object? actual, Object? expected) {
  if (expected is num && expected is! bool) {
    if (actual is bool) return false;
    if (expected is double && expected.isNaN) {
      return actual is double && actual.isNaN;
    }
    return actual is num && actual == expected;
  }
  if ((expected is bool) != (actual is bool)) return false;
  return actual == expected;
}

void _assertMatrixTuple(_MatrixTuple t, List<String> failures) {
  final label = '${t.key} user=${t.user}';
  if (t.kind == 'variation') {
    final result = evaluateWith<Object?>(t.config, t.key, null, t.user);
    if (result.variationId != t.expected) {
      failures
          .add('$label: actual=${result.variationId} expected=${t.expected}');
    }
    return;
  }
  final st = _settingType(t.config, t.key);
  final def = _defaultFor(t.expected, st);
  final result = evaluateWith<Object?>(t.config, t.key, def, t.user);
  if (!_valueEqual(result.value, t.expected)) {
    failures.add('$label: actual=${result.value} expected=${t.expected}');
  }
}

void _assertEvalLogValue(_EvalLogTuple t, List<String> failures) {
  final st = _settingType(t.config, t.key);
  final def = t.defaultValue == null
      ? _defaultFor(t.expected, st)
      : _coerceDefault(t.defaultValue, st);
  final label = '${t.scenario} ${t.key} user=${t.user}';
  final result = evaluateWith<Object?>(t.config, t.key, def, t.user);
  if (!_valueEqual(result.value, t.expected)) {
    failures.add('$label: actual=${result.value} expected=${t.expected}');
  }
}

Map<String, dynamic> _comparisonConfig(String fixture) =>
    _upstreamJson('$fixture.json');

_EvalLogTuple _firstWhere(
        List<_EvalLogTuple> cases, bool Function(_EvalLogTuple) p) =>
    cases.firstWhere(p,
        orElse: () => throw StateError('No matching case in corpus scenario'));

void main() {
  // =======================================================================
  // US1 / US2 — value + comparator matrices
  // =======================================================================
  group('US1/US2 value + comparator matrices', () {
    for (final matrix in <String>[
      'testmatrix.csv',
      'testmatrix_comparators_v6.csv',
      'testmatrix_semantic.csv',
      'testmatrix_semantic_2.csv',
      'testmatrix_number.csv',
      'testmatrix_sensitive.csv',
      'testmatrix_unicode.csv',
    ]) {
      test(matrix, () {
        final tuples = _loadMatrix(matrix);
        expect(tuples, isNotEmpty, reason: '$matrix produced no tuples');
        final failures = <String>[];
        for (final t in tuples) {
          _assertMatrixTuple(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }
  });

  // =======================================================================
  // US1 — targeting-rule eval-log scenarios
  // =======================================================================
  group('US1 targeting-rule scenarios', () {
    for (final scenario in <String>[
      '1_targeting_rule',
      '2_targeting_rules',
      'simple_value'
    ]) {
      test(scenario, () {
        final failures = <String>[];
        for (final t in _loadEvalLogScenario(scenario)) {
          _assertEvalLogValue(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }

    test('matched targeting rule is reported', () {
      final cases = _loadEvalLogScenario('1_targeting_rule');
      final matching = _firstWhere(cases, (c) => c.expected == 'Dog');
      final result = evaluateWith<Object?>(
          matching.config, matching.key, 'default', matching.user);
      expect(result.value, equals('Dog'));
      expect(result.matchedTargetingRule, isNotNull);
      expect(result.matchedPercentageOption, isNull);
      expect(result.variationId, equals('d0cd8f06'));
    });

    test('no user serves fallback with reason and never throws', () {
      final cases = _loadEvalLogScenario('1_targeting_rule');
      final noUser = _firstWhere(cases, (c) => c.user == null);
      final result =
          evaluateWith<Object?>(noUser.config, noUser.key, 'default', null);
      expect(result.value, equals('Cat')); // fallback
      expect(result.error, isNull); // a value was cleanly resolved
      expect(result.evalError, isNotNull);
      expect(result.evalError, contains('User Object is missing'));
      expect(result.matchedTargetingRule, isNull);
    });
  });

  // =======================================================================
  // US3 — percentage rollout
  // =======================================================================
  group('US3 percentage rollout', () {
    for (final scenario in <String>[
      'options_based_on_user_id',
      'options_based_on_custom_attr',
      'options_after_targeting_rule',
      'options_within_targeting_rule',
    ]) {
      test(scenario, () {
        final failures = <String>[];
        for (final t in _loadEvalLogScenario(scenario)) {
          _assertEvalLogValue(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }

    test('percentage bucketing is deterministic (repeat-invariant)', () {
      final cases = _loadEvalLogScenario('options_based_on_user_id');
      final withUser = _firstWhere(cases, (c) => c.user != null);
      final first = evaluateWith<Object?>(
          withUser.config, withUser.key, 'default', withUser.user);
      for (var i = 0; i < 20; i++) {
        final again = evaluateWith<Object?>(
            withUser.config, withUser.key, 'default', withUser.user);
        expect(again.value, equals(first.value),
            reason: 'percentage bucketing must be repeat-invariant');
        expect(again.variationId, equals(first.variationId));
      }
      expect(_valueEqual(first.value, withUser.expected), isTrue);
      expect(first.matchedPercentageOption, isNotNull);
    });
  });

  // =======================================================================
  // US4 — segments / prerequisites / AND-OR
  // =======================================================================
  group('US4 segments / prerequisites / AND-OR matrices', () {
    for (final matrix in <String>[
      'testmatrix_and_or.csv',
      'testmatrix_segments.csv',
      'testmatrix_segments_old.csv',
      'testmatrix_prerequisite_flag.csv',
    ]) {
      test(matrix, () {
        final tuples = _loadMatrix(matrix);
        expect(tuples, isNotEmpty, reason: '$matrix produced no tuples');
        final failures = <String>[];
        for (final t in tuples) {
          _assertMatrixTuple(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }

    for (final scenario in <String>[
      'segment',
      'prerequisite_flag',
      'and_rules'
    ]) {
      test('eval-log $scenario', () {
        final failures = <String>[];
        for (final t in _loadEvalLogScenario(scenario)) {
          if (_unvendoredEvalLogKeys.contains(t.key)) continue;
          _assertEvalLogValue(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }

    test('multilevel prerequisite resolves through reconstructed chain', () {
      // Reconstructed from evaluationlog/prerequisite_flag (its config blob was
      // not vendored, #401). Proves the engine recurses A → B → C correctly.
      final config = <String, dynamic>{
        'p': {'u': '', 'r': 0, 's': 'salt'},
        's': <dynamic>[],
        'f': {
          'mainFeatureWithoutUserCondition': {
            't': 0,
            'v': {'b': true},
            'i': 'main',
            'r': <dynamic>[],
          },
          'intermediateFeature': {
            't': 0,
            'v': {'b': false},
            'i': 'inter',
            'r': [
              {
                'c': [
                  {
                    'p': {
                      'f': 'mainFeatureWithoutUserCondition',
                      'c': 0,
                      'v': {'b': true}
                    }
                  },
                  {
                    'p': {
                      'f': 'mainFeatureWithoutUserCondition',
                      'c': 0,
                      'v': {'b': true}
                    }
                  },
                ],
                's': {
                  'v': {'b': true},
                  'i': 'interT'
                },
              },
            ],
          },
          'dependentFeatureMultipleLevels': {
            't': 1,
            'v': {'s': 'Cat'},
            'i': 'dep',
            'r': [
              {
                'c': [
                  {
                    'p': {
                      'f': 'intermediateFeature',
                      'c': 0,
                      'v': {'b': true}
                    }
                  },
                ],
                's': {
                  'v': {'s': 'Dog'},
                  'i': 'depDog'
                },
              },
            ],
          },
        },
      };
      final result = evaluate<String>(
          config, 'dependentFeatureMultipleLevels', 'default', null);
      expect(result.value, equals('Dog'));
      expect(result.matchedTargetingRule, isNotNull);
    });
  });

  // =======================================================================
  // US4 — circular-dependency termination (SC-004)
  // =======================================================================
  group('US4 circular-dependency termination', () {
    test('circular_dep scenarios bounded fallback', () {
      final failures = <String>[];
      for (final t in _loadEvalLogScenario('circular_dep')) {
        final sw = Stopwatch()..start();
        final result =
            evaluateWith<Object?>(t.config, t.key, 'default', t.user);
        sw.stop();
        if (sw.elapsed.inMilliseconds >= 1000) {
          failures.add('${t.key} took too long (${sw.elapsed}) — not bounded');
        }
        if (result.value != 'default') {
          failures.add(
              '${t.key} value=${result.value} (expected fail-closed default)');
        }
        if (result.error == null) {
          failures.add('${t.key} resolved with no error code');
        }
      }
      expect(failures, isEmpty, reason: failures.join('\n'));
    });

    test('direct two-flag cycle terminates', () {
      final config = <String, dynamic>{
        'p': {'u': '', 'r': 0, 's': 'salt'},
        's': <dynamic>[],
        'f': {
          'flagA': {
            't': 1,
            'v': {'s': 'A'},
            'i': 'a',
            'r': [
              {
                'c': [
                  {
                    'p': {
                      'f': 'flagB',
                      'c': 0,
                      'v': {'b': true}
                    }
                  }
                ],
                's': {
                  'v': {'s': 'AA'},
                  'i': 'aa'
                }
              },
            ],
          },
          'flagB': {
            't': 1,
            'v': {'s': 'B'},
            'i': 'b',
            'r': [
              {
                'c': [
                  {
                    'p': {
                      'f': 'flagA',
                      'c': 0,
                      'v': {'b': true}
                    }
                  }
                ],
                's': {
                  'v': {'s': 'BB'},
                  'i': 'bb'
                }
              },
            ],
          },
        },
      };
      final sw = Stopwatch()..start();
      final result = evaluate<String>(config, 'flagA', 'default', null);
      sw.stop();
      expect(sw.elapsed.inMilliseconds, lessThan(1000));
      expect(result.value, equals('default'));
      expect(result.error, isNotNull);
    });
  });

  // =======================================================================
  // US5 — normalization / conversion / trimming
  // =======================================================================
  group('US5 normalization / conversion / trimming', () {
    test('comparison_attribute_conversion', () {
      final config = _comparisonConfig('comparison_attribute_conversion');
      final driver = <(String, Object?, String)>[
        ('numberToStringConversion', 0.12345, '1'),
        ('numberToStringConversionInt', 125, '4'),
        ('numberToStringConversionPositiveExp', -1.23456789e96, '2'),
        ('numberToStringConversionNegativeExp', -1.23456789e-96, '4'),
        ('numberToStringConversionNaN', double.nan, '3'),
        ('numberToStringConversionPositiveInf', double.infinity, '4'),
        ('numberToStringConversionNegativeInf', double.negativeInfinity, '3'),
        ('dateToStringConversion', 1680307199.999, '3'),
        ('dateToStringConversionNaN', double.nan, '3'),
        ('dateToStringConversionPositiveInf', double.infinity, '1'),
        ('dateToStringConversionNegativeInf', double.negativeInfinity, '5'),
        (
          'stringArrayToStringConversion',
          <String>['read', 'Write', ' eXecute '],
          '4'
        ),
        ('stringArrayToStringConversionEmpty', <String>[], '5'),
        (
          'stringArrayToStringConversionSpecialChars',
          <String>['+<>%"\'\\/\t\r\n'],
          '3'
        ),
        (
          'stringArrayToStringConversionUnicode',
          <String>['äöüÄÖÜçéèñışğâ¢™✓😀'],
          '2'
        ),
      ];
      final failures = <String>[];
      for (final (key, custom1, expected) in driver) {
        final user = _CorpusUser('12345', null, null, {'Custom1': custom1});
        final result = evaluateWith<Object?>(config, key, 'default', user);
        if (result.value != expected) {
          failures.add('$key: actual=${result.value} expected=$expected');
        }
      }
      expect(failures, isEmpty, reason: failures.join('\n'));
    });

    test('native-typed numeric custom attribute matches string form', () {
      final config = <String, dynamic>{
        'p': {'u': '', 'r': 0, 's': 'salt'},
        's': <dynamic>[],
        'f': {
          'numericGate': {
            't': 1,
            'a': 'Custom1',
            'v': {'s': 'no-match'},
            'i': 'ng',
            'r': [
              {
                'c': [
                  {
                    'u': {'a': 'Custom1', 'c': 15, 'd': 18.0}
                  }
                ],
                's': {
                  'v': {'s': 'match'},
                  'i': 'm'
                },
              },
            ],
          },
        },
      };
      final cases = <String, (Object, String)>{
        'native-int-pass': (21, 'match'),
        'native-float-pass': (18.0, 'match'),
        'native-int-fail': (17, 'no-match'),
        'native-float-fail': (17.999, 'no-match'),
        'string-int-pass': ('21', 'match'),
        'string-float-pass': ('18.0', 'match'),
        'string-int-fail': ('17', 'no-match'),
      };
      final failures = <String>[];
      cases.forEach((label, tuple) {
        final (attr, expected) = tuple;
        final user = _CorpusUser('12345', null, null, {'Custom1': attr});
        final result =
            evaluateWith<Object?>(config, 'numericGate', 'default', user);
        if (result.value != expected) {
          failures.add('$label: actual=${result.value} expected=$expected');
        }
      });
      expect(failures, isEmpty, reason: failures.join('\n'));
    });

    test('comparison_attribute_trimming', () {
      final config = _comparisonConfig('comparison_attribute_trimming');
      final user = _CorpusUser(' 12345 ', null, '[" USA "]', {
        'Version': ' 1.0.0 ',
        'Number': ' 3 ',
        'Date': ' 1705253400 ',
      });
      final failures = <String>[];
      for (final (key, expected) in _trimmingDriver()) {
        final result = evaluateWith<Object?>(config, key, 'default', user);
        if (result.value != expected) {
          failures.add('$key: actual=${result.value} expected=$expected');
        }
      }
      expect(failures, isEmpty, reason: failures.join('\n'));
    });

    test('comparison_value_trimming', () {
      final config = _comparisonConfig('comparison_value_trimming');
      final user = _CorpusUser('12345', null, '["USA"]', {
        'Version': '1.0.0',
        'Number': '3',
        'Date': '1705253400',
      });
      final failures = <String>[];
      for (final (key, expected) in _valueTrimmingDriver()) {
        final result = evaluateWith<Object?>(config, key, 'default', user);
        if (result.value != expected) {
          failures.add('$key: actual=${result.value} expected=$expected');
        }
      }
      expect(failures, isEmpty, reason: failures.join('\n'));
    });
  });

  // =======================================================================
  // US5 — typed-attribute validation outcomes (FR-010) + list truncation
  // =======================================================================
  group('US5 validation scenarios', () {
    for (final scenario in <String>[
      'semver_validation',
      'number_validation',
      'epoch_date_validation',
      'list_truncation',
    ]) {
      test(scenario, () {
        final failures = <String>[];
        for (final t in _loadEvalLogScenario(scenario)) {
          _assertEvalLogValue(t, failures);
        }
        expect(failures, isEmpty,
            reason: '${failures.length} drift:\n${failures.join('\n')}');
      });
    }
  });

  // =======================================================================
  // US5 — variationId + matched rule/option detail (FR-011)
  // =======================================================================
  group('US5 variationId + matched detail', () {
    test('testmatrix_variationId.csv', () {
      final tuples = _loadMatrix('testmatrix_variationId.csv');
      expect(tuples, isNotEmpty);
      final failures = <String>[];
      for (final t in tuples) {
        _assertMatrixTuple(t, failures);
      }
      expect(failures, isEmpty,
          reason: '${failures.length} drift:\n${failures.join('\n')}');
    });

    test('segment-matched flag reports value and variationId', () {
      final cases = _loadEvalLogScenario('segment');
      final match = _firstWhere(cases,
          (c) => c.key == 'featureWithSegmentTargeting' && c.user != null);
      final result =
          evaluateWith<Object?>(match.config, match.key, false, match.user);
      expect(result.value, isTrue);
      expect(result.matchedTargetingRule, isNotNull);
      expect(result.variationId, isNotNull);
    });
  });

  // Evaluation-log TRACE fidelity (ADR 0003 / epic #494, #501 Dart slice).
  // Replays parity-evaluationlog.json (the cross-language byte-oracle; each
  // tuple carries a Confeature-canonical expectedTrace) through evaluateTraced
  // and asserts the emitted trace is byte-identical. Mirrors the Go / Python /
  // Rust / .NET / Ruby / PHP ports.
  group('eval-log trace fidelity (ADR 0003 / #501)', () {
    test('emits the byte-identical trace for every trace-bearing scenario', () {
      final path = '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/'
          'fixtures/parity-evaluationlog.json';
      final tuples = jsonDecode(File(path).readAsStringSync()) as List<dynamic>;
      expect(tuples, isNotEmpty,
          reason: 'parity-evaluationlog.json produced no tuples');

      final seen = <String, int>{};
      final failures = <String>[];

      for (final raw in tuples) {
        final t = raw as Map<String, dynamic>;
        final expected = t['expectedTrace'];
        final scenario = t['scenario'];
        if (expected is! String ||
            scenario is! String ||
            !_traceScenarios.contains(scenario)) {
          continue;
        }

        final key = t['key'] as String;
        final config = t['config'] as Map<String, dynamic>;
        final st = _settingType(config, key);
        final def = _coerceDefault(t['defaultValue'], st);
        final user = _traceUser(
            t['user'] is Map ? t['user'] as Map<String, dynamic> : null);

        final sink = _CaptureSink();
        evaluateTraced<Object?>(config, key, def, user, sink);
        final actual = sink.lines.join('\n');

        seen[scenario] = (seen[scenario] ?? 0) + 1;
        if (actual != expected) {
          failures.add('trace mismatch for $scenario/$key\n'
              '--- want ---\n$expected\n--- got ---\n$actual');
        }
      }

      expect(failures, isEmpty, reason: failures.join('\n\n'));
      // Every trace-bearing scenario must have asserted >=1 tuple.
      for (final scenario in _traceScenarios) {
        expect((seen[scenario] ?? 0) > 0, isTrue,
            reason: "trace scenario '$scenario' carried no asserted tuples");
      }
    });
  });
}

/// The 14 scenarios that carry an `expectedTrace`.
const List<String> _traceScenarios = [
  'simple_value',
  '1_targeting_rule',
  '2_targeting_rules',
  'and_rules',
  'options_based_on_user_id',
  'options_based_on_custom_attr',
  'options_after_targeting_rule',
  'options_within_targeting_rule',
  'list_truncation',
  'number_validation',
  'circular_dep',
  'prerequisite_flag',
  'semver_validation',
  'epoch_date_validation',
];

/// Build a [_CorpusUser] from the corpus tuple's LOWERCASE user object
/// (`{identifier, email?, country?, custom?}`) — the shape the Go/Python/Rust
/// trace tests consume. Custom values keep their native type.
_CorpusUser? _traceUser(Map<String, dynamic>? raw) {
  if (raw == null || raw.isEmpty) return null;
  var identifier = '';
  String? email;
  String? country;
  final custom = <String, Object?>{};
  raw.forEach((k, v) {
    switch (k) {
      case 'identifier':
        identifier = v?.toString() ?? '';
        break;
      case 'email':
        email = v?.toString();
        break;
      case 'country':
        country = v?.toString();
        break;
      case 'custom':
        if (v is Map<String, dynamic>) {
          v.forEach((ck, cv) => custom[ck] = cv);
        }
        break;
    }
  });
  return _CorpusUser(
      identifier, email, country, custom.isEmpty ? null : custom);
}

/// INFO-level eval-log capture sink reconstructing the parity byte-string.
class _CaptureSink implements TraceSink {
  final List<String> lines = [];

  @override
  int level() => TraceLevel.info;

  @override
  void log(int level, String eventId, String message) =>
      lines.add('${_traceLabel(level)}: [$eventId] $message');
}

String _traceLabel(int level) {
  switch (level) {
    case TraceLevel.error:
      return 'ERROR';
    case TraceLevel.warn:
      return 'WARN';
    case TraceLevel.info:
      return 'INFO';
    case TraceLevel.debug:
      return 'DEBUG';
    default:
      return '?';
  }
}

// ---------------------------------------------------------------------------
// Trimming driver tables (ported verbatim from upstream-corpus.ts / PHP).
// ---------------------------------------------------------------------------

List<(String, String)> _trimmingDriver() {
  const noTrim = <String>[
    'isoneof',
    'isnotoneof',
    'isoneofhashed',
    'isnotoneofhashed',
    'equalshashed',
    'notequalshashed',
    'arraycontainsanyofhashed',
    'arraynotcontainsanyofhashed',
    'equals',
    'notequals',
    'startwithanyof',
    'notstartwithanyof',
    'endswithanyof',
    'notendswithanyof',
    'arraycontainsanyof',
    'arraynotcontainsanyof',
    'startwithanyofhashed',
    'notstartwithanyofhashed',
    'endswithanyofhashed',
    'notendswithanyofhashed',
  ];
  final out = <(String, String)>[for (final k in noTrim) (k, 'no trim')];
  const trimmed = <String, String>{
    'semverisoneof': '4 trim',
    'semverisnotoneof': '5 trim',
    'semverless': '6 trim',
    'semverlessequals': '7 trim',
    'semvergreater': '8 trim',
    'semvergreaterequals': '9 trim',
    'numberequals': '10 trim',
    'numbernotequals': '11 trim',
    'numberless': '12 trim',
    'numberlessequals': '13 trim',
    'numbergreater': '14 trim',
    'numbergreaterequals': '15 trim',
    'datebefore': '18 trim',
    'dateafter': '19 trim',
  };
  trimmed.forEach((k, v) => out.add((k, v)));
  out.add(('containsanyof', 'no trim'));
  out.add(('notcontainsanyof', 'no trim'));
  return out;
}

List<(String, String)> _valueTrimmingDriver() {
  const noTrim = <String>[
    'isoneof',
    'isnotoneof',
    'containsanyof',
    'notcontainsanyof',
    'isoneofhashed',
    'isnotoneofhashed',
    'equalshashed',
    'notequalshashed',
    'arraycontainsanyofhashed',
    'arraynotcontainsanyofhashed',
    'equals',
    'notequals',
    'startwithanyof',
    'notstartwithanyof',
    'endswithanyof',
    'notendswithanyof',
    'arraycontainsanyof',
    'arraynotcontainsanyof',
    'startwithanyofhashed',
    'notstartwithanyofhashed',
    'endswithanyofhashed',
    'notendswithanyofhashed',
  ];
  final out = <(String, String)>[for (final k in noTrim) (k, 'no trim')];
  const trimmed = <String, String>{
    'semverisoneof': '4 trim',
    'semverisnotoneof': '5 trim',
    'semverless': '6 trim',
    'semverlessequals': '7 trim',
    'semvergreater': '8 trim',
    'semvergreaterequals': '9 trim',
  };
  trimmed.forEach((k, v) => out.add((k, v)));
  return out;
}
