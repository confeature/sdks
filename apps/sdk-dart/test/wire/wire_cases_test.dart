// SPDX-License-Identifier: MIT

/// Wire-protocol fixture suite (Dart consumer).
///
/// Drives `package:confeature`'s `ConfigFetcher` against each case in
/// `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
/// corpus is the language-agnostic contract; this file is the Dart
/// consumer that maps Dart's `FetchResult` shape onto the corpus's
/// normalised `{fetched, notModified, failed}` × `{fetchFailed,
/// timeout, parseFailed, invalidSdkKey}` vocabulary.
///
/// The Dart SDK encodes its failure reason as a string in
/// `FetchResult.error` rather than a typed enum (sdk-node ships
/// `SdkErrorCode`; this maps the string form back to the same
/// vocabulary). When a future revision of `ConfigFetcher` switches to
/// a typed enum, update [_dartErrorToClass] accordingly.
///
/// See epic #146 (contract testing framework) + #148 (this suite) +
/// spec 112.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/config_fetcher.dart';
import 'package:confeature/confeature.dart';

import '../workspace_root.dart';

const String _sdkKey =
    'confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

/// Every `given` / `expected` field this consumer reads. A corpus field
/// outside these sets FAILS the case (#803 FR-003), so a new expectation
/// can never be skipped silently.
const Set<String> _knownGiven = {'previousEtag', 'sdkKey', 'baseUrl'};
const Set<String> _knownExpected = {
  'outcome',
  'errorClass',
  'hasConfig',
  'resultingEtag',
  'requestHeaderIfNoneMatch',
  'requestUrlPrefix',
  'requestPath',
};

const String _defaultBaseUrl = 'https://cdn.test.confeature.io';

String _fixturesDir() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/fixtures';

String _wireCasesPath() => '${_fixturesDir()}/wire-cases.json';

/// Resolve a `server.bodyRef` or `server.body` into a raw response body.
///
/// `bodyRef` points to a sibling fixture JSON loaded verbatim; `body`
/// is the raw string used for malformed / wrong-shape payloads.
String? _resolveBody(Map<String, dynamic> server) {
  final bodyRef = server['bodyRef'];
  if (bodyRef is String && bodyRef.isNotEmpty) {
    return File('${_fixturesDir()}/$bodyRef').readAsStringSync();
  }
  final body = server['body'];
  if (body is String) return body;
  return null;
}

/// Map Dart's stringly-typed `FetchResult.error` onto the corpus's
/// normalised error-class vocabulary.
///
/// HTTP 403 and 404 both map to `invalidSdkKey` to match the corpus's
/// intent (per ConfigCat only 403/404 are invalid-SDK-key statuses; 401
/// is a generic retryable failure) even though `ConfigFetcher` does not
/// currently surface the distinction as a typed field — same pragmatic
/// choice as sdk-python. Tightening this in the SDK itself (typed enum +
/// 403/404-specific message) is tracked as a follow-up to #146.
String _dartErrorToClass(String? error) {
  if (error == null) return 'fetchFailed';
  if (error == 'MALFORMED_JSON') return 'parseFailed';
  if (error == 'HTTP 403' || error == 'HTTP 404') return 'invalidSdkKey';
  if (error.startsWith('HTTP ')) return 'fetchFailed';
  if (error == 'TIMEOUT' || error.contains('Timeout')) return 'timeout';
  return 'fetchFailed';
}

