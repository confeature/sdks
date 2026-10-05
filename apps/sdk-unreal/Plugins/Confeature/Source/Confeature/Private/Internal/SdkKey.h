// SPDX-License-Identifier: MIT
#pragma once

// SDK-key helpers: format validation, redaction, cache-key derivation.
//
// SECURITY (FR-013): SDK keys are secrets. Every log site that needs
// to reference a key passes it through `RedactSdkKey` first.
//
// The cache-key algorithm mirrors the canonical TS implementation at
// `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey` and the ports in
// Python / Go / .NET / Rust / Ruby / PHP / Java / Swift / Dart / C++.
// Cross-language fixture verification lives in
// `Private/Tests/CacheKeyFixturesTest.cpp`.

#include "CoreMinimal.h"

namespace Confeature::Internal
{
	inline constexpr const TCHAR* CacheKeyPrefix = TEXT("confeature:cache:v1:");

	// Reports whether `SdkKey` matches either Confeature SDK-key shape
	// (#802):
	//   - `configcat-sdk-1/<22 b64url chars>/<22 b64url chars>` — minted
	//     today, ConfigCat's own shape;
	//   - `confeature-sdk-1-<32 b64url chars>-<32 b64url chars>` — minted
	//     before #802, still accepted.
	// b64url = `[A-Za-z0-9_-]`. Mirrors `CONFEATURE_SDK_KEY_PATTERN` in
	// `packages/sdk-shared/src/sdk-key.ts`; the shared accept/reject
	// cases live in `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
	//
	// A `false` result does NOT cause the SDK to abort; the client logs
	// a redacted INVALID_SDK_KEY warning and continues (matches the
	// Rust / Go "lenient runtime" semantics). It does decide how the key
	// travels in the config URL (`BuildConfigUrl`, #803 FR-001).
	CONFEATURE_API bool IsValidConfeatureKeyFormat(const FString& SdkKey);

	// Returns a privacy-preserving rendering of `SdkKey` for logs.
	// Keeps ~10 % of the key visible at each end (minimum 4 chars),
	// masks the middle. Short / unusual keys fall back to "[redacted]".
	// NEVER returns the raw key. Byte-identical to TS / Python / Rust
	// / C++ ports for ASCII keys.
	CONFEATURE_API FString RedactSdkKey(const FString& SdkKey);

	// Derives a stable, opaque cache key from `SdkKey`.
	//
	// Format: `"confeature:cache:v1:<base64url(sha256(SdkKey))[..32]>"`.
	//
	// Byte-identical to:
	//   - `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey`
	//   - `apps/sdk-python/.../sdk_key.py:derive_cache_key`
	//   - `apps/sdk-go/internal/sdkkey/sdkkey.go:DeriveCacheKey`
	//   - `apps/sdk-dotnet/.../SdkKey.cs:DeriveCacheKey`
	//   - `apps/sdk-rust/src/internal/sdk_key.rs:derive_cache_key`
	//
	// SECURITY: the SDK key is HASHED, never stored raw. An attacker
	// with filesystem access to the cache directory cannot recover the
	// SDK key from a written cache file's name.
	CONFEATURE_API FString DeriveCacheKey(const FString& SdkKey);

	// Strips the envelope prefix from a derived cache key, returning
	// the 32-char tail — a LOCAL cache id (the on-disk file name) only.
	// It never goes on the wire: the config URL carries the SDK key
	// itself, as ConfigCat's does (#803, `BuildConfigUrl`).
	CONFEATURE_API FString CacheKeyTail(const FString& CacheKey);

	// Encodes `Data` of length `Len` as URL-safe base64 WITHOUT padding.
	// Public for unit tests; the only customer of this in production is
	// `DeriveCacheKey`.
	CONFEATURE_API FString Base64UrlEncode(const uint8* Data, int32 Len);
}
