// SPDX-License-Identifier: MIT

/// Unit tests for the ConfigCat-semantics semver (spec 123 T003), cross-checked
/// against the spec-117 TS reference (`packages/sdk-shared/src/semver.ts`).
library;

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/semver.dart';

void main() {
  group('parse', () {
    test('valid full versions', () {
      expect(SemVer.parse('1.2.3'), isNotNull);
      expect(SemVer.parse('v1.2.3'), isNotNull);
      expect(SemVer.parse('1.0.0-alpha.1'), isNotNull);
      expect(SemVer.parse('1.0.0+build.5'), isNotNull);
      expect(SemVer.parse('  1.2.3  '), isNotNull); // parse on trim
    });

    test('rejects malformed versions → null', () {
      expect(SemVer.parse('1.2'), isNull);
      expect(SemVer.parse('1.2.3.4'), isNull);
      expect(SemVer.parse('01.2.3'), isNull); // leading zero
      expect(SemVer.parse('abc'), isNull);
      expect(SemVer.parse(''), isNull);
    });

    test('canonical drops build metadata', () {
      expect(SemVer.parse('1.2.3+meta')!.version, equals('1.2.3'));
      expect(SemVer.parse('1.2.3-rc.1+meta')!.version, equals('1.2.3-rc.1'));
    });
  });

  group('compare (ConfigCat precedence)', () {
    int cmp(String a, String b) => SemVer.parse(a)!.compare(SemVer.parse(b)!);

    test('numeric major.minor.patch ordering', () {
      expect(cmp('1.0.0', '2.0.0'), lessThan(0));
      expect(cmp('1.2.0', '1.1.0'), greaterThan(0));
      expect(cmp('1.0.1', '1.0.1'), equals(0));
    });

    test('a release ranks higher than a pre-release', () {
      expect(cmp('1.0.0', '1.0.0-alpha'), greaterThan(0));
      expect(cmp('1.0.0-alpha', '1.0.0'), lessThan(0));
    });

    test('pre-release identifier precedence', () {
      // numeric < alphanumeric
      expect(cmp('1.0.0-1', '1.0.0-alpha'), lessThan(0));
      // numeric compared numerically
      expect(cmp('1.0.0-2', '1.0.0-10'), lessThan(0));
      // more fields rank higher when prefixes equal
      expect(cmp('1.0.0-alpha', '1.0.0-alpha.1'), lessThan(0));
      // alphanumeric ASCII-lexical
      expect(cmp('1.0.0-alpha', '1.0.0-beta'), lessThan(0));
    });

    test('build metadata is ignored for precedence', () {
      expect(cmp('1.0.0+a', '1.0.0+b'), equals(0));
    });
  });
}
