// SPDX-License-Identifier: MIT

import CryptoKit
import Foundation

/// SDK-key helpers: format validation, redaction, cache-key derivation.
///
/// SECURITY (constitution security clause + spec 037/038 FR-008): SDK
/// keys are secrets. Every log site that needs to reference a key
/// passes it through ``redact(_:)`` first.
///
/// The cache-key algorithm mirrors the canonical TS implementation at
/// `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey` and the ports
/// in Python / Go / .NET / Rust / Ruby / PHP / Java. Cross-language
/// fixture verification lives in `Tests/ConfeatureTests/CacheKeyFixturesTests.swift`.
enum SdkKey {
    /// Envelope prefix for derived cache keys. Identical across every
    /// Confeature SDK.
    static let cacheKeyPrefix = "confeature:cache:v1:"

    /// Derives a stable, opaque cache key from `sdkKey`.
    ///
    /// Format: `"confeature:cache:v1:<base64url(sha256(sdkKey))[..32]>"`.
    ///
    /// Byte-identical to:
    /// - `packages/sdk-shared/src/sdk-key.ts:deriveCacheKey`
    /// - `apps/sdk-python/.../sdk_key.py:derive_cache_key`
    /// - `apps/sdk-go/internal/sdkkey/sdkkey.go:DeriveCacheKey`
    /// - `apps/sdk-dotnet/.../SdkKey.cs:DeriveCacheKey`
    /// - `apps/sdk-rust/.../sdk_key.rs:derive_cache_key`
    ///
    /// SECURITY: the SDK key is HASHED, never stored raw. An attacker
    /// with filesystem access to the cache directory cannot recover
    /// the SDK key from a written cache file's name.
    static func deriveCacheKey(_ sdkKey: String) -> String {
        // `String.data(using: .utf8)` only fails if the encoding is
        // not exact-representable, which is impossible for UTF-8 here.
        let data = sdkKey.data(using: .utf8) ?? Data()
        let digest = SHA256.hash(data: data)
        let base64 = Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let trimmed = String(base64.prefix(32))
        return "\(cacheKeyPrefix)\(trimmed)"
    }

    /// Strips the envelope prefix from a derived cache key, returning
    /// the 32-char tail: a LOCAL cache id (the on-disk file name). It
    /// never goes on the wire — the request path carries the SDK key
    /// itself, as ConfigCat's does (#803, ``ConfigFetcher/target``).
    static func cacheKeyTail(_ cacheKey: String) -> String {
        if let colon = cacheKey.lastIndex(of: ":") {
            return String(cacheKey[cacheKey.index(after: colon)...])
        }
        return cacheKey
    }

    /// Returns a privacy-preserving rendering of `sdkKey` for logs.
    ///
    /// Strategy: keep ~10 % of the key visible at each end (minimum
    /// 4 chars), mask the middle. For short / unusual keys (< 16
    /// chars) and the empty string, fall back to a full mask. NEVER
    /// returns the raw key.
    ///
    /// The key is treated as plain characters, `/` included. For a
    /// ConfigCat-shaped key (61 chars) the head is 6 chars of the
    /// public `configcat-sdk-1/` prefix and the tail is the last 6
    /// secret chars: `configcat-sdk-1/<22>/<22>` → `config…[redacted]…<6>`.
    ///
    /// Mirrors `redactSdkKey` (TS) and `redact_sdk_key` (Python)
    /// byte-for-byte for ASCII keys.
    static func redact(_ sdkKey: String) -> String {
        if sdkKey.isEmpty || sdkKey.count < 16 {
            return "[redacted]"
        }
        let visible = max(sdkKey.count / 10, 4)
        let start = sdkKey.startIndex
        let head = String(sdkKey[start..<sdkKey.index(start, offsetBy: visible)])
        let tail = String(sdkKey.suffix(visible))
        return "\(head)…[redacted]…\(tail)"
    }

    /// Reports whether `sdkKey` matches either Confeature SDK-key shape
    /// (#802). Both are valid:
    ///
    /// - `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>`:
    ///   minted today, ConfigCat's own shape, so a stock ConfigCat SDK
    ///   accepts the key too;
    /// - `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>`:
    ///   minted before #802, still accepted until the key is rotated.
    ///
    /// The url-safe alphabet is `[A-Za-z0-9_-]`. Equivalent to the
    /// canonical `CONFEATURE_SDK_KEY_PATTERN` in
    /// `packages/sdk-shared/src/sdk-key.ts`; the accept/reject cases
    /// live in `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
    ///
    /// A `false` result does NOT cause the SDK to abort; it triggers
    /// a redacted `INVALID_SDK_KEY` warning and the client continues.
    /// It does decide how the key travels in the request path: a
    /// well-shaped key goes in raw, any other key as one escaped
    /// segment (``ConfigFetcher/target``).
    static func isValidConfeatureKeyFormat(_ sdkKey: String) -> Bool {
        matchesShape(sdkKey, prefix: configCatPrefix, separator: UInt8(ascii: "/"), segment: 22)
            || matchesShape(sdkKey, prefix: legacyPrefix, separator: UInt8(ascii: "-"), segment: 32)
    }

    /// Prefix of the ConfigCat-shaped keys minted since #802.
    private static let configCatPrefix = "configcat-sdk-1/"

    /// Prefix of the legacy keys minted before #802.
    private static let legacyPrefix = "confeature-sdk-1-"

    /// `prefix` + `segment` url-safe bytes + `separator` + `segment`
    /// url-safe bytes, nothing else. The separator is matched by
    /// position, not by splitting: the legacy separator `-` is itself
    /// in the url-safe alphabet and may appear inside a segment.
    private static func matchesShape(
        _ sdkKey: String, prefix: String, separator: UInt8, segment: Int
    ) -> Bool {
        let bytes = Array(sdkKey.utf8)
        let head = Array(prefix.utf8)
        guard bytes.count == head.count + 2 * segment + 1,
            bytes.starts(with: head)
        else { return false }
        let rest = bytes[head.count...]
        let separatorIndex = rest.startIndex + segment
        for index in rest.indices where index != separatorIndex {
            guard isBase64URLByte(rest[index]) else { return false }
        }
        return rest[separatorIndex] == separator
    }

    private static func isBase64URLByte(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
            UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "-"):
            return true
        default:
            return false
        }
    }
}
