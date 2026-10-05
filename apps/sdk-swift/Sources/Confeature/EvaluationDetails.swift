// SPDX-License-Identifier: MIT

import Foundation

/// Typed error code carried on every ``EvaluationDetails`` /
/// ``TypedEvaluationDetails`` envelope, mirroring ConfigCat 11.3.1's
/// `EvaluationErrorCode` enum (`Sources/ConfigCat/EvaluationDetails.swift`)
/// 1:1 — same case names, same raw integer values.
///
/// The raw integers MUST stay stable: ConfigCat's `@objc` bridge encodes
/// these as `NSInteger` and customers may compare against the raw values
/// from Objective-C code.
@objc public enum EvaluationErrorCode: Int {
    /// User passed an invalid value (e.g. a `user` whose targeting
    /// attributes can't be compared). Reserved for the future
    /// targeting-aware evaluator.
    case invalidUserInput = -2

    /// Internal SDK error of unspecified kind. Reserved.
    case unexpectedError = -1

    /// No error — the evaluation succeeded.
    case none = 0

    /// The cached `config_v6.json` body was malformed
    /// (`MALFORMED_CONFIG` / `MALFORMED_VALUE` / `UNSUPPORTED_TYPE`).
    case invalidConfigModel = 1

    /// The customer's `defaultValue: T` had a Swift type that did not
    /// match the setting's `t` tag (`TYPE_MISMATCH`).
    case settingValueTypeMismatch = 2

    /// No config JSON is available — the SDK has not fetched yet and
    /// the cache is empty (`NO_CONFIG`).
    case configJsonNotAvailable = 1000

    /// The requested key is not present in the cached config
    /// (`KEY_NOT_FOUND`).
    case settingKeyMissing = 1001
}

/// Placeholder for a matched targeting rule. The v1 evaluator does not
/// honour targeting rules — every ``EvaluationDetailsBase/matchedTargetingRule``
/// field is always `nil`. A future iteration will populate this when
/// the targeting-aware evaluator lands. Mirrors ConfigCat 11.3.1's
/// `TargetingRule` (`Sources/ConfigCat/Models/ConfigJson.swift`).
public final class TargetingRule: NSObject {
    public override init() {
        super.init()
    }
}

/// Placeholder for a matched percentage option. The v1 evaluator does
/// not honour percentage options — every
/// ``EvaluationDetailsBase/matchedPercentageOption`` field is always
/// `nil`. Mirrors ConfigCat 11.3.1's `PercentageOption`
/// (`Sources/ConfigCat/Models/ConfigJson.swift`).
public final class PercentageOption: NSObject {
    public override init() {
        super.init()
    }
}

/// Common (non-generic) base of every ``EvaluationDetails`` /
/// ``TypedEvaluationDetails`` envelope. Mirrors ConfigCat 11.3.1's
/// `EvaluationDetailsBase` (`Sources/ConfigCat/EvaluationDetails.swift`)
/// 1:1 — same field names, same `@objc` annotations.
///
/// `value` lives on the concrete subclasses (``EvaluationDetails`` for
/// `Any`, ``TypedEvaluationDetails<T>`` for the four widened types)
/// because Swift generics don't bridge to Objective-C.
public class EvaluationDetailsBase: NSObject {
    /// The setting key that was evaluated.
    @objc public let key: String

    /// Variation identifier of the matched setting, when present.
    @objc public let variationId: String?

    /// User passed to the evaluation call. NOT `@objc` because
    /// ``User`` is a Swift `struct` (not bridgeable to ObjC). ObjC
    /// consumers that need to introspect the user pass it back
    /// through the Swift surface; the field is exposed here for the
    /// Swift parity matrix with ConfigCat 11.3.1.
    public let user: User?

    /// `true` when the evaluation fell back to the supplied default
    /// (key missing, malformed config, type mismatch, etc.).
    @objc public let isDefaultValue: Bool

    /// Short SDK-internal error code (e.g. `"KEY_NOT_FOUND"`,
    /// `"TYPE_MISMATCH"`, `"MALFORMED_VALUE"`). `nil` on success.
    @objc public let error: String?

    /// Typed error code mirroring the SDK-internal `error` string.
    /// ``EvaluationErrorCode/none`` on success.
    @objc public let errorCode: EvaluationErrorCode

    /// Timestamp of the most recent successful `refreshOnce` call,
    /// or the unix epoch when the SDK has never fetched.
    @objc public let fetchTime: Date

    /// Matched targeting rule — always `nil` in v1 (the v1 evaluator
    /// does not honour targeting rules).
    @objc public let matchedTargetingRule: TargetingRule?

    /// Matched percentage option — always `nil` in v1.
    @objc public let matchedPercentageOption: PercentageOption?

