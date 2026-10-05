// SPDX-License-Identifier: MIT

/// SDK-key format helpers + cache-key derivation.
///
/// SECURITY (constitution security clause + spec 037 FR-008): SDK keys
/// are secrets. They MUST NEVER appear verbatim in any log line. Every
/// log site that needs to reference a key passes it through
/// [redactSdkKey] first.
///
/// The cache-key algorithm mirrors
/// `packages/sdk-shared/src/sdk-key.ts`'s async `deriveCacheKey`
/// (SHA-256 → base64url → first 32 chars). Cross-language fixture
/// verification lives in `test/cache_key_fixtures_test.dart`.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Confeature SDK key formats — both are valid (#802):
///
///   * `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` — minted
///     today, ConfigCat's own shape, so a stock ConfigCat SDK accepts the
///     key too;
///   * `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>` — minted
///     before #802, still served until the key is rotated.
///
/// Validation is lenient at runtime (per FR-009 of sdk-node spec 030):
/// malformed keys log `INVALID_SDK_KEY` (redacted) and continue. Mirrors
/// `CONFEATURE_SDK_KEY_PATTERN` in `packages/sdk-shared/src/sdk-key.ts`;
/// the accept/reject cases every SDK tests against live in
/// `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
final RegExp _confeatureSdkKeyPattern = RegExp(
  r'^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}'
  r'|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$',
);

/// Envelope prefix for derived cache keys. Identical across every
/// Confeature SDK; mirrors the TS implementation's constant.
const String cacheKeyPrefix = 'confeature:cache:v1:';

/// Return `true` iff [sdkKey] matches either Confeature SDK-key format
/// (`configcat-sdk-1/<22>/<22>` or the legacy
/// `confeature-sdk-1-<32>-<32>`).
///
/// A `false` result does NOT cause the SDK to throw; it triggers an
/// `INVALID_SDK_KEY` log line (which, per the security clause, includes
/// only the redacted form).
bool isValidConfeatureKeyFormat(String sdkKey) =>
    _confeatureSdkKeyPattern.hasMatch(sdkKey);

/// Return a privacy-preserving rendering of [sdkKey] for logs.
///
/// Strategy: keep ~10% of the key visible at each end (minimum 4 chars),
/// mask the middle. For short / unusual keys (< 16 chars) and the empty
/// string, fall back to a full mask. NEVER returns the raw key.
///
/// A `/` in the key (the `configcat-sdk-1/<22>/<22>` shape) is treated
/// as a plain character. For that 61-char shape the head is all prefix
/// (`config`) and only 6 secret characters survive in the tail — fewer
/// than the 8 of the 82-char legacy shape.
///
/// Mirrors `redactSdkKey` from `packages/sdk-shared/src/sdk-key.ts`.
String redactSdkKey(String? sdkKey) {
  if (sdkKey == null || sdkKey.isEmpty) return '[redacted]';
  if (sdkKey.length < 16) return '[redacted]';
  final visible = (sdkKey.length * 0.1).floor();
  final keep = visible < 4 ? 4 : visible;
  final head = sdkKey.substring(0, keep);
  final tail = sdkKey.substring(sdkKey.length - keep);
  return '$head…[redacted]…$tail';
}

/// Derive a stable, opaque cache key from an [sdkKey].
///
/// Format: `confeature:cache:v1:<base64url(sha256(sdkKey)).slice(0, 32)>`.
///
/// Output is byte-identical to the TS workspace's async
/// `deriveCacheKey` (which uses Web Crypto's `subtle.digest("SHA-256")`).
/// The cross-language fixture at
/// `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
/// pins ≥ 5 (sdkKey, expectedCacheKey) pairs and the Dart unit test
/// asserts string equality for every entry.
///
/// SECURITY: the SDK key is HASHED, never stored raw. Even an attacker
/// with filesystem access to the cache directory cannot read the SDK
/// key from a written cache file's name.
String deriveCacheKey(String sdkKey) {
  final digest = sha256.convert(utf8.encode(sdkKey)).bytes;
  // base64Url.encode emits `-`/`_` instead of `+`/`/`. The TS counterpart
  // strips the `=` padding via `.replace(/=+$/, "")` and then truncates
  // to 32 chars; we do the same here.
  final b64 = base64Url.encode(digest).replaceAll('=', '');
  return '$cacheKeyPrefix${b64.substring(0, 32)}';
}
