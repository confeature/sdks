// SPDX-License-Identifier: MIT

/// Spec 072 US2 typed-parity gate — 13/13 byte-identical to ConfigCat.
///
/// Sibling of `parity_corpus_test.dart`. Loads the 13-tuple typed
/// corpus + the typed configs from
/// `packages/test-fixtures-sdk-parity/fixtures/`, runs one subtest per
/// tuple via `test(...)` (subtest name = tuple description so a drift
/// surfaces with its description in the test report), and asserts that
/// the widened Dart `ConfeatureClient` resolves each tuple to its
/// `expected` value.
///
/// The corpus encodes default + expected values via JSON; a `double`
/// setting's default written as `0` arrives as `int(0)` post-jsonDecode.
/// The driver normalises default + expected + the override map to the
/// native Dart type implied by each setting's `t` discriminator
/// (`double` for `t=3`, `int` for `t=2`), mirroring sdk-python /
/// sdk-go's typed drivers.
///
/// Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST
/// pass. If a tuple drifts, STOP and investigate the evaluator code —
/// never mutate the corpus.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';

import 'workspace_root.dart';

const String _parityTestSDKKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Setting-type discriminators — mirror evaluator._settingType*.
const int _settingTypeInt = 2;
const int _settingTypeDouble = 3;

User? _makeParityUser(Object? raw) {
  if (raw == null) return null;
  if (raw is! Map) return null;
  final m = Map<String, dynamic>.from(raw);
  final identifier = m['identifier'];
  Map<String, String>? custom;
  final customRaw = m['custom'];
  if (customRaw is Map) {
    custom = <String, String>{};
    for (final entry in customRaw.entries) {
      final v = entry.value;
      if (v is String) custom[entry.key.toString()] = v;
    }
  }
  return User(
    identifier: identifier is String ? identifier : '',
    email: m['email'] is String ? m['email'] as String : null,
    country: m['country'] is String ? m['country'] as String : null,
    custom: custom,
  );
}

Map<String, int> _settingTypesByKey(Map<String, dynamic> configRecord) {
  final out = <String, int>{};
  final config = configRecord['config'];
  if (config is! Map) return out;
  final settings = config['f'];
  if (settings is! Map) return out;
  for (final entry in settings.entries) {
    final setting = entry.value;
    if (setting is Map) {
      final t = setting['t'];
      // Dart's `bool` is disjoint from `int`, so the `int` check is
      // already bool-safe (unlike Python).
      if (t is int) out[entry.key.toString()] = t;
    }
  }
  return out;
}

/// Rehydrate a JSON-decoded primitive against the per-key SettingType.
///
/// JSON has one numeric type; Dart's strict evaluator distinguishes
/// `int` (t=2) and `double` (t=3). The corpus's source-of-truth is each
/// setting's discriminator — cast accordingly. Bools, strings, and
/// other shapes pass through untouched so TYPE_MISMATCH tuples still
/// surface the mismatch through the evaluator.
Object? _normaliseForSettingType(Object? value, int settingType) {
  // `bool` first — disjoint from `int` in Dart, but explicit guard
  // mirrors the Python port verbatim.
  if (value is bool) return value;
  if (settingType == _settingTypeInt) {
    if (value is double) return value.toInt();
    return value;
  }
  if (settingType == _settingTypeDouble) {
    if (value is int) return value.toDouble();
    return value;
  }
  return value;
}

Map<String, Object> _normaliseOverrides(
  Map<String, dynamic> overrides,
  Map<String, int> settingTypes,
) {
  final out = <String, Object>{};
  for (final entry in overrides.entries) {
    final st = settingTypes[entry.key];
    final v = entry.value;
    if (v == null) continue;
    if (st == null) {
      out[entry.key] = v as Object;
    } else {
      final normalised = _normaliseForSettingType(v, st);
      if (normalised != null) out[entry.key] = normalised;
    }
  }
  return out;
}

FlagOverrides _makeOverrides(Map<String, Object> overridesMap) {
  return FlagOverrides(
    dataSource: MapOverrideDataSource(overridesMap),
    behaviour: OverrideBehaviour.localOnly,
  );
}

void main() {
  group('parity corpus typed (spec 072 US2 — 13/13 byte-identical)', () {
    final tuplesRaw = File(parityCorpusTypedPath()).readAsStringSync();
    final configsRaw = File(parityConfigsTypedPath()).readAsStringSync();
    final tuples = (jsonDecode(tuplesRaw) as List).cast<Map<String, dynamic>>();
    final configList =
        (jsonDecode(configsRaw) as List).cast<Map<String, dynamic>>();
    final configsById = <String, Map<String, dynamic>>{
      for (final cfg in configList) cfg['id'] as String: cfg,
    };

    test('corpus has exactly 13 tuples', () {
      // If this fails, regenerate via `pnpm run export:corpus` in
      // packages/test-fixtures-sdk-parity/.
      expect(tuples.length, equals(13));
    });

    for (final tuple in tuples) {
      final description = tuple['description'] as String;
      test(description, () {
        final configId = tuple['configId'] as String;
        final cfg = configsById[configId];
        expect(cfg, isNotNull,
            reason: 'typed corpus references unknown configId=$configId');
        final settingTypes = _settingTypesByKey(cfg!);
        final overridesRaw =
            Map<String, dynamic>.from(cfg['overridesMap'] as Map);
        final overridesMap = _normaliseOverrides(overridesRaw, settingTypes);

        final key = tuple['key'] as String;
        final settingType = settingTypes[key];

        var defaultValue = tuple['defaultValue'] as Object?;
        var expected = tuple['expected'] as Object?;
        if (settingType != null) {
          defaultValue = _normaliseForSettingType(defaultValue, settingType);
          expected = _normaliseForSettingType(expected, settingType);
        }

        final client = ConfeatureClient.get(
          _parityTestSDKKey,
          pollingMode: const ManualPoll(),
          flagOverrides: _makeOverrides(overridesMap),
          cache: _InMemoryOnlyCache(),
        );
        try {
          final actual = client.getValueSync<Object?>(
            key,
            defaultValue,
            _makeParityUser(tuple['user']),
          );
          expect(
            actual,
            equals(expected),
            reason: 'Typed parity drift on "$description"\n'
                '  expected: $expected (${expected.runtimeType})\n'
                '  actual:   $actual (${actual.runtimeType})\n'
                'Constitution Principle II NON-NEGOTIABLE — '
                'investigate the evaluator / override-eval code, do '
                'NOT mutate the corpus.',
          );
          // Type-strict guard — `5 == 5.0` is true via Dart's `==` on
          // num. Enforce exact runtime type so an int↔double flip
          // surfaces explicitly.
          expect(
            actual.runtimeType,
            equals(expected.runtimeType),
            reason: 'Typed parity TYPE drift on "$description": '
                'expected type=${expected.runtimeType} '
                'actual type=${actual.runtimeType}.',
          );
        } finally {
          client.close();
        }
      });
    }
  });
}

class _InMemoryOnlyCache extends ConfigCache {
  CacheEntry? _entry;
  @override
  CacheEntry? read() => _entry;
  @override
  void write(CacheEntry entry) {
    _entry = entry;
  }
}