void main() {
  final corpusRaw = File(_wireCasesPath()).readAsStringSync();
  final corpus = jsonDecode(corpusRaw) as Map<String, dynamic>;
  final cases = (corpus['cases'] as List).cast<Map<String, dynamic>>();
  if (cases.isEmpty) {
    throw StateError('wire-cases.json MUST ship at least one case');
  }

  group('wire-cases (#148)', () {
    for (final c in cases) {
      final id = c['id'] as String;
      final given = (c['given'] as Map).cast<String, dynamic>();
      final server = (c['server'] as Map).cast<String, dynamic>();
      final expected = (c['expected'] as Map).cast<String, dynamic>();

      test(id, () async {
        final unknownGiven = given.keys.toSet().difference(_knownGiven);
        expect(unknownGiven, isEmpty,
            reason: "Case '$id': unknown given field(s) — no adapter");
        final unknownExpected =
            expected.keys.toSet().difference(_knownExpected);
        expect(unknownExpected, isEmpty,
            reason: "Case '$id': unknown expected field(s) — no adapter");

        final sdkKey = (given['sdkKey'] as String?) ?? _sdkKey;
        final baseUrl = (given['baseUrl'] as String?) ?? _defaultBaseUrl;

        final bodyText = _resolveBody(server);
        final behavior = (server['behavior'] as String?) ?? 'respond';

        // A plain "respond" case at the default base URL is served by a raw
        // loopback TCP responder through the SDK's REAL transport (the
        // default `http.Client` → dart:io): the request line is judged as
        // the bytes received, never a `Uri` the client could normalise or
        // re-encode (#803 brief item 4). A case with its own `baseUrl`
        // (a host loopback cannot answer for) or a non-respond behaviour
        // keeps the MockClient — and may not carry `requestPath`.
        final servedRaw = behavior == 'respond' && given['baseUrl'] == null;
        _RawWireServer? raw;
        http.Client? mock;
        var requestTimeout = _standardTimeout;
        http.BaseRequest? captured;
        if (servedRaw) {
          raw = await _RawWireServer.start(
            server['status'] as int,
            (server['headers'] as Map?)?.cast<String, dynamic>() ?? const {},
            bodyText,
          );
        } else {
          expect(expected.containsKey('requestPath'), isFalse,
              reason: "Case '$id': requestPath is judged on the wire only — "
                  'no raw-wire adapter for this case');
          (mock, requestTimeout) = _mockTransport(
            behavior,
            server,
            bodyText,
            (req) => captured = req,
          );
        }

        final fetcher = ConfigFetcher(
          sdkKey: sdkKey,
          version: '0.0.0-wire-test',
          logger: StderrLogger(level: LogLevel.off),
          baseUrl: raw?.baseUrl ?? baseUrl,
          requestTimeout: requestTimeout,
          httpClient: mock,
        );

        FetchResult result;
        try {
          result = await fetcher.fetch(given['previousEtag'] as String?);
        } finally {
          fetcher.close();
          await raw?.close();
        }

        // ---- Request-side assertions -------------------------------
        final sent =
            raw != null ? _sentOnWire(raw) : _sentThroughMock(captured);
        final requestTarget = sent.target;
        final requestUrl = sent.url;
        final ifNoneMatch = sent.ifNoneMatch;
        // URL shape: ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/
        // config_v6.json` (#803).
        expect(requestTarget, startsWith('/configuration-files/'));
        expect(requestTarget, endsWith('/config_v6.json'));
        final requestPath = expected['requestPath'];
        if (requestPath is String) {
          expect(requestTarget, equals(requestPath),
              reason: "Case '$id': request path ON THE WIRE");
        }
        final requestUrlPrefix = expected['requestUrlPrefix'];
        if (requestUrlPrefix is String) {
          expect(requestUrl, startsWith(requestUrlPrefix),
              reason: "Case '$id': request URL prefix");
        }

        if (expected.containsKey('requestHeaderIfNoneMatch')) {
          final expectedIfNoneMatch = expected['requestHeaderIfNoneMatch'];
          if (expectedIfNoneMatch == null) {
            expect(
              ifNoneMatch,
              isNull,
              reason: 'previousEtag=null MUST NOT send an If-None-Match',
            );
          } else {
            expect(ifNoneMatch, equals(expectedIfNoneMatch));
          }
        }

        // ---- Outcome assertions ------------------------------------
        final hasConfig = expected['hasConfig'];
        if (hasConfig is bool) {
          expect(result.body != null, equals(hasConfig),
              reason: "Case '$id': hasConfig");
        }
        final outcome = expected['outcome'] as String;
        switch (outcome) {
          case 'fetched':
            expect(
              result.status,
              equals(FetchStatus.fetched),
              reason: "Case '$id' expected 'fetched' but got "
                  '${result.status} (error=${result.error})',
            );
            expect(result.body, isNotNull);
            final resultingEtag = expected['resultingEtag'];
            if (resultingEtag is String) {
              expect(result.etag, equals(resultingEtag));
            }
          case 'notModified':
            expect(
              result.status,
              equals(FetchStatus.notModified),
              reason: "Case '$id' expected 'notModified' but got "
                  '${result.status} (error=${result.error})',
            );
            final resultingEtag = expected['resultingEtag'];
            if (resultingEtag is String) {
              expect(result.etag, equals(resultingEtag));
            }
          case 'failed':
            expect(
              result.status,
              equals(FetchStatus.failed),
              reason: "Case '$id' expected 'failed' but got "
                  '${result.status} (body=${result.body})',
            );
            final mapped = _dartErrorToClass(result.error);
            expect(
              mapped,
              equals(expected['errorClass']),
              reason: "Case '$id' expected errorClass="
                  "${expected['errorClass']} but mapped='$mapped' "
                  'from raw error=${result.error}',
            );
          default:
            fail("Unknown outcome value in corpus: '$outcome'");
        }
      });
    }
  });
}

