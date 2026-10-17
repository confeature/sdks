// SPDX-License-Identifier: MIT

/// sdk-dart live wire-cases (#923, after sdk-go's #921).
///
/// sdk-dart's own `ConfigFetcher` — built the way `ConfeatureClient` builds
/// it, with its own `http.Client` and version string — against a RUNNING
/// live-contract harness serving the reference origin of the CDN read
/// path. Every seeded wire-case is replayed and judged by
/// `expectWireCase`, the SAME rules the hermetic suite
/// (`wire_cases_test.dart`) applies. Nothing is hand-built and no admin
/// write is made:
///
///   - the case set comes from the running harness (`GET /admin/state` →
///     `keys`), never recomputed from the corpus — `http-403` among them,
///     an unseeded key answered by the Worker itself;
///   - the request each case sent is read back from the harness
///     (`GET /admin/requests?sdkKey=`), and each fetch must add exactly
///     one entry;
///   - a timeout case is ended by the SDK's OWN deadline (a quarter of the
///     harness's hold).
///
/// Run it through the harness wrapper (the manifest's `liveSuite.runner`).
/// GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
/// hermetic `dart test`. When it is set without `LIVE_HARNESS_URL`, or the
/// harness does not answer, the suite FAILS; it never skips.
library;

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:test/test.dart';

// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/config_fetcher.dart';
import 'package:confeature/confeature.dart';

import 'wire_case_assertions.dart';

/// A key the harness never seeds.
const String _neverSeededKey = 'never-seeded-923';

const Duration _defaultDeadline = Duration(seconds: 10);

Future<void> main() async {
  if (Platform.environment['CONFEATURE_LIVE'] != '1') {
    test('wire-cases live (#923)', () {},
        skip: 'hermetic run: CONFEATURE_LIVE is not set');
    return;
  }
  final base = (Platform.environment['LIVE_HARNESS_URL'] ?? '')
      .replaceFirst(RegExp(r'/+$'), '');
  if (base.isEmpty) {
    test('wire-cases live (#923)', () {
      fail('CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through '
          '`live-contract-harness --corpus-seed --exec -- …`; a live suite '
          'must never pass by skipping');
    });
    return;
  }

  final harness = _Harness(base);
  final state = await harness.getJson('/admin/state');
  final keys = (state['keys'] as List).cast<String>().toList()..sort();
  final faults = (state['faults'] as Map?)?.cast<String, dynamic>() ?? {};
  final corpus = {for (final c in loadWireCases()) c['id'] as String: c};
  tearDownAll(harness.close);

  group('wire-cases live (#923)', () {
    test('seeded-set', () {
      expect(keys, isNotEmpty,
          reason: 'the harness reports no seeded case — an empty run '
              'checks nothing');
      expect(keys.where((k) => !corpus.containsKey(k)), isEmpty,
          reason: 'every seeded key is a corpus case');
    });

    for (final id in keys) {
      final c = corpus[id];
      if (c == null) continue; // reported by seeded-set
      test(id, () async {
        final hold = _holdFor(c, faults[id]);
        final deadline = hold > Duration.zero ? hold ~/ 4 : _defaultDeadline;
        // The harness seeds each case under its id; a case that pins
        // given.sdkKey is configured with that key instead (#803 FR-003).
        final sdkKey = sdkKeyFor(c, id);
        final loggedBefore = (await harness.requestsFor(sdkKey)).length;

        final fetcher = _newFetcher(base, sdkKey, deadline);
        final previousEtag =
            (c['given'] as Map).cast<String, dynamic>()['previousEtag'];
        final stopwatch = Stopwatch()..start();
        final FetchResult result;
        try {
          result = await fetcher.fetch(previousEtag as String?);
        } finally {
          stopwatch.stop();
          fetcher.close();
        }

        final log = await harness.requestsFor(sdkKey);
        // Exactly one request per fetch: a retrying SDK, or a request
        // logged by an earlier run, must not stand in for the one under
        // test.
        expect(log.length - loggedBefore, equals(1),
            reason: 'one fetch sends exactly one request');
        if (hold > Duration.zero) {
          expect(stopwatch.elapsed, lessThan(hold),
              reason: "the SDK's own deadline ends the fetch, not the "
                  'harness releasing it');
        }
        final last = log.last;
        final target = last['url'] as String;
        final q = target.indexOf('?');
        expectWireCase(
          c,
          sdkKey,
          SentRequest(
            q < 0 ? target : target.substring(0, q),
            target,
            last['ifNoneMatch'] as String?,
          ),
          result,
        );
      });
    }

    // US4: no seed, no fault — the CDN's own unknown-key answer,
    // ConfigCat's 403 since #785, classed like a 404 as invalidSdkKey.
    test('unseeded-key', () async {
      final fetcher = _newFetcher(base, _neverSeededKey, _defaultDeadline);
      final FetchResult result;
      try {
        result = await fetcher.fetch();
      } finally {
        fetcher.close();
      }
      expect(result.status, equals(FetchStatus.failed));
      expect(dartErrorToClass(result.error), equals('invalidSdkKey'),
          reason: 'raw=${result.error}');
    });
  });
}

/// The fetcher as `ConfeatureClient` builds it: no customer client (it owns
/// a default `http.Client`), the SDK's own version, and [deadline] as its
/// request timeout.
ConfigFetcher _newFetcher(String base, String sdkKey, Duration deadline) =>
    ConfigFetcher(
      sdkKey: sdkKey,
      version: sdkVersion,
      logger: StderrLogger(level: LogLevel.off),
      baseUrl: base,
      requestTimeout: deadline,
    );

/// The harness's hold for a timeout case — the SDK's deadline is derived
/// from it (#783 A8) — or zero for any other behaviour.
Duration _holdFor(Map<String, dynamic> c, Object? fault) {
  if ((c['server'] as Map)['behavior'] != 'timeout') return Duration.zero;
  final ms = fault is Map ? fault['ms'] : null;
  if (ms is! int || ms <= 0) {
    fail("${c['id']} is seeded without a timeout fault");
  }
  return Duration(milliseconds: ms);
}

/// The running harness's admin routes.
final class _Harness {
  _Harness(this._base);

  final String _base;
  final http.Client _client = http.Client();

  /// GETs an admin route and decodes its JSON object; a non-200 throws.
  Future<Map<String, dynamic>> getJson(
    String path, [
    Map<String, String>? query,
  ]) async {
    final uri = Uri.parse('$_base$path').replace(queryParameters: query);
    final response =
        await _client.get(uri).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw StateError(
          'harness $path answered ${response.statusCode}: ${response.body}');
    }
    return (jsonDecode(response.body) as Map).cast<String, dynamic>();
  }

  /// The requests the harness logged for [sdkKey], oldest first.
  Future<List<Map<String, dynamic>>> requestsFor(String sdkKey) async {
    final body = await getJson('/admin/requests', {'sdkKey': sdkKey});
    expect(body['ok'], isTrue,
        reason: 'harness refused /admin/requests: ${body['error']}');
    return (body['requests'] as List)
        .map((r) => (r as Map).cast<String, dynamic>())
        .toList();
  }

  void close() => _client.close();
}
