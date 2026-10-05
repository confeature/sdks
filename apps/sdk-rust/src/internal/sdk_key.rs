// SPDX-License-Identifier: MIT

//! SDK-key helpers: format validation, redaction, cache-key derivation.
//!
//! SECURITY (constitution security clause + spec 037/038 FR-008): SDK
//! keys are secrets. Every log site that needs to reference a key
//! passes it through [`redact_sdk_key`] first.
//!
//! The cache-key algorithm mirrors the canonical TS implementation
//! at `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey` and the
//! ports in Python / Go / .NET. Cross-language fixture verification
//! lives in `tests/cache_key_fixtures.rs`.

use base64::Engine;
use sha2::{Digest, Sha256};

/// Envelope prefix for derived cache keys. Identical across every
/// Confeature SDK.
const CACHE_KEY_PREFIX: &str = "confeature:cache:v1:";

/// Prefix of a ConfigCat-shaped key: `configcat-sdk-1/<22>/<22>` — the shape
/// Confeature mints since #802, so a stock ConfigCat SDK accepts the key too.
const CONFIGCAT_SDK_KEY_PREFIX: &str = "configcat-sdk-1/";

/// Prefix of a legacy key: `confeature-sdk-1-<32>-<32>` — minted before #802
/// and still served until the key is rotated.
const LEGACY_SDK_KEY_PREFIX: &str = "confeature-sdk-1-";

/// Reports whether `sdk_key` matches either Confeature SDK-key format:
///
/// - `configcat-sdk-1/<22 chars>/<22 chars>` — minted today; ConfigCat's own
///   shape (e.g. `configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02`);
/// - `confeature-sdk-1-<32 chars>-<32 chars>` — minted before, still accepted.
///
/// Each segment uses the base64url alphabet (`A-Z`, `a-z`, `0-9`, `_`, `-`).
/// Equivalent to the canonical TS `CONFEATURE_SDK_KEY_PATTERN`
/// (`packages/sdk-shared/src/sdk-key.ts`); the accept / reject cases every
/// SDK tests against live in
/// `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
///
/// A `false` result does NOT cause the SDK to abort; it triggers a
/// redacted `INVALID_SDK_KEY` warning and the client continues.
pub fn is_valid_confeature_key_format(sdk_key: &str) -> bool {
    // Manual scan to avoid pulling in the `regex` crate for a two-branch
    // check.
    if let Some(rest) = sdk_key.strip_prefix(CONFIGCAT_SDK_KEY_PREFIX) {
        return two_segments(rest, '/', 22);
    }
    if let Some(rest) = sdk_key.strip_prefix(LEGACY_SDK_KEY_PREFIX) {
        return two_segments(rest, '-', 32);
    }
    false
}

/// `rest` is exactly two `len`-char base64url segments joined by `sep`.
///
/// Splits at the fixed offset rather than on `sep`: in the legacy shape the
/// separator `-` is also a legal segment character.
fn two_segments(rest: &str, sep: char, len: usize) -> bool {
    let bytes = rest.as_bytes();
    bytes.len() == 2 * len + 1
        && bytes[len] == sep as u8
        && bytes[..len].iter().copied().all(is_b64url_byte)
        && bytes[len + 1..].iter().copied().all(is_b64url_byte)
}

#[inline]
fn is_b64url_byte(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')
}

/// Returns a privacy-preserving rendering of `sdk_key` for logs.
///
/// Strategy: keep ~10 % of the key visible at each end (minimum 4
/// chars), mask the middle. For short / unusual keys (< 16 chars) and
/// the empty string, fall back to a full mask. NEVER returns the raw
/// key. A ConfigCat-shaped key (`configcat-sdk-1/<22>/<22>`, 61 chars)
/// shows 6 chars at each end — its `config` prefix and the last 6 chars
/// of its second segment; the `/` separators are ordinary characters here.
///
/// Mirrors `redactSdkKey` (TS) and `redact_sdk_key` (Python) byte-for-
/// byte for ASCII keys. Counts characters, not bytes, so a malformed
/// non-ASCII key never panics — a `str` slicing panic would print the
/// raw key in its message.
pub fn redact_sdk_key(sdk_key: &str) -> String {
    let chars = sdk_key.chars().count();
    if chars < 16 {
        return "[redacted]".to_string();
    }
    let visible = std::cmp::max(chars / 10, 4);
    let head: String = sdk_key.chars().take(visible).collect();
    let tail: String = sdk_key.chars().skip(chars - visible).collect();
    format!("{head}…[redacted]…{tail}")
}

