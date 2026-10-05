// SPDX-License-Identifier: MIT

/// HTTP layer for fetching `config_v6.json` from a Confeature CDN.
///
/// Wraps `package:http`'s `Client` with:
///   - User-Agent: `confeature-dart-sdk/{sdkVersion}` (FR-012).
///   - If-None-Match support for 304 reuse (FR-011).
///   - Configurable request timeout (FR-008).
///   - SDK key redaction in every log line (FR-013): the raw key is
///     NEVER interpolated into messages; `redactSdkKey` is the only
///     path.
///
/// The request URL is ConfigCat's
/// `<baseUrl>/configuration-files/<sdkKey>/config_v6.json` — the key
/// travels in the path, as `configcat_client` sends it
/// (`lib/src/fetch/config_fetcher.dart`, `_doFetch`:
/// `'$_url/configuration-files/$_sdkKey/$configJsonName'`). Because the
/// URL holds the key, no library exception text (which may quote the
/// URL or a redirect's Location) is ever logged or returned: every
/// failure is reduced to a FIXED reason code (#803 FR-002).
///
/// `FetchResult.status` is one of:
///   - "fetched": HTTP 200, fresh body + new ETag.
///   - "not_modified": HTTP 304, caller keeps its cached body.
///   - "failed": network error / non-2xx / timeout / unusable key or
///     base URL. `error` carries a fixed reason code with NO SDK key:
///     `TIMEOUT`, `NETWORK_ERROR`, `FETCH_EXCEPTION`, `MALFORMED_JSON`,
///     `INVALID_SDK_KEY`, `INVALID_REQUEST` or `HTTP <status>`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:meta/meta.dart';

import '../logger.dart';
import 'sdk_key.dart';

/// Outcome status of a fetch attempt.
enum FetchStatus {
  /// HTTP 200 — fresh body + new ETag.
  fetched,

  /// HTTP 304 — caller keeps its cached body.
  notModified,

  /// Network error / non-2xx / timeout — caller keeps existing state.
  failed,
}

/// Outcome of a [ConfigFetcher.fetch] call.
@immutable
class FetchResult {
  /// Construct a fetch result.
  const FetchResult({
    required this.status,
    this.body,
    this.etag,
    this.error,
  });

  /// Convenience: fetched result with body + etag.
  const FetchResult.fetched(Map<String, dynamic> body, String? etag)
      : this(status: FetchStatus.fetched, body: body, etag: etag);

  /// Convenience: not-modified result with optional etag.
  const FetchResult.notModified(String? etag)
      : this(status: FetchStatus.notModified, etag: etag);

  /// Convenience: failed result with a reason string (no SDK key).
  const FetchResult.failed(String reason)
      : this(status: FetchStatus.failed, error: reason);

  /// Status of the fetch attempt.
  final FetchStatus status;

  /// Parsed JSON body on success — `null` otherwise.
  final Map<String, dynamic>? body;

  /// `ETag` header from the response, when present.
  final String? etag;

  /// Short error code (no SDK key) on failure.
  final String? error;
}

/// HTTP-backed config fetcher. Holds a single `package:http` client so
/// connection pooling works across repeated fetches.
class ConfigFetcher {
  /// Construct a fetcher.
  ConfigFetcher({
    required String sdkKey,
    required String version,
    required this.logger,
    String? baseUrl,
    this.requestTimeout = const Duration(seconds: 30),
    http.Client? httpClient,
  })  : _sdkKey = sdkKey,
        _baseUrl = (baseUrl ?? defaultBaseUrl).replaceFirst(RegExp(r'/+$'), ''),
        _userAgent = 'confeature-dart-sdk/$version',
        _httpClient = httpClient ?? http.Client();

  /// Production CDN base URL. Customers override via the client option.
  static const String defaultBaseUrl = 'https://cdn-global.confeature.io';

  /// Per-request HTTP timeout.
  final Duration requestTimeout;

  /// The logger to which non-success fetch outcomes are emitted.
  final Logger logger;

  final String _sdkKey;
  final String _baseUrl;
  final String _userAgent;
  final http.Client _httpClient;

  /// The full CDN URL targeted by every fetch call, or `null` when the
  /// key cannot be a URL path segment and the fetcher refuses to fetch.
  String? get url => buildConfigUrl(_baseUrl, _sdkKey);

