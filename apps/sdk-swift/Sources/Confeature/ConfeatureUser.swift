// SPDX-License-Identifier: MIT

import Foundation

/// Objective-C bridge wrapper over the Swift ``User`` struct.
///
/// `User` (struct) stays the idiomatic Swift type — Swift consumers
/// continue to instantiate `User(identifier:email:country:custom:)` as
/// before. Objective-C cannot bridge Swift structs, so this thin
/// `NSObject` wrapper exposes the same four fields and converts to /
/// from `User` via the internal ``coreUser`` accessor.
///
/// Mirrors the standard Apple Foundation bridging idiom (NSString ⇄
/// String, NSArray ⇄ Array, etc.). The conformance counterpart on the
/// ConfigCat side is `ConfigCat.ConfigCatUser: NSObject`, which is
/// also the only ObjC-visible user type in their SDK.
///
/// Used by the typed ObjC bridges on ``ConfeatureClient`` and
/// ``Snapshot`` (FR-027, FR-028) — every bridge takes a
/// `ConfeatureUser?` parameter and converts to the internal `User?`
/// before passing to the evaluator.
@objc(ConfeatureUser)
public final class ConfeatureUser: NSObject {
    /// Stable identifier (e.g. user UUID or email). Required field;
    /// an empty string is a legitimate value — corpora include
    /// "empty-id" tuples.
    @objc public let identifier: String

    /// Optional email address.
    @objc public let email: String?

    /// Optional ISO 3166-1 alpha-2 country code.
    @objc public let country: String?

    /// Free-form string attributes consumed by targeting rules. ObjC
    /// consumers pass an `NSDictionary<NSString *, NSString *>`;
    /// internally stored as `[String: String]`.
    @objc public let custom: [String: String]

    /// Designated initialiser mirroring ``User/init(identifier:email:country:custom:)``
    /// 1:1 — ObjC consumers call `[[ConfeatureUser alloc] initWithIdentifier:…]`.
    @objc public init(
        identifier: String,
        email: String? = nil,
        country: String? = nil,
        custom: [String: String] = [:]
    ) {
        self.identifier = identifier
        self.email = email
        self.country = country
        self.custom = custom
        super.init()
    }

    /// Internal accessor: lifts the wrapper back to the Swift ``User``
    /// struct so the evaluator (which consumes the struct form
    /// everywhere) does not need to learn about the ObjC bridge type.
    internal var coreUser: User {
        User(
            identifier: identifier,
            email: email,
            country: country,
            custom: custom
        )
    }

    /// Internal factory: wraps a Swift ``User`` struct into the ObjC
    /// bridge type. Used when ObjC consumers need to read back a
    /// user (e.g. via ``EvaluationDetailsBase/user``).
    internal static func from(_ user: User) -> ConfeatureUser {
        // The ObjC bridge surface is string-only (`NSDictionary<NSString *,
        // NSString *>`). The Swift ``User/custom`` is `[String: Any]`; keep
        // the string-valued entries so the bridge stays a faithful ObjC view
        // (ObjC consumers can only have supplied strings in the first place).
        var stringCustom: [String: String] = [:]
        for (k, v) in user.custom {
            if let s = v as? String { stringCustom[k] = s }
        }
        return ConfeatureUser(
            identifier: user.identifier,
            email: user.email,
            country: user.country,
            custom: stringCustom
        )
    }

    /// Optional-friendly form of ``from(_:)`` — returns `nil` if the
    /// source is `nil`.
    internal static func from(_ user: User?) -> ConfeatureUser? {
        guard let user else { return nil }
        return from(user)
    }
}
