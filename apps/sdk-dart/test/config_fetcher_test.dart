// SPDX-License-Identifier: MIT

/// Unit tests for the HTTP config fetcher.
///
/// Uses `package:http`'s testing `MockClient` to avoid hitting the
/// network. Verifies User-Agent, If-None-Match propagation, 200/304
/// branches, and the never-throw fail-closed contract on error paths.
library;

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/config_fetcher.dart';
import 'package:confeature/confeature.dart';

void main() {
  group('ConfigFetcher', () {
    const sdkKey =
        'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    test('emits User-Agent + parses 200 → FetchStatus.fetched', () async {
      late http.BaseRequest captured;
      final mock = MockClient((req) async {
        captured = req;
        return http.Response(
          jsonEncode({'p': {}, 'f': <String, dynamic>{}}),
          200,
          headers: {'etag': '"abc"', 'content-type': 'application/json'},
        );
      });
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: StderrLogger(level: LogLevel.off),
        httpClient: mock,
      );
      final result = await fetcher.fetch();
      expect(result.status, equals(FetchStatus.fetched));
      expect(result.etag, equals('"abc"'));
      expect(
          captured.headers['User-Agent'], equals('confeature-dart-sdk/0.1.0'));
      fetcher.close();
    });

    group('request path (#803 FR-001) — ConfigCat\'s, compared parsed', () {
      Future<Uri> capturePath(String key) async {
        late Uri captured;
        final mock = MockClient((req) async {
          captured = req.url;
          return http.Response(
            jsonEncode({'p': {}, 'f': <String, dynamic>{}}),
            200,
          );
        });
        final fetcher = ConfigFetcher(
          sdkKey: key,
          version: '0.1.0',
          logger: StderrLogger(level: LogLevel.off),
          httpClient: mock,
        );
        final result = await fetcher.fetch();
        fetcher.close();
        expect(result.status, equals(FetchStatus.fetched));
        expect(Uri.parse(fetcher.url!).path, equals(captured.path));
        return captured;
      }

      test('a legacy key travels raw, as one segment', () async {
        final url = await capturePath(sdkKey);
        expect(url.host, equals('cdn-global.confeature.io'));
        expect(
          url.path,
          equals('/configuration-files/$sdkKey/config_v6.json'),
        );
      });

      test('a configcat-shaped key travels raw — three segments, no %2F',
          () async {
        const key =
            'configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d';
        final url = await capturePath(key);
        expect(
          url.path,
          equals('/configuration-files/configcat-sdk-1/'
              'aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json'),
        );
        expect(url.path, isNot(contains('/v2/')));
      });

      // Go `url.PathEscape` literals, copied from `go run` output — never
      // values built with the code under test. Each one holds characters
      // where Go and `Uri.encodeComponent` disagree: Go keeps `$&+:=@`
      // (encodeComponent escapes them) and escapes `!*'()` (encodeComponent
      // keeps them).
      const goPathEscape = {
        r"bad key$&+:=@,;!'()*~/x?y#z%..":
            r"bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
        "!*'()": '%21%2A%27%28%29',
        r'$&+:=@': r'$&+:=@',
        'not/a valid?key#x': 'not%2Fa%20valid%3Fkey%23x',
        'a/../../b': 'a%2F..%2F..%2Fb',
        'café ☃ 😀': 'caf%C3%A9%20%E2%98%83%20%F0%9F%98%80',
        '"<>[]\\^`{|}\t\n': '%22%3C%3E%5B%5D%5C%5E%60%7B%7C%7D%09%0A',
      };

      for (final entry in goPathEscape.entries) {
        test('pathEscape(${jsonEncode(entry.key)}) is Go url.PathEscape', () {
          expect(ConfigFetcher.pathEscape(entry.key), equals(entry.value));
        });
      }

      for (final entry in goPathEscape.entries) {
        test(
            'malformed key ${jsonEncode(entry.key)} is sent as ONE segment, '
            'escaped as Go url.PathEscape', () async {
          final url = await capturePath(entry.key);
          expect(
            url.path,
            equals('/configuration-files/${entry.value}/config_v6.json'),
          );
          expect(url.pathSegments, hasLength(3));
          expect(url.pathSegments[1], equals(entry.key));
          expect(url.query, isEmpty);
          expect(url.fragment, isEmpty);
        });
      }

      test(
          'a key holding a lone surrogate has no UTF-8 form → no request, '
          'INVALID_SDK_KEY, no throw', () async {
        const key = 'confeature-sdk-1-\uD800-lone-surrogate-key-padding';
        var requests = 0;
        final mock = MockClient((_) async {
          requests++;
          return http.Response('{"f":{}}', 200);
        });
        final logger = _RecordingLogger();
        final fetcher = ConfigFetcher(
          sdkKey: key,
          version: '0.1.0',
          logger: logger,
          httpClient: mock,
        );
        expect(ConfigFetcher.pathEscape(key), isNull);
        expect(fetcher.url, isNull);
        final result = await fetcher.fetch();
        fetcher.close();
        expect(requests, equals(0));
        expect(result.error, equals('INVALID_SDK_KEY'));
        for (final line in logger.lines) {
          expect(line, isNot(contains(key)));
        }
      });

      // #803 brief item 3: `Uri.parse` throws a FormatException quoting the
      // whole keyed URL; a bad base URL must end as a fixed code instead.
      for (final baseUrl in const [
        'http://[bad',
        'not a url',
        'ftp://cdn.example',
        '',
        'https://',
        // A `?` or `#` in the base would move the key out of the path —
        // into the query string (sent) or the fragment (never sent).
        'https://cdn.example?',
        'https://cdn.example/?x=1',
        'https://cdn.example/edge?x=1&y=',
        'https://cdn.example#',
        'https://cdn.example/#frag',
        'https://cdn.example/edge?q#frag',
        'http://127.0.0.1:8080#',
      ]) {
        test(
            'base URL ${jsonEncode(baseUrl)} → INVALID_REQUEST, no request, '
            'no throw, key-free', () async {
          const key = 'configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/'
              'pQ5rS7tU9vW1xY3zA5bC7d';
          var requests = 0;
          final mock = MockClient((_) async {
            requests++;
            return http.Response('{"f":{}}', 200);
          });
          final logger = _RecordingLogger();
          final fetcher = ConfigFetcher(
            sdkKey: key,
            version: '0.1.0',
            logger: logger,
            baseUrl: baseUrl,
            httpClient: mock,
          );
          final result = await fetcher.fetch();
          fetcher.close();
          expect(requests, equals(0));
          expect(result.status, equals(FetchStatus.failed));
          expect(result.error, equals('INVALID_REQUEST'));
          expect(logger.lines.single, contains('INVALID_REQUEST'));
          _expectKeyFree(key, logger, result);
        });
      }

      for (final key in const ['', '.', '..']) {
        test('key "$key" cannot be a path segment → no request at all',
            () async {
          var requests = 0;
          final mock = MockClient((_) async {
            requests++;
            return http.Response('{"f":{}}', 200);
          });
          final logger = _RecordingLogger();
          final fetcher = ConfigFetcher(
            sdkKey: key,
            version: '0.1.0',
            logger: logger,
            httpClient: mock,
          );
          expect(fetcher.url, isNull);
          final result = await fetcher.fetch();
          fetcher.close();
          expect(requests, equals(0));
          expect(result.status, equals(FetchStatus.failed));
          expect(result.error, equals('INVALID_SDK_KEY'));
          expect(logger.lines.single, contains('INVALID_SDK_KEY'));
          expect(logger.lines.single, contains('[redacted]'));
        });
      }
    });

    test('propagates If-None-Match on subsequent fetch', () async {
      String? capturedIfNoneMatch;
      final mock = MockClient((req) async {
        capturedIfNoneMatch = req.headers['If-None-Match'];
        return http.Response('', 304, headers: {'etag': '"abc"'});
      });
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: StderrLogger(level: LogLevel.off),
        httpClient: mock,
      );
      final result = await fetcher.fetch('"abc"');
      expect(result.status, equals(FetchStatus.notModified));
      expect(capturedIfNoneMatch, equals('"abc"'));
      fetcher.close();
    });

    test('non-2xx → FetchStatus.failed with HTTP reason', () async {
      final mock = MockClient((_) async => http.Response('boom', 500));
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: StderrLogger(level: LogLevel.off),
        httpClient: mock,
      );
      final result = await fetcher.fetch();
      expect(result.status, equals(FetchStatus.failed));
      expect(result.error, equals('HTTP 500'));
      fetcher.close();
    });

    test('malformed JSON → FetchStatus.failed with MALFORMED_JSON', () async {
      final mock = MockClient((_) async => http.Response('not-json', 200));
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: StderrLogger(level: LogLevel.off),
        httpClient: mock,
      );
      final result = await fetcher.fetch();
      expect(result.status, equals(FetchStatus.failed));
      expect(result.error, equals('MALFORMED_JSON'));
      fetcher.close();
    });

    test(
        'client exception → fail-closed (no throw), a fixed reason code — '
        'never the exception text, which quotes the keyed URL', () async {
      final mock = MockClient(
        (req) async => throw http.ClientException(
            'connection refused: ${req.url}', req.url),
      );
      final logger = _RecordingLogger();
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: logger,
        httpClient: mock,
      );
      final result = await fetcher.fetch();
      expect(result.status, equals(FetchStatus.failed));
      expect(result.error, equals('NETWORK_ERROR'));
      _expectKeyFree(sdkKey, logger, result);
      fetcher.close();
    });

    test('any other exception → FETCH_EXCEPTION, key-free', () async {
      final mock =
          MockClient((req) async => throw StateError('boom at ${req.url}'));
      final logger = _RecordingLogger();
      final fetcher = ConfigFetcher(
        sdkKey: sdkKey,
        version: '0.1.0',
        logger: logger,
        httpClient: mock,
      );
      final result = await fetcher.fetch();
      expect(result.error, equals('FETCH_EXCEPTION'));
      _expectKeyFree(sdkKey, logger, result);
      fetcher.close();
    });
  });

  // #803 FR-004: the key is now in the URL, so a transport failure must
  // never carry it to a log line or `FetchResult.error`. Forced against a
  // real loopback server through the default `http.Client`, whose
  // exceptions quote the request URL / redirect Location.
  group('forced transport failures leak no key (#803 FR-004)', () {
    late HttpServer server;
    late String mode;

    setUp(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        switch (mode) {
          case 'timeout':
            // Never respond: the fetcher's deadline fires first.
            return;
          case 'reset':
            req.response.statusCode = 200;
            req.response.headers.contentLength = 4096;
            final socket = await req.response.detachSocket();
            socket.add(utf8.encode('{"p":{"s":"partial'));
            await socket.flush();
            socket.destroy();
          case 'redirect-loop':
            // Redirect to the same keyed path forever.
            req.response.statusCode = 302;
            req.response.headers.set('location', req.uri.toString());
            await req.response.close();
        }
      });
    });

    tearDown(() => server.close(force: true));

    const keys = {
      'configcat-shaped': 'configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/'
          'pQ5rS7tU9vW1xY3zA5bC7d',
      'legacy': 'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-'
          'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const expectedCodes = {
      'timeout': 'TIMEOUT',
      'reset': 'NETWORK_ERROR',
      'redirect-loop': 'NETWORK_ERROR',
    };

    for (final shape in keys.entries) {
      for (final failure in expectedCodes.entries) {
        test('${failure.key} with a ${shape.key} key', () async {
          mode = failure.key;
          final logger = _RecordingLogger();
          final fetcher = ConfigFetcher(
            sdkKey: shape.value,
            version: '0.1.0',
            logger: logger,
            baseUrl: 'http://127.0.0.1:${server.port}',
            requestTimeout: const Duration(milliseconds: 300),
          );
          final result = await fetcher.fetch();
          fetcher.close();
          expect(result.status, equals(FetchStatus.failed));
          expect(result.error, equals(failure.value));
          expect(logger.lines, isNotEmpty);
          _expectKeyFree(shape.value, logger, result);
        });
      }
    }
  });
}

