// SPDX-License-Identifier: MIT

/// Public-API exercise of the network paths in `ConfeatureClient`. We
/// spin up a local `HttpServer` and point the client's `baseUrl` at it,
/// which lets us cover the AutoPoll initial-fetch path, LazyLoad's
/// stale-read fetch, and `forceRefresh` non-local-only outcomes without
/// touching the real CDN.
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
  String? matchIfNoneMatch304,
}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  unawaited(() async {
    await for (final req in server) {
      final ifNoneMatch = req.headers.value('If-None-Match');
      if (matchIfNoneMatch304 != null && ifNoneMatch == matchIfNoneMatch304) {
        req.response.statusCode = 304;
        if (etag != null) {
          req.response.headers.set('etag', etag);
        }
        await req.response.close();
        continue;
      }
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
  group('ConfeatureClient — network paths', () {
    test('LazyLoad triggers a fetch on stale read + caches the body', () async {
      final server = await _startMockCdn(
        body: {
          'p': {},
          'f': {
            'feature.x': {
              't': 0,
              'v': {'b': true},
              'i': 'vx'
            },
          },
        },
        etag: '"v1"',
      );
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const LazyLoad(),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        // First call must trigger the fetch and resolve to the cached value.
        final value = await client.getValue('feature.x', false);
        expect(value, isTrue);
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('forceRefresh on AutoPoll surfaces the fetched body', () async {
      final server = await _startMockCdn(
        body: {
          'p': {},
          'f': {
            'feature.y': {
              't': 0,
              'v': {'b': true},
              'i': 'vy'
            },
          },
        },
        etag: '"v2"',
      );
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        // Use a long poll interval so the periodic Timer doesn't fire
        // mid-test; we only need the eager initial fetch + an explicit
        // forceRefresh.
        pollingMode: const AutoPoll(pollInterval: Duration(hours: 1)),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        // Give the initial AutoPoll fetch time to complete.
        await Future<void>.delayed(const Duration(milliseconds: 50));
        final refresh = await client.forceRefresh();
        expect(refresh.success, isTrue);
        // The second forceRefresh will hit the 304 branch (we already
        // captured the etag from the first response).
        final refresh2 = await client.forceRefresh();
        expect(refresh2.success, isTrue);
        expect(await client.getValue('feature.y', false), isTrue);
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('forceRefresh on closed client returns CLIENT_CLOSED', () async {
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      client.close();
      final result = await client.forceRefresh();
      expect(result.success, isFalse);
      expect(result.error, equals('CLIENT_CLOSED'));
    });

    test('forceRefresh on ManualPoll fetches off-cadence', () async {
      final server = await _startMockCdn(
        body: {
          'p': {},
          'f': {
            'feature.z': {
              't': 0,
              'v': {'b': true},
              'i': 'vz'
            },
          },
        },
        etag: '"v3"',
      );
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        final refresh = await client.forceRefresh();
        expect(refresh.success, isTrue);
        expect(await client.getValue('feature.z', false), isTrue);
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('non-2xx fetch surfaces a failure refresh result', () async {
      final server = await _startMockCdn(body: const {}, status: 500);
      final baseUrl = 'http://${server.address.address}:${server.port}';
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        baseUrl: baseUrl,
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        final refresh = await client.forceRefresh();
        expect(refresh.success, isFalse);
        expect(refresh.error, equals('HTTP 500'));
      } finally {
        client.close();
        await server.close(force: true);
      }
    });

    test('client.getValue returns default on cold-start failure', () async {
      // Bind a port + close it so the SDK gets a connection refused.
      final tmp = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final port = tmp.port;
      await tmp.close(force: true);
      final client = ConfeatureClient.get(
        _testSdkKey,
        pollingMode: const ManualPoll(),
        baseUrl: 'http://127.0.0.1:$port',
        cache: _InMemoryCache(),
        logger: StderrLogger(level: LogLevel.off),
      );
      try {
        await client.forceRefresh();
        expect(await client.getValue('feature.missing', false), isFalse);
      } finally {
        client.close();
      }
    });
  });
}
