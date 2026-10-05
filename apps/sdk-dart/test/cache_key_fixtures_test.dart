// SPDX-License-Identifier: MIT

/// Cross-language cache-key parity gate.
///
/// Reads
/// `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
/// (≥ 5 entries) and asserts that the Dart `deriveCacheKey` output is
/// byte-identical to the TS / Python / Go / .NET / Rust / Ruby / PHP /
/// Java / Swift implementations. If this test drifts, STOP and
/// investigate the algorithm — never mutate the fixture to make the
/// test green.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages — intentionally test-only.
import 'package:confeature/src/internal/sdk_key.dart';

import 'workspace_root.dart';

void main() {
  group('cache-key cross-language fixtures', () {
    final raw = File(cacheKeyFixturesPath()).readAsStringSync();
    final entries = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();

    test('at least 5 fixture entries', () {
      // Constitution Principle II — cross-language parity floor.
      expect(entries.length, greaterThanOrEqualTo(5));
    });

    for (final entry in entries) {
      final sdkKey = entry['sdkKey'] as String;
      final expected = entry['expectedCacheKey'] as String;
      test('deriveCacheKey ${sdkKey.isEmpty ? '<empty>' : sdkKey}', () {
        expect(
          deriveCacheKey(sdkKey),
          equals(expected),
          reason: 'cross-language drift; investigate deriveCacheKey, '
              'do NOT mutate the fixture',
        );
      });
    }
  });
}
