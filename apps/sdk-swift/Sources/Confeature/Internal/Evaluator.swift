// SPDX-License-Identifier: MIT

import Foundation

/// Three-valued condition / comparator outcome (research.md §R5): a match, a
/// non-match, or a validation error (e.g. a missing attribute on a typed
/// comparator, bad semver, a detected cycle). An error short-circuits the AND
/// group like `.noMatch` but is surfaced rather than silently swallowed.
enum MatchOutcome {
    case match
    case noMatch
    case validationError(String)
}

/// Internal errors propagated to the fail-closed boundary in
/// ``Evaluator/evaluate(config:key:defaultValue:user:)``. They are NEVER
/// surfaced as a crash — the outer frame converts them into the supplied
/// default + an error code (FR-007, SC-004).
enum EvalError: Error {
    case malformedConfig(String)
    case circularDependency(String)
}

/// ConfigCat-parity flag evaluator. Pure function over a parsed
/// `config_v6.json` body (decoded as `[String: Any]`).
///
/// Ported from `packages/sdk-shared/src/evaluator.ts` (the spec-117 reference,
/// proven byte-for-byte against ConfigCat) + its comparators / hash / semver /
/// segments / prerequisites modules. Fail-closed semantics: every reason a
/// value can't be cleanly resolved returns the supplied default + a tier-0
/// error code; nothing throws out of ``evaluate(config:key:defaultValue:user:)``.
///
/// Resolves all four `SettingType` values
/// (`Bool=0`, `String=1`, `Int=2`, `Double=3`) by selecting the `v` envelope
/// key from the setting's `t` discriminator.
///
/// Tier-0 error codes (preserved exactly, SC-006):
/// - key absent  → `KEY_NOT_FOUND` (`.settingKeyMissing`)
/// - truly unknown `t` → `UNSUPPORTED_TYPE` (`.invalidConfigModel`)
/// - default type mismatch → `TYPE_MISMATCH` (`.settingValueTypeMismatch`)
/// - missing/wrong value slot → `MALFORMED_VALUE` (`.invalidConfigModel`)
/// - config nil → `NO_CONFIG` (`.configJsonNotAvailable`)
/// - malformed config → `MALFORMED_CONFIG` (`.invalidConfigModel`)
enum Evaluator {
    static let settingTypeBool = 0
    static let settingTypeString = 1
    static let settingTypeInt = 2
    static let settingTypeDouble = 3

    /// Result envelope. Customers don't see this — the client consumes it to
    /// populate the public ``EvaluationDetails`` / ``TypedEvaluationDetails``.
    struct Result {
        var value: Any
        var errorCode: EvaluationErrorCode
        var error: String?
        var variationId: String?
        /// Matched targeting rule (the rule's `[String: Any]` dict), when a
        /// rule decided the value.
        var matchedTargetingRule: [String: Any]?
        /// Matched percentage option (the option's `[String: Any]` dict), when
        /// a percentage option decided the value.
        var matchedPercentageOption: [String: Any]?
        /// First condition error surfaced (no-user / missing-attr /
        /// validation) even when a served value was resolved (FR-016). The
        /// `value` is correct; this message is informational.
        var evalError: String?
    }

    /// Per-evaluation mutable state threaded through condition resolution.
    private final class EvalState {
        var errorMessage: String?
        var missingUserObjectLogged = false
    }

    /// Per-evaluation context (research.md §R1).
    private struct EvalContext {
        let key: String
        let setting: [String: Any]
        let settings: [String: Any]
        let segments: [[String: Any]]
        let configSalt: String
        let user: EvalUser?
        let visited: Prerequisites.VisitedFlags
        let state: EvalState
    }

    /// Resolved setting value + matched-rule/option identity.
    private struct SettingResult {
        var valueSlot: [String: Any]?
        var variationId: String?
        var matchedRule: [String: Any]?
        var matchedOption: [String: Any]?
    }

    // MARK: - Public entry points

