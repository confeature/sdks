// SPDX-License-Identifier: MIT

/// Unit tests for the evaluation hashes (spec 123 T002). Vectors cross-checked
/// against the spec-117 TS reference (`packages/sdk-shared/src/hash.ts`).
library;

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/hashing.dart';

void main() {
  group('sha1Hex / sha256Hex known vectors', () {
    test('empty string', () {
      expect(sha1Hex(''), equals('da39a3ee5e6b4b0d3255bfef95601890afd80709'));
      expect(
        sha256Hex(''),
        equals(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      );
    });

    test('"abc"', () {
      expect(
          sha1Hex('abc'), equals('a9993e364706816aba3e25717850c26c9cd0d89d'));
      expect(
        sha256Hex('abc'),
        equals(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
      );
    });
  });

  group('percentageBucket (SHA-1 unsalted, hex[0,7] % 100)', () {
    test('is in [0, 99]', () {
      for (final id in <String>['12345', 'a@b.com', '', 'Bob']) {
        final b = percentageBucket('someKey', id);
        expect(b, inInclusiveRange(0, 99));
      }
    });

    test('is deterministic', () {
      expect(percentageBucket('k', 'v'), equals(percentageBucket('k', 'v')));
    });

    test('matches the explicit hex computation', () {
      const key = 'percentageKey';
      const attr = '12345';
      final hex = sha1Hex(key + attr).substring(0, 7);
      expect(
          percentageBucket(key, attr), equals(int.parse(hex, radix: 16) % 100));
    });
  });

  group('hashComparisonValue (SHA-256 salted)', () {
    test('equals sha256(value + configSalt + contextSalt)', () {
      expect(
        hashComparisonValue('v', 'cfg', 'ctx'),
        equals(sha256Hex('vcfgctx')),
      );
    });
  });

  group('hashComparisonValueSlice (byte-level)', () {
    test('hashes slice bytes + salt bytes', () {
      final slice = 'ab'.codeUnits;
      expect(
        hashComparisonValueSlice(slice, 'S', 'C'),
        equals(sha256Hex('abSC')),
      );
    });
  });
}