/// The fetcher's request budget for every behaviour but "timeout".
const Duration _standardTimeout = Duration(seconds: 30);

/// Build the MockClient for a case that is not served raw, and the request
/// timeout it needs. [onRequest] receives each request the client sees.
///
/// `server.behavior` (#490) selects how the mock transport acts:
///   - "respond" (default / absent): deliver status + headers + body.
///   - "timeout": never complete within the SDK's request timeout → the
///     fetcher's `.timeout(...)` path → TimeoutException → the `timeout`
///     error class. Its deadline is short so the suite stays fast.
///   - "close-mid-response": deliver a 200 + start the body, then drop the
///     connection mid-read (the body stream errors) → the fetcher's
///     body-read failure → ClientException → `fetchFailed` (NOT
///     `parseFailed`: a truncated body is a transport failure, not a
///     JSON-shape error).
/// An unrecognised behaviour FAILS the case loudly (never falls through to
/// "respond").
(http.Client, Duration) _mockTransport(
  String behavior,
  Map<String, dynamic> server,
  String? bodyText,
  void Function(http.BaseRequest) onRequest,
) {
  final status = server['status'] as int;
  // `package:http` exposes response headers via a case-sensitive
  // lower-case lookup (`response.headers['etag']`). The corpus ships
  // canonical HTTP-style mixed case (`ETag`), so lower-case every header
  // before handing it to MockClient — anything else hides the ETag from
  // the fetcher.
  final headers = <String, String>{};
  final serverHeaders = server['headers'];
  if (serverHeaders is Map) {
    for (final entry in serverHeaders.entries) {
      headers[entry.key.toString().toLowerCase()] = entry.value.toString();
    }
  }

  switch (behavior) {
    case 'respond':
      return (
        MockClient((req) async {
          onRequest(req);
          return http.Response(bodyText ?? '', status, headers: headers);
        }),
        _standardTimeout,
      );
    case 'timeout':
      return (
        MockClient.streaming((req, _) async {
          onRequest(req);
          // Never complete: the fetcher's `.timeout(...)` cancels the
          // in-flight request and reports the timeout error class.
          return Completer<http.StreamedResponse>().future;
        }),
        const Duration(milliseconds: 100),
      );
    case 'close-mid-response':
      return (
        MockClient.streaming((req, _) async {
          onRequest(req);
          // Begin a 200 body, then error the stream mid-read: the partial
          // chunk lands, then the connection "drops". The fetcher's body
          // read (Response.fromStream → toBytes) sees the error and
          // rethrows as a ClientException → fetchFailed.
          final full = bodyText ?? '{"p":{"s":"partial';
          final cut = (full.length / 2).ceil().clamp(1, full.length);
          final partial = full.substring(0, cut);
          final stream = () async* {
            yield utf8.encode(partial);
            throw http.ClientException(
              'Connection closed mid-response',
              Uri.parse('https://cdn.test.confeature.io'),
            );
          }();
          return http.StreamedResponse(stream, status, headers: headers);
        }),
        _standardTimeout,
      );
    default:
      fail("wire-cases: unsupported server.behavior '$behavior' "
          '— no adapter');
  }
}

/// The request the fetcher sent, as the test transport observed it.
final class _SentRequest {
  const _SentRequest(this.target, this.url, this.ifNoneMatch);

  /// The path as SENT, still percent-encoded, with any query (the version
  /// carrier, #807) cut off.
  final String target;
  final String url;
  final String? ifNoneMatch;
}

