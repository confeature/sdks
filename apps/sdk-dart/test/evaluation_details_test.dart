// SPDX-License-Identifier: MIT

/// Spec 088 / #266 — unit tests for `EvaluationDetails<T>` +
/// `ConfeatureClient.getValueDetails<T>` + `ConfeatureClient.getAllValues`.
library;

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';

const String _testSdkKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

class _InMemoryCache extends ConfigCache {
  CacheEntry? _entry;
  @override
  CacheEntry? read() => _entry;
  @override
  void write(CacheEntry entry) {
    _entry = entry;
  }
}

ConfeatureClient _localOnlyClient(Map<String, Object> overrides) {
  return ConfeatureClient.get(
    _testSdkKey,
    pollingMode: const ManualPoll(),
    flagOverrides: FlagOverrides(
      dataSource: MapOverrideDataSource(overrides),
      behaviour: OverrideBehaviour.localOnly,
    ),
    cache: _InMemoryCache(),
    logger: StderrLogger(level: LogLevel.off),
  );
}

void main() {
  group('EvaluationDetails<T>', () {
    test('makeError populates fail-closed envelope', () {
      final details = EvaluationDetails.makeError<bool>(
        'feature.x',
        false,
        'KEY_NOT_FOUND',
        const User(identifier: 'alice'),
      );
      expect(details.key, equals('feature.x'));
      expect(details.value, isFalse);
      expect(details.isDefaultValue, isTrue);
      expect(details.error, equals('KEY_NOT_FOUND'));
      expect(details.user, isNotNull);
      expect(details.user!.identifier, equals('alice'));
      expect(details.variationId, isNull);
      expect(details.fetchTime, isNull);
      expect(details.matchedTargetingRule, isNull);
      expect(details.matchedPercentageOption, isNull);
    });

    test('default constructor leaves placeholders null + isDefaultValue=false',
        () {
      const details = EvaluationDetails<String>(
        key: 'k',
        value: 'v',
      );
      expect(details.key, equals('k'));
      expect(details.value, equals('v'));
      expect(details.isDefaultValue, isFalse);
      expect(details.error, isNull);
      expect(details.user, isNull);
      expect(details.fetchTime, isNull);
    });
  });

  group('ConfeatureClient.getValueDetails<T>', () {
    test('happy path returns typed override value with no error', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final details = await client.getValueDetails<bool>(
          key: 'feature.x',
          defaultValue: false,
        );
        expect(details.key, equals('feature.x'));
        expect(details.value, isTrue);
        expect(details.isDefaultValue, isFalse);
        expect(details.error, isNull);
      } finally {
        client.close();
      }
    });

    test('missing key returns KEY_NOT_FOUND with default', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final details = await client.getValueDetails<bool>(
          key: 'feature.missing',
          defaultValue: false,
        );
        expect(details.value, isFalse);
        expect(details.isDefaultValue, isTrue);
        expect(details.error, equals('KEY_NOT_FOUND'));
      } finally {
        client.close();
      }
    });

    test('type mismatch returns TYPE_MISMATCH with default', () async {
      // candidate is bool, default is String → mismatch.
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final details = await client.getValueDetails<String>(
          key: 'feature.x',
          defaultValue: 'default',
        );
        expect(details.value, equals('default'));
        expect(details.isDefaultValue, isTrue);
        expect(details.error, equals('TYPE_MISMATCH'));
      } finally {
        client.close();
      }
    });

    test('closed client returns CLIENT_CLOSED envelope', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      client.close();
      final details = await client.getValueDetails<bool>(
        key: 'feature.x',
        defaultValue: false,
      );
      expect(details.value, isFalse);
      expect(details.isDefaultValue, isTrue);
      expect(details.error, equals('CLIENT_CLOSED'));
    });

    test('user is propagated into the envelope', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final user = const User(identifier: 'alice');
        final details = await client.getValueDetails<bool>(
          key: 'feature.x',
          defaultValue: false,
          user: user,
        );
        expect(details.user, equals(user));
      } finally {
        client.close();
      }
    });

    test('string override returns typed value', () async {
      final client = _localOnlyClient(<String, Object>{'feature.s': 'hello'});
      try {
        final details = await client.getValueDetails<String>(
          key: 'feature.s',
          defaultValue: 'default',
        );
        expect(details.value, equals('hello'));
        expect(details.isDefaultValue, isFalse);
        expect(details.error, isNull);
      } finally {
        client.close();
      }
    });
  });

  group('ConfeatureClient.getAllValues', () {
    test('returns union of override keys with native values', () async {
      final client = _localOnlyClient(<String, Object>{
        'feature.bool': true,
        'feature.str': 'hello',
        'feature.int': 42,
        'feature.dbl': 3.14,
      });
      try {
        final values = await client.getAllValues();
        expect(values, hasLength(4));
        expect(values['feature.bool'], isTrue);
        expect(values['feature.str'], equals('hello'));
        expect(values['feature.int'], equals(42));
        expect(values['feature.dbl'], equals(3.14));
      } finally {
        client.close();
      }
    });

    test('closed client returns empty map', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      client.close();
      final values = await client.getAllValues();
      expect(values, isEmpty);
    });

    test('empty overrides + no config returns empty map', () async {
      final client = _localOnlyClient(<String, Object>{});
      try {
        final values = await client.getAllValues();
        expect(values, isEmpty);
      } finally {
        client.close();
      }
    });

    test('user param is accepted (v1 evaluator ignores it)', () async {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final values = await client.getAllValues(
          user: const User(identifier: 'alice'),
        );
        expect(values['feature.x'], isTrue);
      } finally {
        client.close();
      }
    });
  });

  group('ConfeatureSnapshot.getValueDetails<T>', () {
    test('snapshot returns typed override value', () {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final snap = client.snapshot();
        final details = snap.getValueDetails<bool>(
          key: 'feature.x',
          defaultValue: false,
        );
        expect(details.value, isTrue);
        expect(details.isDefaultValue, isFalse);
        expect(details.error, isNull);
      } finally {
        client.close();
      }
    });

    test('snapshot returns KEY_NOT_FOUND for missing keys', () {
      final client = _localOnlyClient(<String, Object>{'feature.x': true});
      try {
        final snap = client.snapshot();
        final details = snap.getValueDetails<bool>(
          key: 'feature.missing',
          defaultValue: false,
        );
        expect(details.value, isFalse);
        expect(details.isDefaultValue, isTrue);
        expect(details.error, equals('KEY_NOT_FOUND'));
      } finally {
        client.close();
      }
    });
  });
}
