// SPDX-License-Identifier: MIT

/// Targeting-rule parity (spec 135 / #434, epic #382, US3) — the
/// `CORPUS_RULES` corpus injected through the full-config offline
/// override.
///
/// Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which
/// feed a value-only `overridesMap` via [MapOverrideDataSource]), the rule
/// corpus carries the whole `{p, f, s}` config and is injected via
/// [createFlagOverridesFromConfig] + [OverrideBehaviour.localOnly]. The SDK
/// then resolves targeting rules / segments / % options offline through the
/// real Dart evaluator, exactly as it would against a CDN-served config — no
/// network round-trip.
///
/// Runner contract (mirrors `apps/sdk-node/tests/parity/parity-rules.test.ts`,
/// `apps/sdk-python/tests/parity/test_parity_rules.py`, and
/// `apps/sdk-dotnet/.../ParityRulesTests.cs`): every tuple branches on the
/// config's `injectionMode`:
///   - `"full-config"` → capability-probe [createFlagOverridesFromConfig].
///     If sdk-dart exposes it, build the override and assert the PUBLIC
///     `client.getValue` returns `tuple.expected`. If it does NOT, SKIP with
///     a reason — NEVER fall back to the flat-map path (SC-004: no
///     `"full-config"` tuple is ever resolved on the map path, and a skip is
///     reported with its reason).
///
/// sdk-dart HAS adopted the full-config path, so every loaded rule tuple
/// runs and passes; there are no skips for this family.
///
/// AC4: if a tuple fails because of a REAL Dart evaluator targeting-rule gap
/// (not override wiring), STOP and file a discrete #382 follow-up — never a
/// corpus or test workaround.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';

import 'workspace_root.dart';

const String _parityTestSDKKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/// Capability probe: does this SDK expose the in-memory full-config
/// override factory? The full-config path is gated on this — never silently
/// resolved on the flat-map path (SC-004 / AC4).
///
/// Unlike the reflection-based sibling runners (Python / .NET, which probe a
/// dynamic symbol at runtime), Dart resolves [createFlagOverridesFromConfig]
/// at COMPILE time: this file only compiles if the factory is part of the
/// public `package:confeature/confeature.dart` surface. So the probe is
/// statically `true` here — but the SC-004 skip branch below is kept intact
/// so the runner contract mirrors the sibling runners byte-for-byte; were
/// the export ever dropped, this file would fail to compile (an even louder
/// signal than a runtime skip).
const bool _hasFullConfigOverrides = true;

User? _makeParityUser(Object? raw) {
  if (raw == null) return null;
  if (raw is! Map) return null;
  final m = Map<String, dynamic>.from(raw);
  final identifier = m['identifier'];
  Map<String, Object>? custom;
  final customRaw = m['custom'];
  if (customRaw is Map) {
    custom = <String, Object>{};
    for (final entry in customRaw.entries) {
      final decoded = _decodeCustomValue(entry.value);
      if (decoded != null) custom[entry.key.toString()] = decoded;
    }
  }
  return User(
    identifier: identifier is String ? identifier : '',
    email: m['email'] is String ? m['email'] as String : null,
    country: m['country'] is String ? m['country'] as String : null,
    custom: custom,
  );
}

/// Deserialize one custom-attribute value from the typed-corpus encoding into
/// the native Dart type the public [User] carries (spec 151 / #468 US2):
///   - string → `String`
///   - JSON number → `num` (`int` / `double`, retained as-is)
///   - bool → `bool`
///   - JSON array → `List<String>`
///   - `{"$date": <epoch-seconds>}` → `DateTime` at that epoch (UTC)
///   - `{"$num": "NaN"|"Infinity"|"-Infinity"}` → the non-finite `double`
///     (#479): `JSON.stringify(NaN|Infinity|-Infinity)` collapses to a lossy
///     `null` in the wire corpus, so the canonical TS exporter tags these with
///     `{$num}` (parallel to `{$date}`). We rehydrate them to the native Dart
///     non-finite doubles; the evaluator's `numberToCanonicalString` then prints
///     `"NaN"` / `"Infinity"` / `"-Infinity"` — byte-identical to the corpus
///     comparison text and to `double.{nan,infinity,negativeInfinity}.toString()`.
///   - null → skipped (returns `null`)
///
/// The evaluator then converts each non-string value exactly as ConfigCat does
/// (number → invariant decimal, `DateTime` → second-based epoch, `List` →
/// JSON), so the converted `Custom1` text matches the corpus comparison value.
Object? _decodeCustomValue(Object? raw) {
  if (raw == null) return null;
  if (raw is String) return raw;
  if (raw is bool) return raw;
  if (raw is num) return raw;
  if (raw is List) {
    return raw.map((e) => e.toString()).toList(growable: false);
  }
  if (raw is Map) {
    final dateEpoch = raw[r'$date'];
    if (dateEpoch is num) {
      // Epoch SECONDS (fractional). Reconstitute the millisecond instant the
      // corpus encoded; the evaluator re-derives `ms / 1000` on the way out.
      final ms = (dateEpoch * 1000).round();
      return DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
    }
    final numTag = raw[r'$num'];
    if (numTag is String) {
      // Non-finite number tag (#479): the only legal values are the three
      // IEEE-754 specials JSON cannot carry natively.
      switch (numTag) {
        case 'NaN':
          return double.nan;
        case 'Infinity':
          return double.infinity;
        case '-Infinity':
          return double.negativeInfinity;
      }
    }
  }
  return null;
}