    /// Evaluates `key` against `config`. NEVER throws — every failure path
    /// returns the supplied `defaultValue`.
    static func evaluate(
        config: [String: Any]?,
        key: String,
        defaultValue: Any,
        user: User? = nil
    ) -> Result {
        evaluateWith(
            config: config, key: key, defaultValue: defaultValue,
            user: user.map(EvalUser.init))
    }

    /// Internal entry point accepting an ``EvalUser`` (typed custom
    /// attributes). The corpus conformance harness uses this directly so it
    /// can feed native number / array / epoch attributes.
    static func evaluateWith(
        config: [String: Any]?,
        key: String,
        defaultValue: Any,
        user: EvalUser?
    ) -> Result {
        guard let cfg = config else {
            return fail(defaultValue, errorCode: .configJsonNotAvailable, error: "NO_CONFIG")
        }
        guard let settings = cfg["f"] as? [String: Any] else {
            return fail(defaultValue, errorCode: .invalidConfigModel, error: "MALFORMED_CONFIG")
        }
        guard let raw = settings[key] else {
            return fail(defaultValue, errorCode: .settingKeyMissing, error: "KEY_NOT_FOUND")
        }
        guard let setting = raw as? [String: Any] else {
            return fail(defaultValue, errorCode: .invalidConfigModel, error: "MALFORMED_CONFIG")
        }
        guard let typeTag = readInt(setting["t"]) else {
            return fail(defaultValue, errorCode: .invalidConfigModel, error: "MALFORMED_CONFIG")
        }

        // Type guard — the default's Swift type must match the setting's `t`,
        // unless the default is `NSNull` (the getAll* probe path bypasses it).
        let isNullDefault = defaultValue is NSNull
        let settingVariationId = setting["i"] as? String
        if !isNullDefault {
            if let mismatch = typeMismatch(typeTag: typeTag, defaultValue: defaultValue) {
                return fail(
                    defaultValue, errorCode: mismatch.0, error: mismatch.1,
                    variationId: settingVariationId)
            }
        }

        guard
            typeTag == settingTypeBool || typeTag == settingTypeString
                || typeTag == settingTypeInt || typeTag == settingTypeDouble
        else {
            return fail(
                defaultValue, errorCode: .invalidConfigModel, error: "UNSUPPORTED_TYPE",
                variationId: nil)
        }

        // Evaluation core — resolve the setting to a `v` envelope + matched
        // identity, inside the fail-closed boundary.
        let state = EvalState()
        let ctx = EvalContext(
            key: key,
            setting: setting,
            settings: settings,
            segments: cfg["s"] as? [[String: Any]] ?? [],
            configSalt: (cfg["p"] as? [String: Any])?["s"] as? String ?? "",
            user: user,
            visited: Prerequisites.VisitedFlags(),
            state: state)

        let resolved: SettingResult
        do {
            resolved = try evaluateSetting(ctx)
        } catch {
            return fail(
                defaultValue, errorCode: .unexpectedError, error: "EVAL_ERROR",
                variationId: settingVariationId)
        }

        // Select the typed value from the resolved envelope by `t`.
        guard let typed = selectTyped(resolved.valueSlot, typeTag: typeTag) else {
            return fail(
                defaultValue, errorCode: .invalidConfigModel,
                error: typeTag == settingTypeBool ? "VALUE_NOT_BOOL" : "MALFORMED_VALUE",
                variationId: resolved.variationId ?? settingVariationId)
        }

        return Result(
            value: typed,
            errorCode: .none,
            error: nil,
            variationId: resolved.variationId ?? settingVariationId,
            matchedTargetingRule: resolved.matchedRule,
            matchedPercentageOption: resolved.matchedOption,
            evalError: state.errorMessage)
    }

    // MARK: - Evaluation core

