// SPDX-License-Identifier: MIT

import Foundation

/// Targeting context passed alongside flag evaluations.
///
/// Mirrors the upstream `ConfigCat-iOS` `ConfigCatUser` 1:1 — fields,
/// field names, default semantics. In particular `custom` is typed
/// `[String: Any]` to match upstream's `custom: [String: Any]?`
/// parameter, so a value carries its NATURAL Swift type to the
/// evaluator:
///
///   - text-based comparators accept any value (non-strings are
///     converted to their canonical string),
///   - number-based comparators accept `Int` / `UInt` / `Double` /
///     `Float` (or a valid-decimal `String`),
///   - date-time comparators accept `Date` (→ Unix seconds) or a
///     numeric epoch,
///   - array-based comparators accept `[String]` (or a JSON-string
///     array).
///
/// A `[String: String]` literal still type-checks against the widened
/// `[String: Any]`, so existing string-only call sites migrate with no
/// edit (Principle II — ConfigCat drop-in).
public struct User: @unchecked Sendable {
    /// Stable identifier (e.g. user UUID or email). Required field;
    /// an empty string is a legitimate value — corpora include
    /// "empty-id" tuples.
    public var identifier: String

    /// Optional email address.
    public var email: String?

    /// Optional ISO 3166-1 alpha-2 country code.
    public var country: String?

    /// Free-form custom attributes consumed by targeting rules.
    /// Typed `[String: Any]` to mirror upstream's
    /// `ConfigCatUser(custom: [String: Any]?)` — values keep their
    /// natural type (`String` / `Int` / `Double` / `Bool` / `Date` /
    /// `[String]`) all the way to the comparator layer.
    public var custom: [String: Any]

    /// Designated initializer mirroring ConfigCat-iOS's parameter
    /// names exactly so a customer's `ConfigCatUser(...)` call site
    /// migrates to `User(...)` with no further edits.
    public init(
        identifier: String,
        email: String? = nil,
        country: String? = nil,
        custom: [String: Any] = [:]
    ) {
        self.identifier = identifier
        self.email = email
        self.country = country
        self.custom = custom
    }
}

extension User: Equatable {
    /// Structural equality. The `[String: Any]` custom map is compared
    /// via Foundation's `NSDictionary` value-equality (the same idiom
    /// Foundation bridging uses), so two `User`s with equal scalar /
    /// string / array / date attributes compare equal. Retained because
    /// `User?` is compared against `nil` across the test suite (which
    /// requires `User: Equatable`).
    public static func == (lhs: User, rhs: User) -> Bool {
        lhs.identifier == rhs.identifier
            && lhs.email == rhs.email
            && lhs.country == rhs.country
            && (lhs.custom as NSDictionary) == (rhs.custom as NSDictionary)
    }
}
