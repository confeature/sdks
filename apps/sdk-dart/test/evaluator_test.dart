// SPDX-License-Identifier: MIT

/// Unit tests for the four-type flag evaluator.
library;

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/evaluator.dart';

void main() {
  group('evaluate — common failure modes', () {
    test('null config → NO_CONFIG', () {
      final r = evaluate<bool>(null, 'k', false);
      expect(r.value, equals(false));
      expect(r.error, equals('NO_CONFIG'));
    });

    test('missing f key → MALFORMED_CONFIG', () {
      final r = evaluate<bool>({}, 'k', false);
      expect(r.error, equals('MALFORMED_CONFIG'));
    });

    test('key absent → KEY_NOT_FOUND', () {
      final r = evaluate<bool>({
        'f': <String, dynamic>{},
      }, 'k', false);
      expect(r.error, equals('KEY_NOT_FOUND'));
      expect(r.value, equals(false));
    });

    // Spec 072 (#259) reshape: UNSUPPORTED_TYPE now applies only to a
    // GENUINELY unknown `t` discriminator. The pre-existing
    // "non-boolean setting → UNSUPPORTED_TYPE" check is replaced — t=1/2/3
    // settings now resolve via the widened evaluator below.
    test('genuinely unknown setting type (t=99) → UNSUPPORTED_TYPE', () {
      final r = evaluate<bool>({
        'f': {
          'k': {
            't': 99,
            'v': {'b': true},
          },
        },
      }, 'k', false);
      expect(r.error, equals('UNSUPPORTED_TYPE'));
      expect(r.value, equals(false));
    });
  });

  group('evaluate — t=0 boolean', () {
    test('happy path returns cached bool + variationId', () {
      final r = evaluate<bool>({
        'f': {
          'k': {
            't': 0,
            'v': {'b': true},
            'i': 'v-k',
          },
        },
      }, 'k', false);
      expect(r.error, isNull);
      expect(r.value, equals(true));
      expect(r.variationId, equals('v-k'));
    });

    test('non-boolean default → TYPE_MISMATCH', () {
      final r = evaluate<String>({
        'f': {
          'k': {
            't': 0,
            'v': {'b': true},
          },
        },
      }, 'k', 'fallback');
      expect(r.error, equals('TYPE_MISMATCH'));
      expect(r.value, equals('fallback'));
    });
  });

  group('evaluate — t=1 string', () {
    test('happy path returns cached string', () {
      final r = evaluate<String>({
        'f': {
          'k': {
            't': 1,
            'v': {'s': 'hello'},
          },
        },
      }, 'k', 'fallback');
      expect(r.error, isNull);
      expect(r.value, equals('hello'));
    });

    test('int default against t:1 → TYPE_MISMATCH', () {
      final r = evaluate<int>({
        'f': {
          'k': {
            't': 1,
            'v': {'s': 'hello'},
          },
        },
      }, 'k', -1);
      expect(r.error, equals('TYPE_MISMATCH'));
      expect(r.value, equals(-1));
    });

    test('missing v.s → MALFORMED_VALUE', () {
      final r = evaluate<String>({
        'f': {
          'k': {
            't': 1,
            'v': {'b': true},
          },
        },
      }, 'k', 'fallback');
      expect(r.error, equals('MALFORMED_VALUE'));
      expect(r.value, equals('fallback'));
    });
  });

  group('evaluate — t=2 int', () {
    test('happy path returns cached int', () {
      final r = evaluate<int>({
        'f': {
          'k': {
            't': 2,
            'v': {'i': 5},
          },
        },
      }, 'k', -1);
      expect(r.error, isNull);
      expect(r.value, equals(5));
      expect(r.value, isA<int>());
    });

    test('string default against t:2 → TYPE_MISMATCH', () {
      final r = evaluate<String>({
        'f': {
          'k': {
            't': 2,
            'v': {'i': 5},
          },
        },
      }, 'k', 'fallback');
      expect(r.error, equals('TYPE_MISMATCH'));
      expect(r.value, equals('fallback'));
    });

    test('double default against t:2 → TYPE_MISMATCH (strict)', () {
      // Dart's `int` and `double` are disjoint at the language level
      // (unlike Python's `isinstance(True, int)`). A double default
      // against a t:2 setting refuses with TYPE_MISMATCH.
      final r = evaluate<double>({
        'f': {
          'k': {
            't': 2,
            'v': {'i': 5},
          },
        },
      }, 'k', -1.0);
      expect(r.error, equals('TYPE_MISMATCH'));
      expect(r.value, equals(-1.0));
    });

    test('missing v.i → MALFORMED_VALUE', () {
      final r = evaluate<int>({
        'f': {
          'k': {
            't': 2,
            'v': {'s': '5'},
          },
        },
      }, 'k', -1);
      expect(r.error, equals('MALFORMED_VALUE'));
      expect(r.value, equals(-1));
    });
  });

  group('evaluate — t=3 double', () {
    test('happy path returns cached double', () {
      final r = evaluate<double>({
        'f': {
          'k': {
            't': 3,
            'v': {'d': 0.25},
          },
        },
      }, 'k', -1.0);
      expect(r.error, isNull);
      expect(r.value, equals(0.25));
      expect(r.value, isA<double>());
    });

    test('integer-valued JSON number for t:3 widens to double', () {
      // Dart's jsonDecode returns `int` for integer-valued JSON; the
      // evaluator must accept and widen to `double`.
      final r = evaluate<double>({
        'f': {
          'k': {
            't': 3,
            'v': {'d': 0}, // arrives as int(0) post-jsonDecode
          },
        },
      }, 'k', -1.0);
      expect(r.error, isNull);
      expect(r.value, equals(0.0));
      expect(r.value, isA<double>());
    });

    test('int default against t:3 → TYPE_MISMATCH (strict)', () {
      // Dart `int` is NOT `double`. An int default against a t:3 setting
      // refuses with TYPE_MISMATCH (matches ConfigCat-Dart's strict
      // separation).
      final r = evaluate<int>({
        'f': {
          'k': {
            't': 3,
            'v': {'d': 0.25},
          },
        },
      }, 'k', -1);
      expect(r.error, equals('TYPE_MISMATCH'));
      expect(r.value, equals(-1));
    });

    test('missing v.d → MALFORMED_VALUE', () {
      final r = evaluate<double>({
        'f': {
          'k': {
            't': 3,
            'v': {'s': '0.25'},
          },
        },
      }, 'k', -1.0);
      expect(r.error, equals('MALFORMED_VALUE'));
      expect(r.value, equals(-1.0));
    });
  });
}
