// SPDX-License-Identifier: MIT

import Foundation

// MARK: - Per-type ObjC EvaluationDetails boxes
//
// Mirror ConfigCat 11.3.1's `StringEvaluationDetails` /
// `BoolEvaluationDetails` / `IntEvaluationDetails` /
// `DoubleEvaluationDetails`
// (`Sources/ConfigCat/EvaluationDetails.swift:130-180`).
//
// Why these exist: Swift generics don't bridge to Objective-C, so
// `TypedEvaluationDetails<T>` is invisible from ObjC. The four
// concrete subclasses encode the type at the class-identity level —
// `StringEvaluationDetails.value` is `String` (not `Any`), so ObjC
// completion handlers carry typed values.
//
// Each subclass exposes a `static fromTyped(_:)` adapter so the 10
// typed ObjC bridges on ``ConfeatureClient`` / ``Snapshot`` can
// convert from the generic Swift envelope into the concrete ObjC box.

/// ObjC-facing typed details for `String` settings.
@objc public final class StringEvaluationDetails: EvaluationDetailsBase {
    /// Resolved value.
    @objc public let value: String

    /// Designated initialiser. NOT `@objc` because ``User`` is a
    /// Swift struct; ObjC consumers construct via the
    /// ``fromTyped(_:)`` static adapters.
    public init(
        key: String,
        value: String,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) {
        self.value = value
        super.init(
            key: key, variationId: variationId, user: user,
            isDefaultValue: isDefaultValue, error: error,
            errorCode: errorCode, fetchTime: fetchTime
        )
    }

    /// Builds a `StringEvaluationDetails` from a generic
    /// ``TypedEvaluationDetails<String>``. Copies every inherited
    /// field verbatim.
    public static func fromTyped(_ typed: TypedEvaluationDetails<String>) -> StringEvaluationDetails
    {
        StringEvaluationDetails(
            key: typed.key,
            value: typed.value,
            variationId: typed.variationId,
            user: typed.user,
            isDefaultValue: typed.isDefaultValue,
            error: typed.error,
            errorCode: typed.errorCode,
            fetchTime: typed.fetchTime
        )
    }
}

/// ObjC-facing typed details for `Bool` settings.
@objc public final class BoolEvaluationDetails: EvaluationDetailsBase {
    /// Resolved value.
    @objc public let value: Bool

    /// Designated initialiser. NOT `@objc` because ``User`` is a
    /// Swift struct; ObjC consumers construct via the
    /// ``fromTyped(_:)`` static adapters.
    public init(
        key: String,
        value: Bool,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) {
        self.value = value
        super.init(
            key: key, variationId: variationId, user: user,
            isDefaultValue: isDefaultValue, error: error,
            errorCode: errorCode, fetchTime: fetchTime
        )
    }

    public static func fromTyped(_ typed: TypedEvaluationDetails<Bool>) -> BoolEvaluationDetails {
        BoolEvaluationDetails(
            key: typed.key,
            value: typed.value,
            variationId: typed.variationId,
            user: typed.user,
            isDefaultValue: typed.isDefaultValue,
            error: typed.error,
            errorCode: typed.errorCode,
            fetchTime: typed.fetchTime
        )
    }
}

/// ObjC-facing typed details for `Int` settings.
@objc public final class IntEvaluationDetails: EvaluationDetailsBase {
    /// Resolved value.
    @objc public let value: Int

    /// Designated initialiser. NOT `@objc` because ``User`` is a
    /// Swift struct; ObjC consumers construct via the
    /// ``fromTyped(_:)`` static adapters.
    public init(
        key: String,
        value: Int,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) {
        self.value = value
        super.init(
            key: key, variationId: variationId, user: user,
            isDefaultValue: isDefaultValue, error: error,
            errorCode: errorCode, fetchTime: fetchTime
        )
    }

    public static func fromTyped(_ typed: TypedEvaluationDetails<Int>) -> IntEvaluationDetails {
        IntEvaluationDetails(
            key: typed.key,
            value: typed.value,
            variationId: typed.variationId,
            user: typed.user,
            isDefaultValue: typed.isDefaultValue,
            error: typed.error,
            errorCode: typed.errorCode,
            fetchTime: typed.fetchTime
        )
    }
}

/// ObjC-facing typed details for `Double` settings.
@objc public final class DoubleEvaluationDetails: EvaluationDetailsBase {
    /// Resolved value.
    @objc public let value: Double

    /// Designated initialiser. NOT `@objc` because ``User`` is a
    /// Swift struct; ObjC consumers construct via the
    /// ``fromTyped(_:)`` static adapters.
    public init(
        key: String,
        value: Double,
        variationId: String?,
        user: User?,
        isDefaultValue: Bool,
        error: String?,
        errorCode: EvaluationErrorCode,
        fetchTime: Date
    ) {
        self.value = value
        super.init(
            key: key, variationId: variationId, user: user,
            isDefaultValue: isDefaultValue, error: error,
            errorCode: errorCode, fetchTime: fetchTime
        )
    }

    public static func fromTyped(_ typed: TypedEvaluationDetails<Double>) -> DoubleEvaluationDetails
    {
        DoubleEvaluationDetails(
            key: typed.key,
            value: typed.value,
            variationId: typed.variationId,
            user: typed.user,
            isDefaultValue: typed.isDefaultValue,
            error: typed.error,
            errorCode: typed.errorCode,
            fetchTime: typed.fetchTime
        )
    }
}
