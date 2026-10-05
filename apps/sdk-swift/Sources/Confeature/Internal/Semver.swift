// SPDX-License-Identifier: MIT

import Foundation

/// ConfigCat-semantics semver parse + compare (research.md §R3), ported
/// field-for-field from `packages/sdk-shared/src/semver.ts` (which itself
/// vendors ConfigCat `common-js`'s `Semver.ts`).
///
/// A SwiftPM semver package is NOT used — npm/Swift semver libraries diverge
/// from ConfigCat on loose-parse + precedence edge cases and would fail the
/// vendored `testmatrix_semantic*` precedence rows.
///
/// Key behaviours:
///   - Strict `FULL` grammar: `v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?`,
///     each core component `0|[1-9]\d*`.
///   - Parse on trim. Unparseable → `nil`, never a throw (the caller treats
///     `nil` as a validation error).
///   - Precedence: numeric core first; a version WITHOUT a pre-release ranks
///     HIGHER than one WITH; pre-release identifiers compared field-by-field
///     (numeric < alphanumeric; numerics numerically; alphanumerics
///     ASCII-lexically; more fields rank higher when all preceding equal).
///   - Build metadata ignored for precedence.
struct SemVer {
    let canonical: String
    let major: Int
    let minor: Int
    let patch: Int
    /// Pre-release identifiers; numeric ids carry their `Int`, else `String`.
    let prerelease: [Identifier]
    /// Build-metadata identifiers (ignored for precedence).
    let build: [String]

    /// A pre-release / core identifier: numeric or alphanumeric.
    enum Identifier: Equatable {
        case number(Int)
        case text(String)
    }

    private static let maxLength = 256
    // Mirrors common-js `Number.MAX_SAFE_INTEGER`.
    private static let maxSafeInteger = 9_007_199_254_740_991

    // MAJOR.MINOR.PATCH where each core component is `0|[1-9]\d*`, an optional
    // leading `v`, an optional `-prerelease`, an optional `+build`.
    private static let full: NSRegularExpression = {
        let numeric = "0|[1-9]\\d*"
        let nonNumeric = "\\d*[a-zA-Z-][a-zA-Z0-9-]*"
        let main = "(\(numeric))\\.(\(numeric))\\.(\(numeric))"
        let preId = "(?:\(numeric)|\(nonNumeric))"
        let prerelease = "(?:-(\(preId)(?:\\.\(preId))*))"
        let buildId = "[0-9A-Za-z-]+"
        let build = "(?:\\+(\(buildId)(?:\\.\(buildId))*))"
        let pattern = "^v?\(main)\(prerelease)?\(build)?$"
        // The pattern is a compile-time constant — `try!` is correct here.
        // swiftlint:disable:next force_try
        return try! NSRegularExpression(pattern: pattern)
    }()

    private static func isNumericIdentifier(_ s: String) -> Bool {
        !s.isEmpty && s.allSatisfy { $0.isASCII && $0.isNumber }
    }

    /// Parse a version string under ConfigCat's strict grammar, returning
    /// `nil` on any failure (length, grammar, out-of-range core) — never a
    /// throw. Trims the input first.
    static func parse(_ version: String) -> SemVer? {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count > maxLength { return nil }
        let ns = trimmed as NSString
        guard
            let m = full.firstMatch(
                in: trimmed, range: NSRange(location: 0, length: ns.length))
        else { return nil }

        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }

        guard
            let majStr = group(1), let minStr = group(2), let patStr = group(3),
            let major = Int(majStr), let minor = Int(minStr), let patch = Int(patStr)
        else { return nil }
        if major < 0 || major > maxSafeInteger || minor < 0 || minor > maxSafeInteger
            || patch < 0 || patch > maxSafeInteger
        {
            return nil
        }

        var prerelease: [Identifier] = []
        if let pre = group(4) {
            for id in pre.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
                if isNumericIdentifier(id), let num = Int(id), num >= 0, num < maxSafeInteger {
                    prerelease.append(.number(num))
                } else {
                    prerelease.append(.text(id))
                }
            }
        }

        let build: [String] =
            group(5).map {
                $0.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            } ?? []

        var canonical = "\(major).\(minor).\(patch)"
        if !prerelease.isEmpty {
            let joined = prerelease.map {
                switch $0 {
                case .number(let n): return String(n)
                case .text(let s): return s
                }
            }.joined(separator: ".")
            canonical += "-\(joined)"
        }
        return SemVer(
            canonical: canonical, major: major, minor: minor, patch: patch,
            prerelease: prerelease, build: build)
    }

    /// Compare against `other`: `<0` lower-precedence, `0` equal, `>0` higher.
    /// Build metadata is ignored.
    func compare(_ other: SemVer) -> Int {
        if other.canonical == canonical { return 0 }
        let main = SemVer.compareMain(self, other)
        if main != 0 { return main }
        return comparePre(other)
    }

    private static func compareMain(_ a: SemVer, _ b: SemVer) -> Int {
        let cmpMajor = compareIdentifiers(.number(a.major), .number(b.major))
        if cmpMajor != 0 { return cmpMajor }
        let cmpMinor = compareIdentifiers(.number(a.minor), .number(b.minor))
        if cmpMinor != 0 { return cmpMinor }
        return compareIdentifiers(.number(a.patch), .number(b.patch))
    }

    private func comparePre(_ other: SemVer) -> Int {
        // A version WITHOUT a pre-release is higher-precedence than one WITH.
        if !prerelease.isEmpty && other.prerelease.isEmpty { return -1 }
        if prerelease.isEmpty && !other.prerelease.isEmpty { return 1 }
        if prerelease.isEmpty && other.prerelease.isEmpty { return 0 }

        var i = 0
        while true {
            let a = i < prerelease.count ? prerelease[i] : nil
            let b = i < other.prerelease.count ? other.prerelease[i] : nil
            if a == nil && b == nil { return 0 }
            if b == nil { return 1 }
            if a == nil { return -1 }
            if a == b {
                i += 1
                continue
            }
            return SemVer.compareIdentifiers(a!, b!)
        }
    }

    /// Compare two identifiers exactly as common-js `compareIdentifiers`:
    /// both numeric → numeric; numeric is lower-precedence than alphanumeric;
    /// else ASCII-lexical.
    private static func compareIdentifiers(_ a: Identifier, _ b: Identifier) -> Int {
        let aNum: Bool
        let bNum: Bool
        switch a {
        case .number: aNum = true
        case .text(let s): aNum = isNumericIdentifier(s)
        }
        switch b {
        case .number: bNum = true
        case .text(let s): bNum = isNumericIdentifier(s)
        }

        if aNum && bNum {
            let av = numericValue(a)
            let bv = numericValue(b)
            if av == bv { return 0 }
            return av < bv ? -1 : 1
        }
        if aNum && !bNum { return -1 }
        if bNum && !aNum { return 1 }
        // Both alphanumeric → ASCII-lexical.
        let astr = stringValue(a)
        let bstr = stringValue(b)
        if astr == bstr { return 0 }
        return astr < bstr ? -1 : 1
    }

    private static func numericValue(_ id: Identifier) -> Int {
        switch id {
        case .number(let n): return n
        case .text(let s): return Int(s) ?? 0
        }
    }

    private static func stringValue(_ id: Identifier) -> String {
        switch id {
        case .number(let n): return String(n)
        case .text(let s): return s
        }
    }
}