void main() {
  group('parity rules corpus (spec 135 / #434 US3 — targeting-rule parity)',
      () {
    final tuplesRaw = File(parityCorpusRulesPath()).readAsStringSync();
    final configsRaw = File(parityConfigsRulesPath()).readAsStringSync();
    final tuples = (jsonDecode(tuplesRaw) as List).cast<Map<String, dynamic>>();
    final configList =
        (jsonDecode(configsRaw) as List).cast<Map<String, dynamic>>();
    final configsById = <String, Map<String, dynamic>>{
      for (final cfg in configList) cfg['id'] as String: cfg,
    };

    test(
        'rule corpus is non-empty (append-only floor: at least the 8 '
        'foundational rule tuples)', () {
      // Growth-tolerant non-empty floor. `CORPUS_RULES` is append-only (the 8
      // foundational #383 tuples are never removed) and grows with every
      // comparator spec, so we assert only that the fixture actually loaded —
      // not a hardcoded total that re-trips on every growth. Per-tuple
      // correctness is covered by the per-tuple assertions below, and JSON↔TS
      // sync is owned by the central `check:exports` gate, so this guard is
      // purely a non-empty smoke and never needs a per-spec bump. If it fails,
      // the fixture looks empty/truncated — regenerate via
      // `pnpm run export:corpus` in packages/test-fixtures-sdk-parity/.
      expect(tuples.length, greaterThanOrEqualTo(8));
    });

    test('full-config override factory is exposed (no skips)', () {
      expect(
        _hasFullConfigOverrides,
        isTrue,
        reason: 'createFlagOverridesFromConfig must be exposed; sdk-dart has '
            'adopted the in-memory full-config override path (#434).',
      );
    });

    for (final tuple in tuples) {
      final description = tuple['description'] as String;
      test(description, () async {
        final configId = tuple['configId'] as String;
        final cfg = configsById[configId];
        expect(
          cfg,
          isNotNull,
          reason: 'rule corpus references unknown configId=$configId; '
              "regenerate fixtures via 'pnpm run export:corpus'.",
        );

        final injectionMode = cfg!['injectionMode'] as String;
        // The rule corpus is full-config only; a flat-map tuple here would
        // mean a corpus regression, never a silent flat-map fallback
        // (SC-004).
        expect(
          injectionMode,
          equals('full-config'),
          reason: 'rule corpus tuple "$description" has unexpected '
              'injectionMode=$injectionMode; expected "full-config".',
        );

        // SC-004: NEVER fall back to the flat-map path — skip with a reason
        // rather than false-greening on the map path. Statically `true` in
        // Dart (see [_hasFullConfigOverrides]); the branch is retained for
        // runner-contract parity with the sibling SDKs.
        // ignore: dead_code
        if (!_hasFullConfigOverrides) {
          markTestSkipped('SDK has not adopted full-config overrides');
          return;
        }

        final config = Map<String, dynamic>.from(cfg['config'] as Map);
        final key = tuple['key'] as String;
        final expected = tuple['expected'];
        // The corpus encodes ONE default per tuple, but JSON cannot tell an
        // int default (`-1`) apart from a double default (`-1.0`). The
        // evaluator's TYPE_MISMATCH guard is int-vs-double STRICT (Principle
        // II — never relaxed), so a DOUBLE setting (`t == 3`) needs a `double`
        // default and an INT setting (`t == 2`) needs an `int` default, else
        // the guard trips and the SDK returns the default instead of the
        // rule-resolved value. Coerce the corpus default to match the
        // setting's declared type `t` (spec 152 / #475 US2).
        final defaultValue = _typedDefault(tuple['defaultValue'], config, key);
        // `expectedVariationId` is optional (camelCase JSON key): only 14 of
        // the 234 rule tuples carry it. When present we additionally assert
        // the PUBLIC getValueDetails envelope's variationId.
        final expectedVariationId = tuple['expectedVariationId'] as String?;

        final client = ConfeatureClient.get(
          _parityTestSDKKey,
          pollingMode: const ManualPoll(),
          flagOverrides: createFlagOverridesFromConfig(
            config,
            OverrideBehaviour.localOnly,
          ),
          // No cache I/O during parity tests — in-memory only.
          cache: _InMemoryOnlyCache(),
        );
        final parityUser = _makeParityUser(tuple['user']);
        try {
          // Assert through the PUBLIC sync getValue (the rule path is
          // resolved synchronously offline from the full config).
          final actual = client.getValueSync<Object?>(
            key,
            defaultValue,
            parityUser,
          );
          _expectValueParity(actual, expected, description);

          if (expectedVariationId != null) {
            // variationId is asserted against the PUBLIC async
            // getValueDetails — the configcat_client drop-in details API.
            // `EvaluationDetails.variationId` MUST equal the corpus value;
            // this is the #395 override→variationId propagation gate.
            final details = await client.getValueDetails<Object?>(
              key: key,
              defaultValue: defaultValue,
              user: parityUser,
            );
            // The value carried by the details envelope must agree with the
            // sync read (and with the corpus expectation).
            _expectValueParity(details.value, expected, description);
            expect(
              details.variationId,
              equals(expectedVariationId),
              reason: 'variationId parity drift on "$description"\n'
                  '  expected variationId: $expectedVariationId\n'
                  '  actual   variationId: ${details.variationId}\n'
                  'spec 152 / #475 US2 Principle II NON-NEGOTIABLE — assert '
                  'against the PUBLIC getValueDetails. If the override path '
                  'drops the variationId (the #395 gap class), fix the '
                  'override→getValueDetails propagation, NOT the corpus.',
            );
          }
        } finally {
          client.close();
        }
      });
    }
  });
}