/// Records every log line, at every level.
class _RecordingLogger extends Logger {
  final List<String> lines = [];

  @override
  void debug(String message) => lines.add(message);

  @override
  void info(String message) => lines.add(message);

  @override
  void warning(String message) => lines.add(message);

  @override
  void error(String message) => lines.add(message);
}

/// The secret parts of [key]: the full key and each random part (the
/// 22-character parts of a ConfigCat-shaped key, the 32-character parts
/// of a legacy key).
List<String> _secretParts(String key) {
  if (key.startsWith('configcat-sdk-1/')) {
    return [key, ...key.split('/').skip(1)];
  }
  const prefix = 'confeature-sdk-1-';
  final body = key.substring(prefix.length);
  return [key, body.substring(0, 32), body.substring(33)];
}

void _expectKeyFree(String key, _RecordingLogger logger, FetchResult result) {
  for (final secret in _secretParts(key)) {
    for (final line in logger.lines) {
      expect(line, isNot(contains(secret)), reason: 'log line leaks the key');
      expect(line, isNot(contains(Uri.encodeComponent(secret))),
          reason: 'log line leaks the escaped key');
      expect(line, isNot(contains(ConfigFetcher.pathEscape(secret)!)),
          reason: 'log line leaks the path-escaped key');
    }
    expect(result.error ?? '', isNot(contains(secret)),
        reason: 'FetchResult.error leaks the key');
  }
}
