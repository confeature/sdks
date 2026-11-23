// SPDX-License-Identifier: MIT

import Foundation

@_spi(OpenFeature) public enum CachedEvaluationMatch {
    case unmatched
    case targetingRule
    case percentageOption
}

@_spi(OpenFeature) public struct CachedFlagEvaluation<Value> {
    public let value: Value
    public let variationId: String?
    public let match: CachedEvaluationMatch
    public let errorCode: EvaluationErrorCode

    init(
        value: Value, variationId: String? = nil, match: CachedEvaluationMatch = .unmatched,
        errorCode: EvaluationErrorCode = .none
    ) {
        self.value = value
        self.variationId = variationId
        self.match = match
        self.errorCode = errorCode
    }
}

extension ConfeatureClient {
    /// Resolves current SDK data without substituting the native default user.
    @_spi(OpenFeature) public func evaluateCachedFlag<Value>(
        forKey key: String, defaultValue: Value,
        identifier: String?, email: String?, country: String?, attributes: [String: Any]
    ) -> CachedFlagEvaluation<Value> {
        let snapshot = providerSnapshot()
        guard !snapshot.closed else {
            return CachedFlagEvaluation(value: defaultValue, errorCode: .configJsonNotAvailable)
        }
        let user = providerUser(identifier, email: email, country: country, attributes: attributes)
        let config: [String: Any]?
        if let overrides = snapshot.overrides, overrides.behaviour == .localOnly {
            if let source = overrides.dataSource as? ConfigOverrideDataSource {
                config = source.config
            } else {
                switch OverrideEval.evaluateSyncDetails(
                    overrides: overrides, key: key, defaultValue: nil)
                {
                case .unavailable:
                    return CachedFlagEvaluation(
                        value: defaultValue, errorCode: .configJsonNotAvailable)
                case .failure(let errorCode):
                    return CachedFlagEvaluation(value: defaultValue, errorCode: errorCode)
                case .value(let value):
                    return checkedValue(value, defaultValue: defaultValue)
                }
            }
        } else {
            config = snapshot.config
        }

        let result = Evaluator.evaluateWith(
            config: config, key: key, defaultValue: defaultValue, user: user)
        guard result.errorCode == .none else {
            return CachedFlagEvaluation(value: defaultValue, errorCode: result.errorCode)
        }
        return checkedValue(result.value, defaultValue: defaultValue, result: result)
    }
}

private func providerUser(
    _ identifier: String?, email: String?, country: String?, attributes: [String: Any]
) -> EvalUser? {
    guard identifier != nil || email != nil || country != nil || !attributes.isEmpty else {
        return nil
    }
    return EvalUser(identifier: identifier, email: email, country: country, custom: attributes)
}

private func checkedValue<Value>(
    _ value: Any, defaultValue: Value, result: Evaluator.Result? = nil
) -> CachedFlagEvaluation<Value> {
    guard matchesScalarKind(value, expected: Value.self), let typed = value as? Value else {
        return CachedFlagEvaluation(value: defaultValue, errorCode: .settingValueTypeMismatch)
    }
    if let double = typed as? Double, !double.isFinite {
        return CachedFlagEvaluation(value: defaultValue, errorCode: .invalidConfigModel)
    }
    if let option = result?.matchedPercentageOption {
        return CachedFlagEvaluation(
            value: typed, variationId: option["i"] as? String, match: .percentageOption)
    }
    if let rule = result?.matchedTargetingRule {
        let served = rule["s"] as? [String: Any]
        return CachedFlagEvaluation(
            value: typed, variationId: served?["i"] as? String, match: .targetingRule)
    }
    return CachedFlagEvaluation(value: typed, variationId: result?.variationId)
}

private func matchesScalarKind<Value>(_ value: Any, expected: Value.Type) -> Bool {
    // Foundation can cast one NSNumber to Bool, Int and Double. Require the
    // stored scalar kind so a successful cast cannot change the flag's type.
    if type(of: value) == expected { return true }
    guard let number = value as? NSNumber else { return true }
    let boolean = CFGetTypeID(number) == CFBooleanGetTypeID()
    if expected == Bool.self { return boolean }
    if expected == Int.self { return !boolean && !CFNumberIsFloatType(number) }
    if expected == Double.self { return !boolean && CFNumberIsFloatType(number) }
    return true
}
