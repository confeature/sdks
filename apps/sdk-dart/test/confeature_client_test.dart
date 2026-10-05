// SPDX-License-Identifier: MIT

/// Unit tests for `ConfeatureClient` — construction, getValue
/// short-circuits, idempotent close, builder ergonomics.
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

void main() {
  group('ConfeatureClient.get', () {
    test('rejects empty sdkKey', () {
      expect(
        () => ConfeatureClient.get(''),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('localOnly mode bypasses network + resolves overrides', () {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'feature.x': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        expect(client.getValueSync('feature.x', false), isTrue);
        expect(client.getValueSync('feature.missing', false), isFalse);
      } finally {
        client.close();
      }
    });

    test('forceRefresh on localOnly returns success without I/O', () async {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'feature.x': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        final result = await client.forceRefresh();
        expect(result.success, isTrue);
      } finally {
        client.close();
      }
    });

    test('close() is idempotent', () {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'k': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      client.close();
      // Second call must not throw.
      expect(client.close, returnsNormally);
    });

    test('snapshot.getAllKeys unions config + overrides', () {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource:
              MapOverrideDataSource({'feature.x': true, 'feature.y': false}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        final snap = client.snapshot();
        expect(snap.getAllKeys(), equals(['feature.x', 'feature.y']));
      } finally {
        client.close();
      }
    });

    test('getValue after close returns default', () async {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'feature.x': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      client.close();
      expect(await client.getValue('feature.x', false), equals(false));
    });
  });

  group('ConfeatureClient.builder', () {
    test('builds an equivalent client', () {
      final client = ConfeatureClient.builder(
        _testSdkKey,
      )
          .withPollingMode(const ManualPoll())
          .withFlagOverrides(FlagOverrides(
            dataSource: MapOverrideDataSource({'feature.x': true}),
            behaviour: OverrideBehaviour.localOnly,
          ))
          .withCache(_InMemoryCache())
          .withLogger(StderrLogger(level: LogLevel.off))
          .build();
      try {
        expect(client.getValueSync('feature.x', false), isTrue);
      } finally {
        client.close();
      }
    });
  });
}