/// Coerce the corpus `defaultValue` to the Dart primitive that matches the
/// setting's declared type `t`, so the evaluator's int-vs-double-strict
/// TYPE_MISMATCH guard is satisfied without relaxing the evaluator
/// (Principle II). Only numeric coercion is needed: `t == 3` (double) → a
/// `double` default; `t == 2` (int) → an `int` default. All other types
/// pass through unchanged.
Object? _typedDefault(
  Object? raw,
  Map<String, dynamic> config,
  String key,
) {
  if (raw is! num) return raw;
  final settings = config['f'];
  if (settings is! Map) return raw;
  final setting = settings[key];
  if (setting is! Map) return raw;
  final t = setting['t'];
  if (t == 3) return raw.toDouble(); // double setting
  if (t == 2) return raw.toInt(); // int setting
  return raw;
}

/// Assert value parity. Numbers compare NUMERICALLY (so an `int`-typed
/// corpus expectation and a `double` SDK result for the same magnitude
/// agree), every other type compares with `equals`.
void _expectValueParity(Object? actual, Object? expected, String description) {
  if (actual is num && expected is num) {
    expect(
      actual,
      equals(expected),
      reason: 'Targeting-rule numeric parity drift on "$description"\n'
          '  expected: $expected (${expected.runtimeType})\n'
          '  actual:   $actual (${actual.runtimeType})',
    );
    return;
  }
  expect(
    actual,
    equals(expected),
    reason: 'Targeting-rule parity drift on "$description"\n'
        '  expected: $expected (${expected.runtimeType})\n'
        '  actual:   $actual (${actual.runtimeType})\n'
        'spec 135 / #434 Principle II NON-NEGOTIABLE — investigate '
        'the evaluator / override router, do NOT mutate the corpus. '
        'If this is a real Dart targeting-rule engine gap (not an '
        'override-wiring bug), STOP and file a discrete #382 '
        'follow-up — never a corpus or test workaround (AC4).',
  );
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
