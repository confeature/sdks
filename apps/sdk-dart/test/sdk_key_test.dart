// SPDX-License-Identifier: MIT

/// Unit tests for `internal/sdk_key.dart`.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/sdk_key.dart';

import 'workspace_root.dart';

void main() {
  group('isValidConfeatureKeyFormat — shared sdk-key-shapes.json (#802)', () {
    final raw = File(sdkKeyShapesPath()).readAsStringSync();
    final shapes = jsonDecode(raw) as Map<String, dynamic>;
    final valid = (shapes['valid'] as List).cast<Map<String, dynamic>>();
    final invalid = (shapes['invalid'] as List).cast<Map<String, dynamic>>();

    test('the shared list is non-empty on both sides', () {
      expect(valid, isNotEmpty);
      expect(invalid, isNotEmpty);
    });

    for (final c in valid) {
      test('accepts ${c['name']}', () {
        expect(isValidConfeatureKeyFormat(c['key'] as String), isTrue);
      });
    }

    for (final c in invalid) {
      test('rejects ${c['name']}', () {
        expect(isValidConfeatureKeyFormat(c['key'] as String), isFalse);
      });
    }
  });

  group('isValidConfeatureKeyFormat', () {
    test('rejects a malformed key', () {
      expect(isValidConfeatureKeyFormat('not-a-confeature-key'), isFalse);
    });

    test('rejects a trailing newline (anchors are strict)', () {
      const key =
          'configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02';
      expect(isValidConfeatureKeyFormat(key), isTrue);
      expect(isValidConfeatureKeyFormat('$key\n'), isFalse);
    });
  });

  group('redactSdkKey', () {
    test('null + empty fall back to [redacted]', () {
      expect(redactSdkKey(null), equals('[redacted]'));
      expect(redactSdkKey(''), equals('[redacted]'));
    });

    test('short keys (< 16 chars) fall back to [redacted]', () {
      expect(redactSdkKey('abcdefg'), equals('[redacted]'));
    });

    test('long keys keep 10% head + tail', () {
      // 80 chars → 10% = 8 chars head/tail.
      final key = 'X' * 80;
      final redacted = redactSdkKey(key);
      expect(redacted, startsWith('XXXXXXXX'));
      expect(redacted, endsWith('XXXXXXXX'));
      expect(redacted, contains('[redacted]'));
      expect(redacted, isNot(contains('X' * 80)));
    });

    test(
        'a configcat-shaped key (contains `/`) leaks at most 6 secret '
        'chars — fewer than the 8 of the legacy shape', () {
      const secretA = 'FAKEfixtureKeyNotRea01';
      const secretB = 'FAKEfixtureKeyNotRea02';
      const key = 'configcat-sdk-1/$secretA/$secretB';
      final redacted = redactSdkKey(key);
      // 61 chars → floor(6.1) = 6 visible each end; the head is all prefix.
      expect(redacted, equals('config…[redacted]…tRea02'));
      expect(redacted, isNot(contains(secretA)));
      expect(redacted, isNot(contains(secretB)));
      expect(redacted, isNot(contains('/')));
    });

    test('a legacy key keeps its 8-char head + tail', () {
      final key = 'confeature-sdk-1-${'A' * 32}-${'B' * 32}';
      expect(redactSdkKey(key), equals('confeatu…[redacted]…BBBBBBBB'));
    });
  });

  group('deriveCacheKey', () {
    test('emits a 32-char base64url tail with the v1 prefix', () {
      final out = deriveCacheKey('any-key');
      expect(out, startsWith('confeature:cache:v1:'));
      expect(out.substring('confeature:cache:v1:'.length), hasLength(32));
    });

    test('is deterministic', () {
      expect(deriveCacheKey('same'), equals(deriveCacheKey('same')));
    });

    test('changes with input', () {
      expect(deriveCacheKey('a'), isNot(equals(deriveCacheKey('b'))));
    });
  });
}
