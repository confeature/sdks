// SPDX-License-Identifier: MIT

/// Spec 099 / #267 — slice 10/14 — sdk-dart online/offline triplet.
///
/// Mirrors `configcat_client`'s `ConfigCatClient.setOnline()` /
/// `.setOffline()` / `.isOffline()`. Conformance lives in
/// `api_surface_conformance_test.dart`; this file exercises behaviour.
library;

import 'package:confeature/confeature.dart';
import 'package:test/test.dart';

const String _sdkKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

class _NoopCache extends ConfigCache {
  @override
  CacheEntry? read() => null;
  @override
  void write(CacheEntry entry) {}
}

ConfeatureClient _buildManualClient({Logger? logger}) {
  return ConfeatureClient.get(
    _sdkKey,
    pollingMode: const ManualPoll(),
    cache: _NoopCache(),
    logger: logger,
  );
}

ConfeatureClient _buildLocalOnlyClient({Logger? logger}) {
  return ConfeatureClient.get(
    _sdkKey,
    pollingMode: const ManualPoll(),
    flagOverrides: FlagOverrides(
      dataSource:
          MapOverrideDataSource(const <String, Object>{'feature.x': true}),
      behaviour: OverrideBehaviour.localOnly,
    ),
    cache: _NoopCache(),
    logger: logger,
  );
}

class _CapturingLogger implements Logger {
  final List<String> messages = <String>[];

  @override
  void error(String message, [Object? exception, StackTrace? stackTrace]) =>
      messages.add('ERROR $message');

  @override
  void warning(String message) => messages.add('WARN $message');

  @override
  void info(String message) => messages.add('INFO $message');

  @override
  void debug(String message) => messages.add('DEBUG $message');
}

void main() {
  group('sdk-dart online/offline triplet (spec 099 / #267)', () {
    test('freshly constructed client is online', () {
      final client = _buildManualClient();
      try {
        expect(client.isOffline(), isFalse);
      } finally {
        client.close();
      }
    });

    test('setOffline flips the flag', () {
      final client = _buildManualClient();
      try {
        client.setOffline();
        expect(client.isOffline(), isTrue);
      } finally {
        client.close();
      }
    });

    test('setOnline resets the flag', () {
      final client = _buildManualClient();
      try {
        client.setOffline();
        expect(client.isOffline(), isTrue);
        client.setOnline();
        expect(client.isOffline(), isFalse);
      } finally {
        client.close();
      }
    });

    test('setters are idempotent', () {
      final client = _buildManualClient();
      try {
        for (var i = 0; i < 3; i++) {
          client.setOffline();
        }
        expect(client.isOffline(), isTrue);
        for (var i = 0; i < 3; i++) {
          client.setOnline();
        }
        expect(client.isOffline(), isFalse);
      } finally {
        client.close();
      }
    });

    test('forceRefresh returns failure with OFFLINE_MODE while offline',
        () async {
      final client = _buildManualClient();
      try {
        client.setOffline();
        final r = await client.forceRefresh();
        expect(r.success, isFalse);
        expect(r.error, equals('OFFLINE_MODE'));
      } finally {
        client.close();
      }
    });

    test('LocalOnly client is offline by definition', () {
      final client = _buildLocalOnlyClient();
      try {
        expect(client.isOffline(), isTrue);
      } finally {
        client.close();
      }
    });

    test('LocalOnly setOnline logs warning and is no-op', () {
      final log = _CapturingLogger();
      final client = _buildLocalOnlyClient(logger: log);
      try {
        client.setOnline();
        expect(client.isOffline(), isTrue);
        expect(
          log.messages
              .any((m) => m.startsWith('WARN') && m.contains('LOCAL_ONLY')),
          isTrue,
        );
      } finally {
        client.close();
      }
    });

    test('LocalOnly setOffline is a silent no-op', () {
      final log = _CapturingLogger();
      final client = _buildLocalOnlyClient(logger: log);
      try {
        client.setOffline();
        expect(client.isOffline(), isTrue);
        expect(
          log.messages
              .any((m) => m.startsWith('WARN') && m.contains('setOffline')),
          isFalse,
        );
      } finally {
        client.close();
      }
    });

    test('closed client reports offline=true', () {
      final client = _buildManualClient();
      client.close();
      expect(client.isOffline(), isTrue);
    });

    test('closed client setters log warning', () {
      final log = _CapturingLogger();
      final client = _buildManualClient(logger: log);
      client.close();
      client.setOnline();
      client.setOffline();
      expect(
        log.messages
            .any((m) => m.startsWith('WARN') && m.contains('setOnline')),
        isTrue,
      );
      expect(
        log.messages
            .any((m) => m.startsWith('WARN') && m.contains('setOffline')),
        isTrue,
      );
    });
  });
}
