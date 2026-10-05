// SPDX-License-Identifier: MIT

/// Unit tests for the 7-branch override-eval decision tree.
library;

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';
// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/override_eval.dart';

void main() {
  group('evaluateOverrideSync — 7-branch tree', () {
    test('Branch 1: null overrides → fall through', () {
      final (value, handled) = evaluateOverrideSync(null, 'k', false);
      expect(handled, isFalse);
      expect(value, isNull);
    });

    test('Branch 2: non-LocalOnly → fall through', () {
      final fo = FlagOverrides(
        dataSource: MapOverrideDataSource({'k': true}),
        behaviour: OverrideBehaviour.localOverRemote,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', false);
      expect(handled, isFalse);
      expect(value, isNull);
    });

    test('Branch 3: null sync map → fall through', () {
      final fo = FlagOverrides(
        dataSource: _NullMapSource(),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', false);
      expect(handled, isFalse);
      expect(value, isNull);
    });

    test('Branch 4: key absent → default with handled=true', () {
      final fo = FlagOverrides(
        dataSource: MapOverrideDataSource({'other': true}),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', false);
      expect(handled, isTrue);
      expect(value, equals(false));
    });

    test('Branch 5: all-null slot → default with handled=true', () {
      final fo = FlagOverrides(
        dataSource: _EmptySlotSource(),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', false);
      expect(handled, isTrue);
      expect(value, equals(false));
    });

    test('Branch 6: TYPE_MISMATCH → default with handled=true', () {
      // candidate is bool, default is String → mismatch.
      final fo = FlagOverrides(
        dataSource: MapOverrideDataSource({'k': true}),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', 'default-string');
      expect(handled, isTrue);
      expect(value, equals('default-string'));
    });

    test('Branch 6: null default bypasses the type check', () {
      final fo = FlagOverrides(
        dataSource: MapOverrideDataSource({'k': true}),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', null);
      expect(handled, isTrue);
      expect(value, equals(true));
    });

    test('Branch 7: happy path returns typed override value', () {
      final fo = FlagOverrides(
        dataSource: MapOverrideDataSource({'k': true}),
        behaviour: OverrideBehaviour.localOnly,
      );
      final (value, handled) = evaluateOverrideSync(fo, 'k', false);
      expect(handled, isTrue);
      expect(value, equals(true));
    });
  });
}

class _NullMapSource extends IOverrideDataSource {
  @override
  Map<String, ISettingValue>? getOverridesSync() => null;
}

class _EmptySlotSource extends IOverrideDataSource {
  @override
  Map<String, ISettingValue>? getOverridesSync() => {
        'k': const ISettingValue(),
      };
}