/// Derives a stable, opaque cache key from `sdk_key`.
///
/// Format: `"confeature:cache:v1:<base64url(sha256(sdkKey))[..32]>"`.
///
/// Byte-identical to:
/// - `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey`
/// - `apps/sdk-python/.../sdk_key.py:derive_cache_key`
/// - `apps/sdk-go/internal/sdkkey/sdkkey.go:DeriveCacheKey`
/// - `apps/sdk-dotnet/.../SdkKey.cs:DeriveCacheKey`
///
/// SECURITY: the SDK key is HASHED, never stored raw. An attacker with
/// filesystem access to the cache directory cannot recover the SDK key
/// from a written cache file's name.
pub fn derive_cache_key(sdk_key: &str) -> String {
    let digest = Sha256::digest(sdk_key.as_bytes());
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    format!("{CACHE_KEY_PREFIX}{}", &b64[..32])
}

/// Strips the envelope prefix from a derived cache key, returning the
/// 32-char tail used as the local cache id (file name). It never travels
/// on the wire — the config URL carries the SDK key itself (#803).
pub fn cache_key_tail(cache_key: &str) -> &str {
    match cache_key.rsplit_once(':') {
        Some((_, tail)) => tail,
        None => cache_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_cache_key_matches_known_fixture() {
        // First entry of cache-key-fixtures.json — also asserted by
        // tests/cache_key_fixtures.rs against the cross-language file.
        let key =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let expected = "confeature:cache:v1:bIg57I9_4ya_LRRpZZ8qZdn_gXPqQ1aY";
        assert_eq!(derive_cache_key(key), expected);
    }

    #[test]
    fn derive_cache_key_empty_input() {
        let expected = "confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM";
        assert_eq!(derive_cache_key(""), expected);
    }

    #[test]
    fn redact_empty_returns_marker() {
        assert_eq!(redact_sdk_key(""), "[redacted]");
    }

    #[test]
    fn redact_short_returns_marker() {
        assert_eq!(redact_sdk_key("short"), "[redacted]");
    }

    #[test]
    fn redact_long_keeps_head_and_tail() {
        let key =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let out = redact_sdk_key(key);
        // 83 chars / 10 = 8 visible chars at each end.
        let visible = key.len() / 10;
        assert!(out.starts_with(&key[..visible]));
        assert!(out.ends_with(&key[key.len() - visible..]));
        assert!(out.contains("[redacted]"));
        // The masked middle section must NOT contain the secret payload.
        assert!(!out.contains(&key[20..40]));
    }

    #[test]
    fn is_valid_format_accepts_canonical() {
        let key =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        assert!(is_valid_confeature_key_format(key));
    }

    #[test]
    fn is_valid_format_accepts_configcat_shape() {
        let key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";
        assert!(is_valid_confeature_key_format(key));
    }

    #[test]
    fn is_valid_format_rejects_mixed_separators() {
        // Right lengths, wrong separator for the prefix.
        assert!(!is_valid_confeature_key_format(
            "configcat-sdk-1/FAKEfixtureKeyNotRea01-FAKEfixtureKeyNotRea02"
        ));
        assert!(!is_valid_confeature_key_format(
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        ));
        // Legacy prefix with the new shape's segment lengths.
        assert!(!is_valid_confeature_key_format(
            "confeature-sdk-1-FAKEfixtureKeyNotRea01-FAKEfixtureKeyNotRea02"
        ));
    }

    #[test]
    fn redact_configcat_shape_hides_the_secret() {
        let key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";
        let out = redact_sdk_key(key);
        // 61 chars / 10 = 6 visible chars at each end.
        assert_eq!(out, "config…[redacted]…tRea02");
        assert!(!out.contains("FAKEfixtureKeyNotRea01"));
        assert!(!out.contains("FAKEfixtureKey"));
    }

    #[test]
    fn redact_non_ascii_does_not_panic_or_leak() {
        let key = "confeature-sdk-1-\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}secretsecret";
        let out = redact_sdk_key(key);
        assert!(out.contains("[redacted]"));
        assert!(!out.contains("secretsecret"));
    }

    #[test]
    fn is_valid_format_rejects_empty_and_short() {
        assert!(!is_valid_confeature_key_format(""));
        assert!(!is_valid_confeature_key_format("confeature-sdk-1-"));
        assert!(!is_valid_confeature_key_format("configcat-sdk-1-test-key"));
    }

    #[test]
    fn cache_key_tail_strips_prefix() {
        assert_eq!(cache_key_tail("confeature:cache:v1:abc"), "abc");
        assert_eq!(cache_key_tail("no-colon"), "no-colon");
    }
}