    private static func evaluateSetting(_ ctx: EvalContext) throws -> SettingResult {
        let setting = ctx.setting

        // 1. Targeting rules — first-match-wins.
        if let rules = setting["r"] as? [[String: Any]], !rules.isEmpty {
            if let ruleResult = try evaluateTargetingRules(rules, ctx) {
                return ruleResult
            }
        }

        // 2. Setting-level percentage options.
        if let options = setting["p"] as? [[String: Any]], !options.isEmpty {
            if let optionResult = try evaluatePercentageOptions(options, matchedRule: nil, ctx: ctx)
            {
                return optionResult
            }
        }

        // 3. Served fallback `setting.v`.
        return SettingResult(
            valueSlot: setting["v"] as? [String: Any],
            variationId: setting["i"] as? String)
    }

    private static func evaluateTargetingRules(
        _ rules: [[String: Any]], _ ctx: EvalContext
    ) throws -> SettingResult? {
        for rule in rules {
            let conditions = rule["c"] as? [[String: Any]] ?? []
            let outcome = try evaluateConditions(conditions, contextSalt: ctx.key, ctx: ctx)
            guard case .match = outcome else { continue }

            // A rule serves either a fixed value (`s`) or percentage options (`p`).
            if let served = rule["s"] as? [String: Any] {
                return SettingResult(
                    valueSlot: served["v"] as? [String: Any],
                    variationId: served["i"] as? String,
                    matchedRule: rule)
            }
            let options = rule["p"] as? [[String: Any]] ?? []
            if let optionResult = try evaluatePercentageOptions(
                options, matchedRule: rule, ctx: ctx)
            {
                return optionResult
            }
            // % options weren't resolvable → ignore the rule, continue.
        }
        return nil
    }

    private static func evaluatePercentageOptions(
        _ options: [[String: Any]], matchedRule: [String: Any]?, ctx: EvalContext
    ) throws -> SettingResult? {
        guard let user = ctx.user else {
            surfaceMissingUser(ctx)
            return nil
        }

        let attrName: String
        let attrValue: Any?
        if let a = ctx.setting["a"] as? String {
            attrName = a
            attrValue = user.attribute(a)
        } else {
            attrName = "Identifier"
            attrValue = user.identifier
        }
        guard let attrValue, !(attrValue is NSNull) else {
            if ctx.state.errorMessage == nil {
                ctx.state.errorMessage = missingUserAttributeError(attrName)
            }
            return nil
        }

        let hashValue = Hashing.percentageBucket(
            key: ctx.key, attrValue: Comparators.userAttributeValueToString(attrValue))

        var bucket = 0
        for option in options {
            bucket += readInt(option["p"]) ?? 0
            if hashValue >= bucket { continue }
            return SettingResult(
                valueSlot: option["v"] as? [String: Any],
                variationId: option["i"] as? String,
                matchedRule: matchedRule,
                matchedOption: option)
        }
        // Sum of widths < 100 — a malformed config; throw to the fail-closed
        // frame (common-js throws here too).
        throw EvalError.malformedConfig("Sum of percentage option percentages is less than 100.")
    }

    private static func evaluateConditions(
        _ conditions: [[String: Any]], contextSalt: String, ctx: EvalContext
    ) throws -> MatchOutcome {
        var result: MatchOutcome = .match
        for condition in conditions {
            if let u = condition["u"] as? [String: Any] {
                result = evaluateUserCondition(u, contextSalt: contextSalt, ctx: ctx)
            } else if let p = condition["p"] as? [String: Any] {
                result = try evaluatePrerequisiteCondition(p, ctx: ctx)
            } else if let s = condition["s"] as? [String: Any] {
                result = try evaluateSegmentCondition(s, ctx: ctx)
            } else {
                result = .validationError("empty condition")
            }
            if case .match = result { continue }
            break
        }
        return result
    }

