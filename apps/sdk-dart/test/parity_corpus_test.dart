// SPDX-License-Identifier: MIT

/// Spec 049 US1 parity gate — 58/58 byte-identical to ConfigCat.
///
/// Loads the TS-generated parity corpus + canonical configs from
/// `packages/test-fixtures-sdk-parity/fixtures/`, runs one subtest per
/// tuple via `test(...)` (subtest name = tuple description so a drift
/// surfaces with its description in the test report), and asserts that
/// the Dart `ConfeatureClient` resolves each tuple to its `expected`
/// value.
///
/// Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST
/// pass. If a tuple drifts, STOP and investigate the
/// override-eval / evaluator code — never mutate the corpus.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';

import 'workspace_root.dart';

const String _parityTestSDKKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

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

FlagOverrides _makeOverrides(Map<String, dynamic> overridesMap) {
  // The overrides corpus value is a Map<String, Object>; all entries
  // are primitive booleans in the v1 corpus, but the constructor
  // accepts the full Object surface for forward compatibility.
  return FlagOverrides(
    dataSource: MapOverrideDataSource(
      overridesMap.map((k, v) => MapEntry(k, v as Object)),
    ),
    behaviour: OverrideBehaviour.localOnly,
  );
}

void main() {
  group('parity corpus (spec 049 US1 — 58/58 byte-identical)', () {
    final tuplesRaw = File(parityCorpusPath()).readAsStringSync();
    final configsRaw = File(parityConfigsPath()).readAsStringSync();
    final tuples = (jsonDecode(tuplesRaw) as List).cast<Map<String, dynamic>>();
    final configList =
        (jsonDecode(configsRaw) as List).cast<Map<String, dynamic>>();
    final configsById = <String, Map<String, dynamic>>{
      for (final cfg in configList) cfg['id'] as String: cfg,
    };

    test('corpus has exactly 58 tuples', () {
      // If this fails, regenerate via `pnpm run export:corpus` in
      // packages/test-fixtures-sdk-parity/.
      expect(tuples.length, equals(58));
    });

    for (final tuple in tuples) {
      final description = tuple['description'] as String;
      test(description, () async {
        final configId = tuple['configId'] as String;
        final cfg = configsById[configId];
        expect(cfg, isNotNull,
            reason: 'corpus references unknown configId=$configId');
        final overridesMap =
            Map<String, dynamic>.from(cfg!['overridesMap'] as Map);
        final key = tuple['key'] as String;
        final defaultValue = tuple['defaultValue'];
        final expected = tuple['expected'];

        final client = ConfeatureClient.get(
          _parityTestSDKKey,
          pollingMode: const ManualPoll(),
          flagOverrides: _makeOverrides(overridesMap),
          // No cache I/O during parity tests — in-memory only.
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
            reason: 'Parity drift on "$description"\n'
                '  expected: $expected (${expected.runtimeType})\n'
                '  actual:   $actual (${actual.runtimeType})\n'
                'Constitution Principle II NON-NEGOTIABLE — '
                'investigate the evaluator / override-eval code, do '
                'NOT mutate the corpus.',
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
