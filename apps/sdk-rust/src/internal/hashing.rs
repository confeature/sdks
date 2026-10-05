// SPDX-License-Identifier: MIT

//! ConfigCat hashing primitives — port of
//! `packages/sdk-shared/src/hash.ts` (spec 125, research §R2).
//!
//! The flag evaluator needs two hashes, byte-identical across every
//! Confeature SDK (the parity corpus requires the same bucket / hash on
//! every runtime):
//!
//! - **SHA-1, UNSALTED** for percentage bucketing —
//!   `parse_int(sha1(key + attr)[0..7], 16) % 100`. Uses the `sha1`
//!   crate (RustCrypto 0.10.x, MSRV-1.86-safe).
//! - **SHA-256, SALTED** for sensitive comparators —
//!   `sha256(utf8(value) ++ utf8(config_salt) ++ utf8(context_salt))`.
//!   Uses the `sha2` crate (already a dependency).
//!
//! Both return a **lowercase hex** string. These are bucketing / hashed-
//! equality matches, not a security boundary — exactly what ConfigCat's
//! `common-js` ships.

use sha1::Sha1;
use sha2::{Digest, Sha256};

/// Lowercase-hex-encode a byte slice (mirrors `hash.ts::toHex`).
fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// SHA-1 digest of `input` as a 40-char lowercase hex string. Used
/// UNSALTED for ConfigCat percentage bucketing (`hash.ts::sha1`).
pub(crate) fn sha1_hex(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    to_hex(&hasher.finalize())
}

/// SHA-256 digest of raw `msg` bytes as a 64-char lowercase hex string.
/// The byte-level entry point the sensitive startsWith/endsWith
/// comparators need (`hash.ts::sha256Bytes`).
pub(crate) fn sha256_bytes_hex(msg: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(msg);
    to_hex(&hasher.finalize())
}

/// SHA-256 digest of a UTF-8 string as lowercase hex (`hash.ts::sha256`).
fn sha256_hex(input: &str) -> String {
    sha256_bytes_hex(input.as_bytes())
}

/// Hash a user-attribute value for a **sensitive** comparator
/// (`hash.ts::hashComparisonValue`):
/// `sha256( utf8(value) ++ utf8(config_salt) ++ utf8(context_salt) )`,
/// concatenated with no separators, lowercase hex.
///
/// `context_salt` is the setting key (user conditions) or the segment
/// name (segment conditions).
pub(crate) fn hash_comparison_value(value: &str, config_salt: &str, context_salt: &str) -> String {
    let mut buf = String::with_capacity(value.len() + config_salt.len() + context_salt.len());
    buf.push_str(value);
    buf.push_str(config_salt);
    buf.push_str(context_salt);
    sha256_hex(&buf)
}

/// Hash a UTF-8 byte slice for a sensitive startsWith/endsWith
/// comparator (`hash.ts::hashComparisonValueSlice`):
/// `sha256( slice_bytes ++ utf8(config_salt) ++ utf8(context_salt) )`.
///
/// The slice is raw bytes (a byte-boundary cut of the attribute, which
/// may land mid-codepoint), so the hash runs over the concatenated byte
/// sequence — re-encoding would corrupt multibyte attributes.
pub(crate) fn hash_comparison_value_slice(
    slice: &[u8],
    config_salt: &str,
    context_salt: &str,
) -> String {
    let mut buf = Vec::with_capacity(slice.len() + config_salt.len() + context_salt.len());
    buf.extend_from_slice(slice);
    buf.extend_from_slice(config_salt.as_bytes());
    buf.extend_from_slice(context_salt.as_bytes());
    sha256_bytes_hex(&buf)
}

/// Compute a ConfigCat percentage bucket in `[0, 99]` for
/// `key + attr_value` (`hash.ts::percentageBucket`):
/// `parse_int( sha1(key + attr_value)[0..7], 16 ) % 100`.
///
/// SHA-1, **unsalted**. 7 hex chars = 28 bits, well within `u64`.
pub(crate) fn percentage_bucket(key: &str, attr_value: &str) -> u64 {
    let mut input = String::with_capacity(key.len() + attr_value.len());
    input.push_str(key);
    input.push_str(attr_value);
    let hex = sha1_hex(&input);
    // `sha1_hex` always returns 40 hex chars, so [0..7] is safe.
    u64::from_str_radix(&hex[0..7], 16).unwrap_or(0) % 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_known_vector() {
        // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
        assert_eq!(sha1_hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        // SHA-1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
        assert_eq!(sha1_hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }

    #[test]
    fn sha256_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn percentage_bucket_in_range_and_deterministic() {
        for key in ["k", "feature.x", "anotherKey"] {
            for attr in ["12345", "alice@acme.com", ""] {
                let b = percentage_bucket(key, attr);
                assert!(b < 100, "bucket {b} out of range");
                assert_eq!(b, percentage_bucket(key, attr), "must be deterministic");
            }
        }
    }

    #[test]
    fn percentage_bucket_matches_hash_ts_concatenation() {
        // Cross-check vs hash.ts: percentageBucket("k","12345") ===
        // parseInt(sha1("k12345").substring(0,7),16) % 100.
        let hex = sha1_hex("k12345");
        let expected = u64::from_str_radix(&hex[0..7], 16).unwrap() % 100;
        assert_eq!(percentage_bucket("k", "12345"), expected);
    }

    #[test]
    fn hash_comparison_value_concatenation() {
        // hashComparisonValue(value, configSalt, contextSalt) ==
        // sha256(value ++ configSalt ++ contextSalt).
        let v = "alice@acme.com";
        let cs = "saltvalue";
        let ctx = "feature.x";
        assert_eq!(
            hash_comparison_value(v, cs, ctx),
            sha256_hex(&format!("{v}{cs}{ctx}"))
        );
    }
}
