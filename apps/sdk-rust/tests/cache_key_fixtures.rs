// SPDX-License-Identifier: MIT

//! Cross-language cache-key fixture gate (FR-028 / SC-003).
//!
//! Consumes `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
//! and asserts that this crate's [`confeature::internal::sdk_key::derive_cache_key`]
//! mirror (re-exposed via the public `confeature::__test_only_derive_cache_key`
//! shim is NOT desired — we instead route through a tiny `pub` helper at
//! the crate root) produces byte-identical output to TS / Python / Go /
//! .NET for every recorded SDK key.
//!
//! Mirrors `apps/sdk-go/internal/sdkkey/sdkkey_test.go::TestCrossLanguageCacheKey`
//! 1:1 — the JSON format and minimum 5-entry contract are shared.

mod common;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CacheKeyFixture {
    #[serde(rename = "sdkKey")]
    sdk_key: String,
    #[serde(rename = "expectedCacheKey")]
    expected_cache_key: String,
}

#[test]
fn cross_language_cache_key_fixtures_match() {
    let path = common::cache_key_fixtures_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let fixtures: Vec<CacheKeyFixture> =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse cache-key-fixtures.json: {e}"));

    assert!(
        fixtures.len() >= 5,
        "expected ≥ 5 cache-key fixtures, got {} — \
         regenerate via `pnpm run export:cache-key-fixtures` in \
         packages/test-fixtures-sdk-parity/",
        fixtures.len()
    );

    for fx in &fixtures {
        let actual = confeature::derive_cache_key(&fx.sdk_key);
        let redacted = confeature::redact_sdk_key(&fx.sdk_key);
        assert_eq!(
            actual, fx.expected_cache_key,
            "cross-language cache-key drift\n  input (redacted): {redacted}\n  expected: {}\n  got:      {actual}",
            fx.expected_cache_key,
        );
    }
}