  /// Build ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`
  /// — the ONE place the config URL is built (#803 FR-001), so the version
  /// carrier (#807) lands here only.
  ///
  ///   - A well-shaped key ([isValidConfeatureKeyFormat]) travels RAW: its
  ///     `/`-separated parts each [pathEscape]d (a no-op for a valid key),
  ///     exactly `configcat_client`'s bytes. A ConfigCat-shaped key is
  ///     three segments.
  ///   - Any other key is [pathEscape]d into ONE segment (the runtime is
  ///     lenient), so a `/`, `?`, `#` or `%` in it cannot leave its segment.
  ///   - `""`, `.` and `..` cannot be one segment — `Uri` would resolve a
  ///     dot segment away (`/configuration-files/../config_v6.json` becomes
  ///     `/config_v6.json`) — and a key holding a lone UTF-16 surrogate has
  ///     no UTF-8 bytes to escape; for those this returns `null` and the
  ///     fetcher MUST NOT request anything.
  @visibleForTesting
  static String? buildConfigUrl(String baseUrl, String sdkKey) {
    final String? keyPath;
    if (isValidConfeatureKeyFormat(sdkKey)) {
      keyPath = sdkKey.split('/').map(pathEscape).join('/');
    } else {
      if (sdkKey.isEmpty || sdkKey == '.' || sdkKey == '..') return null;
      keyPath = pathEscape(sdkKey);
    }
    if (keyPath == null) return null;
    return '$baseUrl/configuration-files/$keyPath/config_v6.json';
  }

  /// Go's `url.PathEscape`, byte for byte (#803 FR-001): every UTF-8 byte
  /// of [segment] is `%XX` (uppercase hex) except `A-Z a-z 0-9`, the
  /// unreserved marks `- _ . ~` and the sub-delims `$ & + : = @`.
  ///
  /// This is NOT `Uri.encodeComponent`, which keeps `! * ' ( )` and
  /// escapes `$ & + : = @`. Returns `null` when [segment] holds a lone
  /// UTF-16 surrogate: it has no UTF-8 form, so it cannot be escaped
  /// faithfully (`utf8.encode` would silently substitute U+FFFD).
  @visibleForTesting
  static String? pathEscape(String segment) {
    for (final rune in segment.runes) {
      if (rune >= 0xD800 && rune <= 0xDFFF) return null;
    }
    const hex = '0123456789ABCDEF';
    final out = StringBuffer();
    for (final byte in utf8.encode(segment)) {
      if (_keptByPathEscape(byte)) {
        out.writeCharCode(byte);
      } else {
        out
          ..write('%')
          ..write(hex[byte >> 4])
          ..write(hex[byte & 0x0F]);
      }
    }
    return out.toString();
  }

  /// Go `shouldEscape(c, encodePathSegment) == false`.
  static bool _keptByPathEscape(int c) {
    if (c >= 0x41 && c <= 0x5A) return true; // A-Z
    if (c >= 0x61 && c <= 0x7A) return true; // a-z
    if (c >= 0x30 && c <= 0x39) return true; // 0-9
    switch (c) {
      case 0x2D: // -
      case 0x5F: // _
      case 0x2E: // .
      case 0x7E: // ~
      case 0x24: // $
      case 0x26: // &
      case 0x2B: // +
      case 0x3A: // :
      case 0x3D: // =
      case 0x40: // @
        return true;
    }
    return false;
  }

  /// Parse [target] into an `http`/`https` URI with a host and neither a
  /// query nor a fragment, or `null`.
  ///
  /// `Uri.parse` throws a `FormatException` that QUOTES its input — the
  /// keyed URL — so only the non-throwing `Uri.tryParse` is used, and an
  /// unusable base URL is reduced to the fixed code `INVALID_REQUEST`.
  ///
  /// The key path built by [buildConfigUrl] never holds a raw `?` or `#`
  /// (a well-shaped key has none; [pathEscape] escapes them), so a query
  /// or fragment in [target] can only come from a base URL holding `?` or
  /// `#` — which would move the key out of the path, into the query
  /// string (sent, and logged by proxies as a parameter) or the fragment
  /// (never sent). Such a base is refused: no request.
  static Uri? _parseTarget(String target) {
    final uri = Uri.tryParse(target);
    if (uri == null) return null;
    if (!uri.isScheme('http') && !uri.isScheme('https')) return null;
    if (uri.host.isEmpty) return null;
    if (uri.hasQuery || uri.hasFragment) return null;
    return uri;
  }

