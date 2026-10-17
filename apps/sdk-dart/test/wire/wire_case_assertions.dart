// SPDX-License-Identifier: MIT

/// What a `wire-cases.json` case means for sdk-dart — ONE implementation,
/// shared by the hermetic suite (`wire_cases_test.dart`, a raw loopback
/// responder or a MockClient) AND the live suite
/// (`wire_cases_live_test.dart`, real HTTP against the live-contract
/// harness, #923), so both are judged by the same rules. The request is
/// passed in SDK-neutral form ([SentRequest]): the hermetic suite reads it
/// from the bytes or the captured request, the live suite from the
/// harness's `GET /admin/requests`.
///
/// Mirrors sdk-go's `wire_case_assertions_test.go` (#921) and sdk-java's
/// `WireCaseAssertions` (#922). Not a `_test.dart` file: `dart test` runs
/// it only through the two suites that import it.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/config_fetcher.dart';
import 'package:confeature/confeature.dart';

import '../workspace_root.dart';

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

/// The directory holding `wire-cases.json` and its body fixtures.
String wireFixturesDir() =>
    '${findWorkspaceRoot()}/packages/test-fixtures-sdk-parity/fixtures';

/// The corpus's cases, in file order. Throws when it carries none.
List<Map<String, dynamic>> loadWireCases() {
  final raw = File('${wireFixturesDir()}/wire-cases.json').readAsStringSync();
  final corpus = jsonDecode(raw) as Map<String, dynamic>;
  final cases = (corpus['cases'] as List).cast<Map<String, dynamic>>();
  if (cases.isEmpty) {
    throw StateError('wire-cases.json MUST ship at least one case');
  }
  return cases;
}

/// The request the fetcher sent, as the suite observed it.
final class SentRequest {
  /// A request with its [path], full [target] and [ifNoneMatch] header.
  const SentRequest(this.path, this.target, this.ifNoneMatch);

  /// The path as SENT, still percent-encoded, with any query (the version
  /// carrier, #807) cut off.
  final String path;

  /// The request target as sent, query included.
  final String target;

  /// The If-None-Match header's value, or `null` when it was not sent.
  final String? ifNoneMatch;
}

/// The key a suite configures its fetcher with: the corpus's
/// `given.sdkKey` when the case pins one, else the suite's own default
/// (the live suite's default is the case id, the key the harness seeds).
String sdkKeyFor(Map<String, dynamic> c, String defaultKey) =>
    (_given(c)['sdkKey'] as String?) ?? defaultKey;

/// Fails on any `given` or `expected` field this consumer does not read
/// (#803 FR-003).
void expectOnlyKnownFields(Map<String, dynamic> c) {
  final id = c['id'];
  expect(_given(c).keys.toSet().difference(_knownGiven), isEmpty,
      reason: "Case '$id': unknown given field(s) — no adapter");
  expect(_expected(c).keys.toSet().difference(_knownExpected), isEmpty,
      reason: "Case '$id': unknown expected field(s) — no adapter");
}

/// Judges one fetch of case [c] — the request it [sent] and the [result]
/// it returned — by the corpus's expectations.
void expectWireCase(
  Map<String, dynamic> c,
  String sdkKey,
  SentRequest sent,
  FetchResult result,
) {
  expectOnlyKnownFields(c);
  _expectRequest(c, sdkKey, sent);
  _expectOutcome(c, result);
}

/// Map Dart's stringly-typed `FetchResult.error` onto the corpus's
/// normalised error-class vocabulary.
///
/// The fetcher emits FIXED reason codes only (#803 FR-002): `MALFORMED_JSON`,
/// `HTTP <status>`, `INVALID_SDK_KEY`, `INVALID_REQUEST`, `TIMEOUT`,
/// `NETWORK_ERROR` and `FETCH_EXCEPTION`. HTTP 403 and 404 both map to
/// `invalidSdkKey` (per ConfigCat only 403/404 are invalid-SDK-key statuses;
/// 401 is a generic retryable failure).
///
/// A missing reason or one outside that list maps to `unmapped:<reason>`,
/// which matches no corpus class — so it FAILS, like sdk-go's
/// `goErrorToClass`. Folding the unknown into `fetchFailed` would let any
/// unexpected failure pass every `fetchFailed` case.
String dartErrorToClass(String? error) {
  switch (error) {
    case null:
      return 'unmapped:<none>';
    case 'MALFORMED_JSON':
      return 'parseFailed';
    case 'HTTP 403' || 'HTTP 404' || 'INVALID_SDK_KEY':
      return 'invalidSdkKey';
    case 'TIMEOUT':
      return 'timeout';
    case 'NETWORK_ERROR' || 'FETCH_EXCEPTION' || 'INVALID_REQUEST':
      return 'fetchFailed';
  }
  return error.startsWith('HTTP ') ? 'fetchFailed' : 'unmapped:$error';
}