    /// Designated initialiser. `internal` so the concrete subclasses
    /// (``EvaluationDetails`` / ``TypedEvaluationDetails`` plus the
    /// per-type ObjC boxes in `TypedEvaluationDetailsObjc.swift`)
    /// can chain through; the SDK does not expose this init to
    /// customers — they construct via the concrete subclasses.
    internal init(
        key: String,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date,
        matchedTargetingRule: TargetingRule? = nil,
        matchedPercentageOption: PercentageOption? = nil
    ) {
        // NOTE: Swift forbids `User` being `@objc`-bridged directly
        // (it's a `struct`). We accept the field as `User?` on the
        // Swift surface; the `@objc` annotation on the property is
        // a no-op for the `User` slot in pure-ObjC code but is kept
        // here for parity with ConfigCat 11.3.1's annotation set.
        self.key = key
        self.variationId = variationId
        self.user = user
        self.isDefaultValue = isDefaultValue
        self.error = error
        self.errorCode = errorCode
        self.fetchTime = fetchTime
        self.matchedTargetingRule = matchedTargetingRule
        self.matchedPercentageOption = matchedPercentageOption
        super.init()
    }
}

/// Non-generic public details envelope returned by
/// ``ConfeatureClient/getAllValueDetails(user:)``. Mirrors
/// ConfigCat 11.3.1's `EvaluationDetails` 1:1 — `value: Any` so the
/// envelope works for a heterogeneous map of results.
public final class EvaluationDetails: EvaluationDetailsBase {
    /// Resolved value — one of `Bool` / `String` / `Int` / `Double`
    /// on success, or the supplied default on the error paths.
    @objc public let value: Any

    /// Designated initialiser. Public so the client can build
    /// `EvaluationDetails` from the augmented ``Evaluator/Result``
    /// envelope.
    public init(
        key: String,
        value: Any,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date,
        matchedTargetingRule: TargetingRule? = nil,
        matchedPercentageOption: PercentageOption? = nil
    ) {
        self.value = value
        super.init(
            key: key,
            variationId: variationId,
            user: user,
            isDefaultValue: isDefaultValue,
            error: error,
            errorCode: errorCode,
            fetchTime: fetchTime,
            matchedTargetingRule: matchedTargetingRule,
            matchedPercentageOption: matchedPercentageOption
        )
    }

    /// Builds a fall-back ``EvaluationDetails`` carrying the supplied
    /// default value plus an error code. Used at every evaluator
    /// failure site (`NO_CONFIG`, `KEY_NOT_FOUND`, `TYPE_MISMATCH`,
    /// etc.).
    public static func fromError(
        key: String,
        defaultValue: Any,
        user: User?,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) -> EvaluationDetails {
        EvaluationDetails(
            key: key,
            value: defaultValue,
            variationId: nil,
            user: user,
            isDefaultValue: true,
            error: error,
            errorCode: errorCode,
            fetchTime: fetchTime
        )
    }
}

/// Generic public details envelope returned by
/// ``ConfeatureClient/getValueDetails(forKey:defaultValue:user:)``.
/// Mirrors ConfigCat 11.3.1's `TypedEvaluationDetails<Value>` 1:1.
///
/// The `value` field is NOT `@objc` because Swift generics don't
/// bridge to Objective-C — the per-type ObjC boxes
/// (``StringEvaluationDetails`` / ``BoolEvaluationDetails`` /
/// ``IntEvaluationDetails`` / ``DoubleEvaluationDetails``) provide the
/// typed Objective-C surface (see `TypedEvaluationDetailsObjc.swift`).
public final class TypedEvaluationDetails<T>: EvaluationDetailsBase {
    /// Resolved value — typed.
    public let value: T

    /// Designated initialiser.
    public init(
        key: String,
        value: T,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date,
        matchedTargetingRule: TargetingRule? = nil,
        matchedPercentageOption: PercentageOption? = nil
    ) {
        self.value = value
        super.init(
            key: key,
            variationId: variationId,
            user: user,
            isDefaultValue: isDefaultValue,
            error: error,
            errorCode: errorCode,
            fetchTime: fetchTime,
            matchedTargetingRule: matchedTargetingRule,
            matchedPercentageOption: matchedPercentageOption
        )
    }

    /// Builds a fall-back ``TypedEvaluationDetails`` carrying the
    /// supplied default `value` plus an error code.
    public static func fromError(
        key: String,
        value: T,
        user: User?,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) -> TypedEvaluationDetails<T> {
        TypedEvaluationDetails<T>(
            key: key,
            value: value,
            variationId: nil,
            user: user,
            isDefaultValue: true,
            error: error,
            errorCode: errorCode,
            fetchTime: fetchTime
        )
    }
}
