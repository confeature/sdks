// SPDX-License-Identifier: MIT

/// Tests for the `Hooks` events bus (epic #574 / issue #576).
///
/// Covers: each of the 4 events fires at the right moment, multi-subscriber
/// dispatch (two listeners both fire), and a throwing listener does not
/// break siblings or the client. Reuses the local-override + mock-CDN
/// patterns from the existing dart tests.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

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

Future<HttpServer> _startMockCdn({
  required Map<String, dynamic> body,
  int status = 200,
  String? etag,
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(() async {
    await for (final req in server) {
      req.response.statusCode = status;
      if (etag != null) {
        req.response.headers.set('etag', etag);
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
      await req.response.close();
    }
  }());
  return server;
}

void main() {
  group('Hooks — unit dispatch', () {
    test('multi-subscriber: every onClientReady listener fires', () {
      var a = 0;
      var b = 0;
      final hooks = Hooks(onClientReady: () => a++);
      hooks.addOnClientReady(() => b++);
      hooks.invokeOnReady();
      expect(a, equals(1));
      expect(b, equals(1));
    });

    test('onClientReady is one-shot (repeat invoke is a no-op)', () {
      var count = 0;
      final hooks = Hooks(onClientReady: () => count++);
      hooks.invokeOnReady();
      hooks.invokeOnReady();
      expect(count, equals(1));
    });

    test('late onClientReady subscriber fires immediately if already ready',
        () {
      var count = 0;
      final hooks = Hooks();
      hooks.invokeOnReady();
      hooks.addOnClientReady(() => count++);
      expect(count, equals(1));
    });

    test('a throwing listener does not break siblings', () {
      var reached = false;
      final hooks = Hooks();
      hooks.addOnConfigChanged((_) => throw StateError('boom'));
      hooks.addOnConfigChanged((_) => reached = true);
      // Must not throw, and the second listener must still run.
      expect(() => hooks.invokeConfigChanged(const {}), returnsNormally);
      expect(reached, isTrue);
    });

    test('onError multi-subscriber + payload', () {
      final messages = <String>[];
      final hooks = Hooks(onError: (m, [e, s]) => messages.add('a:$m'));
      hooks.addOnError((m, [e, s]) => messages.add('b:$m'));
      hooks.invokeError('oops');
      expect(messages, equals(['a:oops', 'b:oops']));
    });

    test('clear removes all listeners', () {
      var count = 0;
      final hooks = Hooks(onClientReady: () => count++);
      hooks.clear();
      hooks.invokeOnReady();
      expect(count, equals(0));
    });
  });

  group('Hooks — wired into the client', () {
    test('onClientReady fires for LocalOnly clients', () {
      var ready = 0;
      final hooks = Hooks(onClientReady: () => ready++);
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'k': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
        hooks: hooks,
      );
      try {
        expect(ready, equals(1));
      } finally {
        client.close();
      }
    });

    test('onFlagEvaluated fires on getValueDetails', () async {
      final seen = <EvaluationDetails<dynamic>>[];
      final hooks = Hooks(onFlagEvaluated: seen.add);
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'k': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
        hooks: hooks,
      );
      try {
        await client.getValueDetails<bool>(key: 'k', defaultValue: false);
        expect(seen, hasLength(1));
        expect(seen.single.key, equals('k'));
        expect(seen.single.value, isTrue);
      } finally {
        client.close();
      }
    });

    test('onConfigChanged + onClientReady fire on a fresh fetch', () async {
      final changed = <Map<String, dynamic>>[];
      var ready = 0;
      final hooks = Hooks(
        onConfigChanged: changed.add,
        onClientReady: () => ready++,
      );
      final server = await _startMockCdn(
        body: {
          'p': <String, dynamic>{},
          'f': {
            'feature.x': {
              't': 0,
              'v': {'b': true},
              'i': 'vx',
            },
          },
        },
        etag: '"v1"',
      );
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
        hooks: hooks,
      );
      try {
        final refresh = await client.forceRefresh();
        expect(refresh.success, isTrue);
        expect(changed, hasLength(1));
        expect(changed.single.containsKey('feature.x'), isTrue);
        expect(ready, equals(1));
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('onError fires on a failed fetch', () async {
      final errors = <String>[];
      final hooks = Hooks(onError: (m, [e, s]) => errors.add(m));
      final server = await _startMockCdn(body: const {}, status: 500);
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
        hooks: hooks,
      );
      try {
        final refresh = await client.forceRefresh();
        expect(refresh.success, isFalse);
        expect(errors, hasLength(1));
        expect(errors.single, contains('HTTP 500'));
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('a throwing client hook does not break the client', () async {
      final hooks = Hooks(
        onFlagEvaluated: (_) => throw StateError('boom'),
      );
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        flagOverrides: FlagOverrides(
          dataSource: MapOverrideDataSource({'k': true}),
          behaviour: OverrideBehaviour.localOnly,
        ),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
        hooks: hooks,
      );
      try {
        final details = await client.getValueDetails<bool>(
          key: 'k',
          defaultValue: false,
        );
        // The throwing listener was isolated — the call returns normally.
        expect(details.value, isTrue);
      } finally {
        client.close();
      }
    });
  });
}
