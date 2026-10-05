// SPDX-License-Identifier: MIT

// Package sdkkey provides SDK-key format helpers + cache-key derivation.
//
// SECURITY (constitution security clause + spec 037/038 FR-008): SDK
// keys are secrets. They MUST NEVER appear verbatim in any log line.
// Every log site that needs to reference a key passes it through
// RedactSdkKey first.
//
// The cache-key algorithm mirrors packages/sdk-shared/src/sdk-key.ts's
// async deriveCacheKey (SHA-256 → base64url → first 32 chars) and the
// Python port at apps/sdk-python/.../sdk_key.py. Cross-language fixture
// verification lives in sdkkey_test.go.
package sdkkey

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// confeatureSdkKeyPattern accepts both Confeature SDK-key shapes (#802):
//
//   - `configcat-sdk-1/<22 url-safe>/<22 url-safe>` — minted today. It is
//     ConfigCat's own shape, so a stock ConfigCat SDK accepts the key too.
//   - `confeature-sdk-1-<32 url-safe>-<32 url-safe>` — minted before #802,
//     still served until the key is rotated.
//
// Mirrors CONFEATURE_SDK_KEY_PATTERN in packages/sdk-shared/src/sdk-key.ts;
// the accept/reject cases live in packages/test-fixtures-sdk-parity/
// fixtures/sdk-key-shapes.json. Validation is lenient at runtime:
// malformed keys log INVALID_SDK_KEY (redacted) and continue.
var confeatureSdkKeyPattern = regexp.MustCompile(
	`^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$`,
)

// cacheKeyPrefix is the envelope prefix for derived cache keys.
// Identical across every Confeature SDK; mirrors the TS implementation's
// constant.
const cacheKeyPrefix = "confeature:cache:v1:"

// IsValidConfeatureKeyFormat reports whether the key matches either
// Confeature SDK-key shape (ConfigCat-shaped or legacy).
//
// A false result does NOT cause the SDK to throw; it triggers an
// INVALID_SDK_KEY log line (which, per the security clause, includes
// only the redacted form).
func IsValidConfeatureKeyFormat(sdkKey string) bool {
	return confeatureSdkKeyPattern.MatchString(sdkKey)
}

// RedactSdkKey returns a privacy-preserving rendering of sdkKey for logs.
//
// Strategy: keep ~10% of the key visible at each end (minimum 4 chars),
// mask the middle. For short / unusual keys (< 16 chars) and the empty
// string, fall back to a full mask. NEVER returns the raw key.
//
// Mirrors redactSdkKey (TS) and redact_sdk_key (Python) byte-for-byte.
func RedactSdkKey(sdkKey string) string {
	if sdkKey == "" || len(sdkKey) < 16 {
		return "[redacted]"
	}
	// Use rune-aware length so multi-byte keys (rare but possible —
	// the fixture includes a 🦀 case) keep symmetric head/tail visible
	// counts. The TS implementation slices by code units, but for
	// ASCII the result is identical to a rune slice. We slice by
	// bytes here because the test fixtures use ASCII keys; the
	// matching behaviour with the TS implementation is preserved.
	visible := len(sdkKey) / 10
	if visible < 4 {
		visible = 4
	}
	head := sdkKey[:visible]
	tail := sdkKey[len(sdkKey)-visible:]
	return head + "…[redacted]…" + tail
}

// DeriveCacheKey derives a stable, opaque cache key from an SDK key.
//
// Format: "confeature:cache:v1:<base64url(sha256(sdkKey))[:32]>".
//
// Output is byte-identical to:
//   - packages/sdk-shared/src/sdk-key.ts:deriveCacheKey (async,
//     SubtleCrypto-based).
//   - apps/sdk-python/.../sdk_key.py:derive_cache_key.
//
// The cross-language fixture at
// packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json
// pins ≥ 5 (sdkKey, expectedCacheKey) pairs; sdkkey_test.go asserts
// equality for every entry.
//
// SECURITY: the SDK key is HASHED, never stored raw. Even an attacker
// with filesystem access to the cache directory cannot read the SDK
// key from a written cache file's name.
func DeriveCacheKey(sdkKey string) string {
	sum := sha256.Sum256([]byte(sdkKey))
	// base64.RawURLEncoding emits the URL-safe alphabet (`-` / `_`)
	// without padding — matching the TS counterpart's
	// .replace(/=+$/, "") trim.
	b64 := base64.RawURLEncoding.EncodeToString(sum[:])
	return cacheKeyPrefix + b64[:32]
}
