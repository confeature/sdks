// SPDX-License-Identifier: MIT

/// #826 — ConfigCat reserves no setting key, so the api serves `__proto__`
/// as an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
/// settings into a plain object; these tests hold the Dart SDK to keeping it
/// from the served bytes and from a local override.
library;

import 'dart:async';
import 'dart:io';

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';

const String _testSdkKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const String _served = '{"p":{"u":"","r":0,"s":"salt"},'
    '"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}';

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
  test('a served __proto__ flag returns its served value', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    unawaited(() async {
      await for (final req in server) {
        req.response.headers.contentType = ContentType.json;
        req.response.write(_served);
        await req.response.close();
      }
    }());
    final client = ConfeatureClient.get(
      _testSdkKey,
      pollingMode: const ManualPoll(),
      baseUrl: 'http://${server.address.address}:${server.port}',
      cache: _InMemoryCache(),
      logger: StderrLogger(level: LogLevel.off),
    );
    try {
      expect((await client.forceRefresh()).success, isTrue);
      expect(await client.getValue('__proto__', false), isTrue);
    } finally {
      client.close();
      await server.close(force: true);
    }
  });

  test('a localOnly override keyed __proto__ returns the override', () async {
    final client = ConfeatureClient.get(
      _testSdkKey,
      pollingMode: const ManualPoll(),
      flagOverrides: FlagOverrides(
        dataSource: MapOverrideDataSource({'__proto__': true}),
        behaviour: OverrideBehaviour.localOnly,
      ),
      cache: _InMemoryCache(),
      logger: StderrLogger(level: LogLevel.off),
    );
    try {
      expect(await client.getValue('__proto__', false), isTrue);
    } finally {
      client.close();
    }
  });
}