    private static func evaluateUserCondition(
        _ condition: [String: Any], contextSalt: String, ctx: EvalContext
    ) -> MatchOutcome {
        guard let user = ctx.user else {
            surfaceMissingUser(ctx)
            return .validationError(missingUserObjectError)
        }

        guard let attrName = condition["a"] as? String else {
            return .validationError("missing attribute name")
        }
        let attrValueOpt = user.attribute(attrName)
        let isMissing: Bool
        if let attrValueOpt, !(attrValueOpt is NSNull) {
            if let s = attrValueOpt as? String, s.isEmpty {
                isMissing = true
            } else {
                isMissing = false
            }
        } else {
            isMissing = true
        }
        if isMissing {
            let msg = missingUserAttributeError(attrName)
            if ctx.state.errorMessage == nil { ctx.state.errorMessage = msg }
            return .validationError(msg)
        }
        let attrValue = attrValueOpt!

        let configSalt = ctx.configSalt
        let cmp = readInt(condition["c"]) ?? -1
        let list = (condition["l"] as? [String]) ?? stringList(condition["l"])
        let sv = condition["s"] as? String ?? ""
        let dv = readDouble(condition["d"]) ?? 0

        switch cmp {
        case Comparators.textEquals, Comparators.textNotEquals:
            return Comparators.evaluateTextEquals(
                Comparators.attributeAsText(attrValue), sv, negate: cmp == Comparators.textNotEquals
            )
        case Comparators.sensitiveTextEquals, Comparators.sensitiveTextNotEquals:
            return Comparators.evaluateSensitiveTextEquals(
                Comparators.attributeAsText(attrValue), sv, configSalt: configSalt,
                contextSalt: contextSalt, negate: cmp == Comparators.sensitiveTextNotEquals)
        case Comparators.textIsOneOf, Comparators.textIsNotOneOf:
            return Comparators.evaluateTextIsOneOf(
                Comparators.attributeAsText(attrValue), list,
                negate: cmp == Comparators.textIsNotOneOf)
        case Comparators.sensitiveTextIsOneOf, Comparators.sensitiveTextIsNotOneOf:
            return Comparators.evaluateSensitiveTextIsOneOf(
                Comparators.attributeAsText(attrValue), list, configSalt: configSalt,
                contextSalt: contextSalt, negate: cmp == Comparators.sensitiveTextIsNotOneOf)
        case Comparators.textStartsWithAnyOf, Comparators.textNotStartsWithAnyOf:
            return Comparators.evaluateTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue), list, startsWith: true,
                negate: cmp == Comparators.textNotStartsWithAnyOf)
        case Comparators.sensitiveTextStartsWithAnyOf, Comparators.sensitiveTextNotStartsWithAnyOf:
            return Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue), list, configSalt: configSalt,
                contextSalt: contextSalt, startsWith: true,
                negate: cmp == Comparators.sensitiveTextNotStartsWithAnyOf)
        case Comparators.textEndsWithAnyOf, Comparators.textNotEndsWithAnyOf:
            return Comparators.evaluateTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue), list, startsWith: false,
                negate: cmp == Comparators.textNotEndsWithAnyOf)
        case Comparators.sensitiveTextEndsWithAnyOf, Comparators.sensitiveTextNotEndsWithAnyOf:
            return Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue), list, configSalt: configSalt,
                contextSalt: contextSalt, startsWith: false,
                negate: cmp == Comparators.sensitiveTextNotEndsWithAnyOf)
        case Comparators.textContainsAnyOf, Comparators.textNotContainsAnyOf:
            return Comparators.evaluateTextContainsAnyOf(
                Comparators.attributeAsText(attrValue), list,
                negate: cmp == Comparators.textNotContainsAnyOf)
        case Comparators.semVerIsOneOf, Comparators.semVerIsNotOneOf:
            switch Comparators.attributeAsSemVer(attrName, attrValue) {
            case .ok(let v):
                return Comparators.evaluateSemVerIsOneOf(
                    v, list, negate: cmp == Comparators.semVerIsNotOneOf)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        case Comparators.semVerLess, Comparators.semVerLessOrEquals, Comparators.semVerGreater,
            Comparators.semVerGreaterOrEquals:
            switch Comparators.attributeAsSemVer(attrName, attrValue) {
            case .ok(let v):
                return Comparators.evaluateSemVerRelation(v, comparator: cmp, comparisonValue: sv)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        case Comparators.numberEquals, Comparators.numberNotEquals, Comparators.numberLess,
            Comparators.numberLessOrEquals, Comparators.numberGreater,
            Comparators.numberGreaterOrEquals:
            switch Comparators.attributeAsNumber(attrName, attrValue) {
            case .ok(let n):
                return Comparators.evaluateNumberRelation(n, comparator: cmp, comparisonValue: dv)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        case Comparators.dateTimeBefore, Comparators.dateTimeAfter:
            switch Comparators.attributeAsUnixTimeSeconds(attrName, attrValue) {
            case .ok(let n):
                return Comparators.evaluateDateTimeRelation(
                    n, comparisonValue: dv, before: cmp == Comparators.dateTimeBefore)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        case Comparators.arrayContainsAnyOf, Comparators.arrayNotContainsAnyOf:
            switch Comparators.attributeAsStringArray(attrName, attrValue) {
            case .ok(let arr):
                return Comparators.evaluateArrayContainsAnyOf(
                    arr, list, negate: cmp == Comparators.arrayNotContainsAnyOf)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        case Comparators.sensitiveArrayContainsAnyOf, Comparators.sensitiveArrayNotContainsAnyOf:
            switch Comparators.attributeAsStringArray(attrName, attrValue) {
            case .ok(let arr):
                return Comparators.evaluateSensitiveArrayContainsAnyOf(
                    arr, list, configSalt: configSalt, contextSalt: contextSalt,
                    negate: cmp == Comparators.sensitiveArrayNotContainsAnyOf)
            case .error(let e):
                return surfaceError(e, ctx)
            }
        default:
            return .validationError("unknown comparator \(cmp)")
        }
    }

    private static func evaluatePrerequisiteCondition(
        _ condition: [String: Any], ctx: EvalContext
    ) throws -> MatchOutcome {
        try Prerequisites.evaluate(
            condition: condition,
            currentKey: ctx.key,
            visited: ctx.visited,
            prereqType: { key in
                (ctx.settings[key] as? [String: Any]).flatMap { readInt($0["t"]) }
            },
            evaluatePrereqFlag: { key in
                guard let prereqSetting = ctx.settings[key] as? [String: Any] else {
                    throw EvalError.malformedConfig("Prerequisite flag is missing or invalid.")
                }
                let childCtx = EvalContext(
                    key: key,
                    setting: prereqSetting,
                    settings: ctx.settings,
                    segments: ctx.segments,
                    configSalt: ctx.configSalt,
                    user: ctx.user,
                    visited: ctx.visited,
                    state: ctx.state)
                return try evaluateSetting(childCtx).valueSlot ?? [:]
            },
            selectValue: { valueSlot, type in selectTyped(valueSlot, typeTag: type) })
    }

    private static func evaluateSegmentCondition(
        _ condition: [String: Any], ctx: EvalContext
    ) throws -> MatchOutcome {
        try Segments.evaluate(
            condition: condition,
            segments: ctx.segments,
            hasUser: ctx.user != nil,
            surfaceMissingUser: {
                surfaceMissingUser(ctx)
                return missingUserObjectError
            },
            evaluateUserCondition: { uc, salt in
                evaluateUserCondition(uc, contextSalt: salt, ctx: ctx)
            })
    }

    // MARK: - Helpers

    private static var missingUserObjectError: String {
        "cannot evaluate, User Object is missing"
    }

    private static func missingUserAttributeError(_ attr: String) -> String {
        "cannot evaluate, the User.\(attr) attribute is missing"
    }

    private static func surfaceMissingUser(_ ctx: EvalContext) {
        if ctx.state.errorMessage == nil { ctx.state.errorMessage = missingUserObjectError }
        ctx.state.missingUserObjectLogged = true
    }

    private static func surfaceError(_ message: String, _ ctx: EvalContext) -> MatchOutcome {
        if ctx.state.errorMessage == nil { ctx.state.errorMessage = message }
        return .validationError(message)
    }

    /// Type guard mirroring the original tier-0 logic. Returns `nil` when the
    /// default is type-compatible with `typeTag`, else the
    /// (errorCode, errorString) for the mismatch.
    private static func typeMismatch(
        typeTag: Int, defaultValue: Any
    )
        -> (EvaluationErrorCode, String)?
    {
        switch typeTag {
        case settingTypeBool:
            if !(defaultValue is Bool) { return (.settingValueTypeMismatch, "TYPE_MISMATCH") }
        case settingTypeString:
            if !(defaultValue is String) { return (.settingValueTypeMismatch, "TYPE_MISMATCH") }
        case settingTypeInt:
            if defaultValue is Bool || !(defaultValue is Int) {
                return (.settingValueTypeMismatch, "TYPE_MISMATCH")
            }
        case settingTypeDouble:
            if !(defaultValue is Double) { return (.settingValueTypeMismatch, "TYPE_MISMATCH") }
        default:
            break
        }
        return nil
    }

    /// Select the typed Swift value from a `v` envelope by `t` — a present
    /// zero-value (`""`, `0`, `false`) is a real value; only an absent /
    /// wrong-typed slot is "missing".
    private static func selectTyped(_ valueSlot: [String: Any]?, typeTag: Int) -> Any? {
        guard let valueSlot else { return nil }
        switch typeTag {
        case settingTypeBool: return valueSlot["b"] as? Bool
        case settingTypeString: return valueSlot["s"] as? String
        case settingTypeInt: return readInt(valueSlot["i"])
        case settingTypeDouble: return readDouble(valueSlot["d"])
        default: return nil
        }
    }

    /// Equality used by the prerequisite-flag comparator (Bool / String / Int
    /// / Double). Two `nil`s are equal; numerics compare numerically.
    static func anyEqual(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (nil, _), (_, nil): return false
        default: break
        }
        if let x = a as? Bool, let y = b as? Bool { return x == y }
        if let x = a as? String, let y = b as? String { return x == y }
        // Avoid Bool↔number confusion: only compare numerically when neither
        // is a Bool.
        if !(a is Bool) && !(b is Bool),
            let x = Comparators.asDouble(a!), let y = Comparators.asDouble(b!)
        {
            return x == y
        }
        return false
    }

    private static func fail(
        _ defaultValue: Any,
        errorCode: EvaluationErrorCode,
        error: String?,
        variationId: String? = nil
    ) -> Result {
        Result(value: defaultValue, errorCode: errorCode, error: error, variationId: variationId)
    }

    private static func stringList(_ value: Any?) -> [String] {
        if let arr = value as? [Any] { return arr.compactMap { $0 as? String } }
        return []
    }

    /// Reads an `Int` out of an `Any` tolerantly: accepts integer and float
    /// encodings (`JSONSerialization` may decode integer literals as either).
    static func readInt(_ value: Any?) -> Int? {
        guard let value else { return nil }
        if let n = value as? Int { return n }
        if let n = value as? Int64 { return Int(n) }
        if let n = value as? Double, n.isFinite { return Int(n) }
        if let n = value as? NSNumber { return n.intValue }
        return nil
    }

    /// Reads a `Double` out of an `Any` tolerantly.
    static func readDouble(_ value: Any?) -> Double? {
        guard let value else { return nil }
        if let n = value as? Double, n.isFinite { return n }
        if let n = value as? Float, n.isFinite { return Double(n) }
        if let n = value as? Int { return Double(n) }
        if let n = value as? Int64 { return Double(n) }
        if let n = value as? NSNumber { return n.doubleValue }
        return nil
    }
}
