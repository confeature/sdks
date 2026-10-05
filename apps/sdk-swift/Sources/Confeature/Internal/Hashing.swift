// SPDX-License-Identifier: MIT

import CryptoKit
import Foundation

/// Two synchronous hashes the ConfigCat-parity evaluator needs
/// (research.md §R2), ported field-for-field from
/// `packages/sdk-shared/src/hash.ts`:
///
///   - **SHA-1, UNSALTED** for percentage bucketing —
///     `Int(sha1(key + attr)[0..<7], radix: 16) % 100`.
///   - **SHA-256, SALTED** for sensitive comparators —
///     `sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))`.
///
/// Both return a **lowercase hex** string that is byte-identical across the
/// TS / Python / Go / .NET / Rust / Ruby / PHP / Java ports — the parity
/// corpus requires the same bucket / hash on every runtime.
///
/// CryptoKit is already a dependency (`SdkKey.swift`); no new package is
/// introduced. `Insecure.SHA1` is used INTENTIONALLY here — this is a
/// bucketing / hashed-equality match, NOT a security boundary, exactly as
/// ConfigCat's own SDKs do it.
enum Hashing {
    /// Lowercase-hex-encode a digest's bytes.
    private static func toHex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        var out = ""
        out.reserveCapacity(64)
        for b in bytes {
            out.append(hexChar((b >> 4) & 0x0f))
            out.append(hexChar(b & 0x0f))
        }
        return out
    }

    private static func hexChar(_ nibble: UInt8) -> Character {
        let table: [Character] = [
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f",
        ]
        return table[Int(nibble)]
    }

    /// SHA-1 of `input` as a 40-char lowercase hex string. UNSALTED — used
    /// only for percentage bucketing.
    ///
    /// `Insecure.SHA1` is intentional non-security usage (see type doc).
    static func sha1Hex(_ input: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(input.utf8))
        return toHex(digest)
    }

    /// SHA-256 of `bytes` as a 64-char lowercase hex string. The byte-level
    /// entry point the sensitive startsWith/endsWith comparators need: they
    /// slice the attribute at the UTF-8 BYTE boundary (possibly mid-codepoint)
    /// and hash that slice concatenated with the salt bytes.
    static func sha256Hex(_ bytes: Data) -> String {
        let digest = SHA256.hash(data: bytes)
        return toHex(digest)
    }

    /// SHA-256 of `input`'s UTF-8 bytes as lowercase hex.
    static func sha256Hex(_ input: String) -> String {
        sha256Hex(Data(input.utf8))
    }

    /// ConfigCat percentage bucket in `[0, 99]` for `key + attrValue`
    /// (research.md §R2):
    /// `Int(sha1(key + attrValue)[0..<7], radix: 16) % 100`.
    ///
    /// SHA-1, UNSALTED. 7 hex chars = 28 bits, well within `UInt64`.
    static func percentageBucket(key: String, attrValue: String) -> Int {
        let hex = String(sha1Hex(key + attrValue).prefix(7))
        // 7 hex chars always parse to a `UInt64`; fail-closed to 0 otherwise.
        let value = UInt64(hex, radix: 16) ?? 0
        return Int(value % 100)
    }

    /// Hash a user-attribute value for a SENSITIVE comparator (research.md
    /// §R2). Mirrors common-js `hashComparisonValue`:
    /// `sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))`,
    /// concatenated with no separators, lowercase hex.
    static func hashComparisonValue(
        _ value: String, configSalt: String, contextSalt: String
    ) -> String {
        sha256Hex(value + configSalt + contextSalt)
    }
}