  Map<String, String> _buildHeaders(String? etag) {
    final headers = <String, String>{
      'User-Agent': _userAgent,
      'Accept': 'application/json',
    };
    if (etag != null && etag.isNotEmpty) {
      headers['If-None-Match'] = etag;
    }
    return headers;
  }

  /// Fetch the config. Never throws — fail-closed.
  Future<FetchResult> fetch([String? etag]) async {
    final target = url;
    if (target == null) {
      logger.error(
        'ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path '
        'segment; not fetching (sdkKey=${redactSdkKey(_sdkKey)})',
      );
      return const FetchResult.failed('INVALID_SDK_KEY');
    }
    final uri = _parseTarget(target);
    if (uri == null) {
      logger.error(
        'ConfigFetcher: INVALID_REQUEST — the base URL is not an absolute '
        'http(s) URL without a query or fragment; not fetching '
        '(sdkKey=${redactSdkKey(_sdkKey)})',
      );
      return const FetchResult.failed('INVALID_REQUEST');
    }
    try {
      final response = await _httpClient
          .get(uri, headers: _buildHeaders(etag))
          .timeout(requestTimeout);
      return _parse(response);
      // ignore: avoid_catches_without_on_clauses — fail-closed guard.
    } catch (exc) {
      return _handleException(_classifyError(exc));
    }
  }

  /// Reduce a transport / body-read error to a FIXED, key-free reason
  /// code (#803 FR-002, Go's `classifyError` pattern).
  ///
  /// SECURITY: the request URL carries the SDK key, and `package:http` /
  /// `dart:io` quote URLs in their errors (`ClientException.uri`, a
  /// redirect's Location). No error text is ever passed on: only the
  /// error's type picks the code.
  static String _classifyError(Object exc) {
    if (exc is TimeoutException) return 'TIMEOUT';
    if (exc is http.ClientException) return 'NETWORK_ERROR';
    return 'FETCH_EXCEPTION';
  }

  /// Close the underlying HTTP client. Idempotent — multiple calls are
  /// safe.
  void close() {
    try {
      _httpClient.close();
    } on Exception catch (_) {
      logger.warning(
        'ConfigFetcher.close: failed to close http client '
        '(sdkKey=${redactSdkKey(_sdkKey)})',
      );
    }
  }

  FetchResult _parse(http.Response response) {
    if (response.statusCode == 304) {
      return FetchResult.notModified(response.headers['etag']);
    }
    if (response.statusCode != 200) {
      final reason = 'HTTP ${response.statusCode}';
      logger.error(
        'ConfigFetcher: fetch failed for sdkKey=${redactSdkKey(_sdkKey)} '
        'reason=$reason',
      );
      return FetchResult.failed(reason);
    }
    Object? decoded;
    try {
      decoded = jsonDecode(response.body);
    } on FormatException catch (_) {
      // The parser's message quotes the body — never passed on.
      logger.error(
        'ConfigFetcher: fetch returned non-JSON body for '
        'sdkKey=${redactSdkKey(_sdkKey)} reason=MALFORMED_JSON',
      );
      return const FetchResult.failed('MALFORMED_JSON');
    }
    if (decoded is! Map) {
      logger.error(
        'ConfigFetcher: fetch returned non-object JSON for '
        'sdkKey=${redactSdkKey(_sdkKey)}',
      );
      return const FetchResult.failed('MALFORMED_JSON');
    }
    // Shape validation: a valid `config_v6.json` carries the `{p, f, s}`
    // top-level shape. sdk-node / sdk-python tightened the same check —
    // this brings sdk-dart to parity so the corpus-wide
    // `wire-cases.json::wrong-shape-200` case surfaces the same
    // `parseFailed` everywhere. A 200 with a body that doesn't match the
    // contract is a stronger signal of CDN drift than a 5xx and deserves
    // its own typed error class.
    if (!decoded.containsKey('f')) {
      logger.error(
        "ConfigFetcher: fetch returned JSON without 'f' key for "
        'sdkKey=${redactSdkKey(_sdkKey)}',
      );
      return const FetchResult.failed('MALFORMED_JSON');
    }
    return FetchResult.fetched(
      Map<String, dynamic>.from(decoded),
      response.headers['etag'],
    );
  }

  FetchResult _handleException(String reason) {
    // The SDK key MUST NEVER appear in the message — strip-and-redact.
    logger.error(
      'ConfigFetcher: fetch raised for sdkKey=${redactSdkKey(_sdkKey)} '
      'reason=$reason',
    );
    return FetchResult.failed(reason);
  }
}