/// The request side: the exact path as sent (compared byte for byte), no
/// legacy `/v2/` prefix, a custom base leading the URL, and the
/// If-None-Match round-trip.
void _expectRequest(Map<String, dynamic> c, String sdkKey, SentRequest sent) {
  final id = c['id'];
  final given = _given(c);
  final expected = _expected(c);

  // URL shape (#803 FR-001): ConfigCat's `<baseUrl>/configuration-files/
  // <sdkKey>/config_v6.json`, the key's exact bytes.
  final wantedPath = (expected['requestPath'] as String?) ??
      '/configuration-files/$sdkKey/config_v6.json';
  expect(sent.path, equals(wantedPath),
      reason: "Case '$id': request path ON THE WIRE");
  expect(sent.target, isNot(contains('/v2/')),
      reason: "Case '$id': the legacy /v2/ prefix is gone (#803)");

  // A custom base must lead the request URL (custom-base-url). Checked on
  // the fetcher's `url` — the one place the URL `fetch` GETs is built — so
  // the check holds whatever host the suite really talks to.
  final baseUrl = given['baseUrl'] as String?;
  final prefix = expected['requestUrlPrefix'] as String?;
  expect(baseUrl == null, equals(prefix == null),
      reason: 'given.baseUrl and expected.requestUrlPrefix come together');
  if (baseUrl != null) {
    final custom = ConfigFetcher(
      sdkKey: sdkKey,
      version: '0.0.0-wire-test',
      logger: StderrLogger(level: LogLevel.off),
      baseUrl: baseUrl,
    );
    try {
      expect(custom.url, startsWith(prefix!),
          reason: "Case '$id': request URL prefix");
    } finally {
      custom.close();
    }
  }

  // If-None-Match three-state semantics: absent (don't assert), explicit
  // null (header MUST NOT be sent), explicit string (header MUST equal).
  if (expected.containsKey('requestHeaderIfNoneMatch')) {
    final wanted = expected['requestHeaderIfNoneMatch'];
    if (wanted == null) {
      expect(sent.ifNoneMatch, isNull,
          reason: 'previousEtag=null MUST NOT send an If-None-Match');
    } else {
      expect(sent.ifNoneMatch, equals(wanted));
    }
  }
}

/// Maps the fetcher's status and reason code onto the corpus's
/// `{fetched, notModified, failed}` × errorClass vocabulary, and checks
/// `hasConfig`.
void _expectOutcome(Map<String, dynamic> c, FetchResult result) {
  final id = c['id'];
  final expected = _expected(c);
  final hasConfig = expected['hasConfig'];
  if (hasConfig is bool) {
    expect(result.body != null, equals(hasConfig),
        reason: "Case '$id': hasConfig");
  }
  final resultingEtag = expected['resultingEtag'];
  final outcome = expected['outcome'] as String;
  switch (outcome) {
    case 'fetched':
      expect(result.status, equals(FetchStatus.fetched),
          reason: "Case '$id' expected 'fetched' but got "
              '${result.status} (error=${result.error})');
      expect(result.body, isNotNull);
      if (resultingEtag is String) expect(result.etag, equals(resultingEtag));
    case 'notModified':
      expect(result.status, equals(FetchStatus.notModified),
          reason: "Case '$id' expected 'notModified' but got "
              '${result.status} (error=${result.error})');
      expect(result.body, isNull,
          reason: 'Body must be unset on notModified outcome');
      if (resultingEtag is String) expect(result.etag, equals(resultingEtag));
    case 'failed':
      expect(result.status, equals(FetchStatus.failed),
          reason: "Case '$id' expected 'failed' but got "
              '${result.status} (body=${result.body})');
      final mapped = dartErrorToClass(result.error);
      expect(mapped, equals(expected['errorClass']),
          reason: "Case '$id' expected errorClass="
              "${expected['errorClass']} but mapped='$mapped' "
              'from raw error=${result.error}');
    default:
      fail("Unknown outcome value in corpus: '$outcome'");
  }
}

Map<String, dynamic> _given(Map<String, dynamic> c) =>
    (c['given'] as Map).cast<String, dynamic>();

Map<String, dynamic> _expected(Map<String, dynamic> c) =>
    (c['expected'] as Map).cast<String, dynamic>();