/// The single request [raw] received, read from its bytes.
_SentRequest _sentOnWire(_RawWireServer raw) {
  // A socket error before the request head leaves `heads` empty; this
  // check names the cause the length check below cannot.
  expect(raw.errors, isEmpty,
      reason: 'raw test server: socket error(s) while serving the request');
  expect(raw.heads, hasLength(1),
      reason: 'Fetcher MUST issue exactly one HTTP request');
  final head = raw.heads.single;
  // The request target exactly as received: bytes between the first two
  // spaces of the request line, decoded byte-per-char (latin1) so a
  // non-ASCII byte on the wire can never compare equal to an ASCII
  // expectation.
  final requestLine = latin1.decode(head.requestLine);
  final parts = requestLine.split(' ');
  expect(parts, hasLength(3), reason: 'request line: $requestLine');
  expect(parts[0], equals('GET'));
  expect(parts[2], equals('HTTP/1.1'));
  final target = parts[1];
  final q = target.indexOf('?');
  return _SentRequest(
    q < 0 ? target : target.substring(0, q),
    '${raw.baseUrl}$target',
    head.header('if-none-match'),
  );
}

/// The request the MockClient captured.
_SentRequest _sentThroughMock(http.BaseRequest? captured) {
  expect(captured, isNotNull,
      reason: 'Fetcher MUST issue exactly one HTTP request');
  final req = captured!;
  return _SentRequest(
    req.url.path,
    req.url.toString(),
    req.headers['If-None-Match'],
  );
}

/// One request head as received: the raw bytes up to (not including) the
/// blank line that ends it.
class _RawHead {
  _RawHead(this.bytes);

  final List<int> bytes;

  /// The request line's bytes, up to the first CRLF.
  List<int> get requestLine {
    for (var i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] == 0x0D && bytes[i + 1] == 0x0A) return bytes.sublist(0, i);
    }
    return bytes;
  }

  /// The value of header [name] (case-insensitive), or `null`.
  String? header(String name) {
    final lines = latin1.decode(bytes).split('\r\n').skip(1);
    for (final line in lines) {
      final colon = line.indexOf(':');
      if (colon <= 0) continue;
      if (line.substring(0, colon).trim().toLowerCase() == name) {
        return line.substring(colon + 1).trim();
      }
    }
    return null;
  }
}

/// A raw HTTP/1.1 responder on a loopback TCP socket. It records each
/// request head BYTE FOR BYTE as received — nothing parses or decodes the
/// request target — and answers with the case's status, headers and body,
/// then closes the connection.
class _RawWireServer {
  _RawWireServer._(this._socket, this._status, this._headers, this._body) {
    _socket.listen(_serve, onError: (Object e) => errors.add(e));
  }

  static Future<_RawWireServer> start(
    int status,
    Map<String, dynamic> headers,
    String? body,
  ) async {
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    return _RawWireServer._(socket, status, headers, body);
  }

  final ServerSocket _socket;
  final int _status;
  final Map<String, dynamic> _headers;
  final String? _body;
  final List<_RawHead> heads = [];

  /// Every error the listening or a client socket raised, kept so a
  /// failure names its cause instead of only a missing request.
  final List<Object> errors = [];

  String get baseUrl => 'http://127.0.0.1:${_socket.port}';

  void _serve(Socket client) {
    final buffer = <int>[];
    var answered = false;
    client.listen(
      (chunk) {
        if (answered) return;
        buffer.addAll(chunk);
        final end = _endOfHead(buffer);
        if (end < 0) return;
        answered = true;
        heads.add(_RawHead(buffer.sublist(0, end)));
        _respond(client);
      },
      onError: (Object e) {
        errors.add(e);
        client.destroy();
      },
      cancelOnError: true,
    );
  }

  Future<void> _respond(Socket client) async {
    final noBody = _status == 304 || _status == 204;
    final body = noBody ? const <int>[] : utf8.encode(_body ?? '');
    final head = StringBuffer('HTTP/1.1 $_status Wire\r\n');
    _headers.forEach((name, value) => head.write('$name: $value\r\n'));
    if (!noBody) head.write('Content-Length: ${body.length}\r\n');
    head.write('Connection: close\r\n\r\n');
    client
      ..add(utf8.encode(head.toString()))
      ..add(body);
    await client.flush();
    await client.close();
  }

  /// Index of the CRLFCRLF ending the request head, or -1.
  static int _endOfHead(List<int> b) {
    for (var i = 0; i + 3 < b.length; i++) {
      if (b[i] == 0x0D &&
          b[i + 1] == 0x0A &&
          b[i + 2] == 0x0D &&
          b[i + 3] == 0x0A) {
        return i;
      }
    }
    return -1;
  }

  Future<void> close() => _socket.close();
}
