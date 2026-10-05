// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_SDK_KEY_H_
#define CONFEATURE_INTERNAL_SDK_KEY_H_

// SDK-key helpers: format validation, redaction, cache-key derivation.
//
// SECURITY (FR-013): SDK keys are secrets. Every log site that needs
// to reference a key passes it through `redactSdkKey` first.
//
// The cache-key algorithm mirrors the canonical TS implementation at
// `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey` and the ports in
// Python / Go / .NET / Rust. Cross-language fixture verification lives
// in `tests/cache_key_fixtures_test.cpp`.

#include <string>
#include <string_view>

namespace confeature::internal {

inline constexpr auto kCacheKeyPrefix = "confeature:cache:v1:";

// Reports whether `sdkKey` matches either Confeature SDK-key format (#802):
//   - `configcat-sdk-1/<22 b64url chars>/<22 b64url chars>` — minted
//     today; ConfigCat's own shape, so a stock ConfigCat SDK accepts it;
//   - `confeature-sdk-1-<32 b64url chars>-<32 b64url chars>` — minted
//     before #802, still accepted until the key is rotated.
// Accept/reject cases shared by every SDK live in
// `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
//
// A `false` result does NOT cause the SDK to abort; the client logs a
// redacted INVALID_SDK_KEY warning and continues (matches the Rust/Go
// "lenient runtime" semantics).
bool isValidConfeatureKeyFormat(std::string_view sdkKey);

// Returns a privacy-preserving rendering of `sdkKey` for logs.
// Keeps ~10 % of the key visible at each end (minimum 4 chars), masks
// the middle. Short / unusual keys fall back to "[redacted]". NEVER
// returns the raw key. Byte-identical to TS / Python / Rust ports for
// ASCII keys.
std::string redactSdkKey(std::string_view sdkKey);

// Derives a stable, opaque cache key from `sdkKey`.
//
// Format: `"confeature:cache:v1:<base64url(sha256(sdkKey))[..32]>"`.
//
// Byte-identical to:
//   - `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey`
//   - `apps/sdk-python/.../sdk_key.py:derive_cache_key`
//   - `apps/sdk-go/internal/sdkkey/sdkkey.go:DeriveCacheKey`
//   - `apps/sdk-dotnet/.../SdkKey.cs:DeriveCacheKey`
//   - `apps/sdk-rust/src/internal/sdk_key.rs:derive_cache_key`
//
// SECURITY: the SDK key is HASHED, never stored raw. An attacker with
// filesystem access to the cache directory cannot recover the SDK key
// from a written cache file's name.
std::string deriveCacheKey(std::string_view sdkKey);

// Strips the envelope prefix from a derived cache key, returning the
// 32-char tail — a local cache id only; it never goes on the wire (#803).
std::string_view cacheKeyTail(std::string_view cacheKey);

// Encodes `data` of length `len` as URL-safe base64 WITHOUT padding.
// Public for unit tests; the only customer of this in production is
// `deriveCacheKey`.
std::string base64UrlEncode(const unsigned char* data, std::size_t len);

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_SDK_KEY_H_
