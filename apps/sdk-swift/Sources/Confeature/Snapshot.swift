// SPDX-License-Identifier: MIT

import Foundation

/// Detached, immutable view over the last successfully-fetched
/// `config_v6.json` body + a reference to the flag-override bundle.
/// Construct via ``ConfeatureClient/snapshot()``.
///
/// ``getValue(forKey:defaultValue:user:)`` consults overrides FIRST
/// via the 7-branch decision tree, then falls through to the cached
/// config. All methods are synchronous and safe to call after the
/// source client has been closed.
///
/// Inherits `NSObject` (spec 073) for parity with ConfigCat 11.3.1's
/// `ConfigCatClientSnapshot: NSObject` and to enable the typed ObjC
/// bridge methods (FR-028).
public final class Snapshot: NSObject {
    private let config: [String: Any]?
    private let overrides: FlagOverrides?
    private let defaultUser: User?

    init(config: [String: Any]?, overrides: FlagOverrides?, defaultUser: User?) {
        self.config = config
        self.overrides = overrides
        self.defaultUser = defaultUser
        super.init()
    }

    /// Resolves `key` against the snapshot. Honours overrides
    /// synchronously before falling through to the cached config.
    ///
    /// Generic parameter `T` is the concrete Swift type the customer
    /// expects — one of ``Bool``, ``String``, ``Int``, or ``Double``
    /// for the v1 four-type evaluator. If the resolved value is not
    /// bridgeable to `T`, the supplied `defaultValue` is returned.
    public func getValue<T>(forKey key: String, defaultValue: T, user: User? = nil) -> T {
        let resolved = resolve(key: key, defaultValue: defaultValue, user: user)
        if let typed = resolved as? T {
            return typed
        }
        return defaultValue
    }

    /// Resolves `key` and returns the full
    /// ``TypedEvaluationDetails<T>`` envelope.
    public func getValueDetails<T>(
        forKey key: String, defaultValue: T, user: User? = nil,
        fetchTime: Date = Date(timeIntervalSince1970: 0)
    ) -> TypedEvaluationDetails<T> {
        let effectiveUser = user ?? defaultUser
        // Full-config override path FIRST (spec 152 / #475, US2): a
        // ``ConfigOverrideDataSource`` carries the whole `{p, f, s}`
        // config and resolves targeting rules / % options through the
        // real evaluator — which produces a `variationId`. The flat-map
        // `evaluateSync` path below hard-codes `variationId: nil`, so a
        // rule-bearing override would lose its variationId (the #395 gap
        // class). Route full-config overrides through the evaluator so
        // `details.variationId` propagates, exactly as the cache path
        // does.
        if let overrides, overrides.behaviour == .localOnly,
            let source = overrides.dataSource as? ConfigOverrideDataSource
        {
            let result = Evaluator.evaluate(
                config: source.config, key: key, defaultValue: defaultValue,
                user: effectiveUser)
            if let typed = result.value as? T, result.error == nil {
                return TypedEvaluationDetails<T>(
                    key: key, value: typed, variationId: result.variationId,
                    user: effectiveUser, isDefaultValue: false, error: nil,
                    errorCode: .none, fetchTime: fetchTime,
                    matchedTargetingRule: result.matchedTargetingRule.map { _ in
                        TargetingRule()
                    },
                    matchedPercentageOption: result.matchedPercentageOption.map { _ in
                        PercentageOption()
                    })
            }
            return TypedEvaluationDetails<T>(
                key: key, value: defaultValue, variationId: result.variationId,
                user: effectiveUser, isDefaultValue: true, error: result.error,
                errorCode: result.errorCode, fetchTime: fetchTime)
        }
        // Override path first (matches `resolve(...)`). For LocalOnly,
        // OverrideEval may return (true, defaultValue) for branches
        // 4/5/6 (key-absent / NSNull / type-mismatch) — those still
        // count as `isDefaultValue: true`. Detect those via the
        // override map: a key truly present + same-kind goes via
        // branch 7 which returns the candidate (not the default).
        let (handled, overrideValue) = OverrideEval.evaluateSync(
            overrides: overrides, key: key, defaultValue: defaultValue)
        if handled {
            let map = overrides?.dataSource.getOverridesSync()
            let realCandidate = map?[key]
            let isHappyPath = realCandidate != nil && !(realCandidate is NSNull)
            if let typed = overrideValue as? T, isHappyPath {
                return TypedEvaluationDetails<T>(
                    key: key, value: typed, variationId: nil, user: effectiveUser,
                    isDefaultValue: false, error: nil, errorCode: .none,
                    fetchTime: fetchTime)
            }
            // LocalOnly fall-throughs: key absent / NSNull / type
            // mismatch — return the default with the right code.
            let errorCode: EvaluationErrorCode
            let errorString: String?
            if realCandidate == nil {
                errorCode = .settingKeyMissing
                errorString = "KEY_NOT_FOUND"
            } else if realCandidate is NSNull {
                errorCode = .invalidConfigModel
                errorString = "MALFORMED_VALUE"
            } else {
                errorCode = .settingValueTypeMismatch
                errorString = "TYPE_MISMATCH"
            }
            return TypedEvaluationDetails<T>.fromError(
                key: key, value: defaultValue, user: effectiveUser,
                error: errorString, errorCode: errorCode,
                fetchTime: fetchTime)
        }
        let result = Evaluator.evaluate(
            config: config, key: key, defaultValue: defaultValue, user: effectiveUser)
        if let typed = result.value as? T, result.error == nil {
            return TypedEvaluationDetails<T>(
                key: key, value: typed, variationId: result.variationId,
                user: effectiveUser, isDefaultValue: false, error: nil,
                errorCode: .none, fetchTime: fetchTime,
                matchedTargetingRule: result.matchedTargetingRule.map { _ in TargetingRule() },
                matchedPercentageOption: result.matchedPercentageOption.map { _ in
                    PercentageOption()
                })
        }
        return TypedEvaluationDetails<T>(
            key: key, value: defaultValue, variationId: result.variationId,
            user: effectiveUser, isDefaultValue: true, error: result.error,
            errorCode: result.errorCode, fetchTime: fetchTime)
    }

    /// Returns the full ``EvaluationDetails`` envelope for every key
    /// present in the cache + override map.
    public func getAllValueDetails(
        user: User? = nil, fetchTime: Date = Date(timeIntervalSince1970: 0)
    ) -> [EvaluationDetails] {
        let effectiveUser = user ?? defaultUser
        var seen = Set<String>()
        var details: [EvaluationDetails] = []
        if let settings = config?["f"] as? [String: Any] {
            for key in settings.keys.sorted() {
                seen.insert(key)
                details.append(
                    makeAnyDetails(
                        key: key, user: effectiveUser, fetchTime: fetchTime))
            }
        }
        if let map = overrides?.dataSource.getOverridesSync() {
            for key in map.keys.sorted() where !seen.contains(key) {
                seen.insert(key)
                details.append(
                    makeAnyDetails(
                        key: key, user: effectiveUser, fetchTime: fetchTime))
            }
        }
        return details
    }

    /// Returns every key/value present in the cache + override map.
    /// Values are `Any` because each setting may have a different
    /// type. Keys that fail to resolve (e.g. malformed value slot)
    /// are skipped.
    public func getAllValues(user: User? = nil) -> [String: Any] {
        let effectiveUser = user ?? defaultUser
        var out: [String: Any] = [:]
        if let settings = config?["f"] as? [String: Any] {
            for key in settings.keys {
                let result = Evaluator.evaluate(
                    config: config, key: key, defaultValue: NSNull(), user: effectiveUser)
                if result.error == nil {
                    out[key] = result.value
                }
            }
        }
        if let map = overrides?.dataSource.getOverridesSync() {
            for (key, value) in map where out[key] == nil {
                out[key] = value
            }
        }
        return out
    }

    /// Returns the union of keys present in the cached config + the
    /// override map. Sorted ascending for deterministic test output.
    @objc public func getAllKeys() -> [String] {
        var seen = Set<String>()
        if let settings = config?["f"] as? [String: Any] {
            for key in settings.keys {
                seen.insert(key)
            }
        }
        if let map = overrides?.dataSource.getOverridesSync() {
            for key in map.keys {
                seen.insert(key)
            }
        }
        return seen.sorted()
    }

    /// Looks up the `KeyValue` whose setting has the given
    /// `variationId`. Returns `nil` if no setting matches. v1 only
    /// scans top-level setting identifiers — does NOT iterate
    /// targeting rules or percentage options.
    @objc public func getKeyAndValue(for variationId: String) -> KeyValue? {
        guard let settings = config?["f"] as? [String: Any] else { return nil }
        for (key, raw) in settings {
            guard let setting = raw as? [String: Any] else { continue }
            guard let id = setting["i"] as? String, id == variationId else {
                continue
            }
            // Direct value lookup keyed on `t` — we don't have a
            // customer-supplied default to pass to the evaluator so
            // we read the value slot directly and skip the
            // type-mismatch arm. Mirrors ConfigCat 11.3.1's
            // `getKeyAndValue` which also bypasses the typed default
            // check in this path.
            guard let valueSlot = setting["v"] as? [String: Any] else { continue }
            guard let typeTag = setting["t"] as? Int else { continue }
            let resolved: Any?
            switch typeTag {
            case 0: resolved = valueSlot["b"] as? Bool
            case 1: resolved = valueSlot["s"] as? String
            case 2: resolved = valueSlot["i"] as? Int
            case 3: resolved = valueSlot["d"] as? Double
            default: resolved = nil
            }
            if let value = resolved {
                return KeyValue(key: key, value: value)
            }
        }
        return nil
    }

    func resolve(key: String, defaultValue: Any, user: User?) -> Any {
        // Override path FIRST — every other SDK does the same
        // (spec-036 correctness). Route through the full-config-aware
        // router (spec 135 / #435): a rule-bearing
        // ``ConfigOverrideDataSource`` resolves targeting rules through
        // the real evaluator (user threaded); the flat-map source keeps
        // the byte-identical value-only path.
        let effectiveUser = user ?? defaultUser
        let (handled, value) = OverrideEval.evaluate(
            overrides: overrides, key: key, defaultValue: defaultValue, user: effectiveUser)
        if handled {
            return value ?? defaultValue
        }
        let result = Evaluator.evaluate(
            config: config, key: key, defaultValue: defaultValue, user: effectiveUser)
        return result.value
    }

    /// Builds an ``EvaluationDetails`` for a single key by resolving
    /// the override path then the evaluator path, using `NSNull()`
    /// as a placeholder default so a `TYPE_MISMATCH` does not fire.
    private func makeAnyDetails(
        key: String, user: User?, fetchTime: Date
    ) -> EvaluationDetails {
        let (handled, value) = OverrideEval.evaluateSync(
            overrides: overrides, key: key, defaultValue: NSNull())
        if handled {
            return EvaluationDetails(
                key: key, value: value ?? NSNull(), variationId: nil,
                user: user, isDefaultValue: false, error: nil,
                errorCode: .none, fetchTime: fetchTime)
        }
        let result = Evaluator.evaluate(
            config: config, key: key, defaultValue: NSNull(), user: user)
        return EvaluationDetails(
            key: key, value: result.value,
            variationId: result.variationId, user: user,
            isDefaultValue: result.error != nil,
            error: result.error, errorCode: result.errorCode,
            fetchTime: fetchTime,
            matchedTargetingRule: result.matchedTargetingRule.map { _ in TargetingRule() },
            matchedPercentageOption: result.matchedPercentageOption.map { _ in PercentageOption() })
    }
}

// MARK: - Objective-C bridge surface (spec 073 / FR-028)
//
// Per-type synchronous ObjC bridges that wrap the generic
// `getValue<T>` / `getValueDetails<T>` into a non-generic shape ObjC
// consumers can call. Mirror ConfigCat 11.3.1's typed bridges on
// `ConfigCatClientSnapshot` in `Sources/ConfigCat/Extensions.swift`.
//
// Snapshot's bridges are synchronous (no completion handler) — the
// underlying `getValue<T>` / `getValueDetails<T>` are already sync.
//
// The `user:` parameter is ``ConfeatureUser?`` — the ObjC bridge
// wrapper over the Swift ``User`` struct. Each bridge converts to
// the internal `User?` via ``ConfeatureUser/coreUser`` before the
// evaluator call.

extension Snapshot {
    /// ObjC bridge for `getValue<String>`.
    @objc public func getStringValue(
        for key: String, defaultValue: String, user: ConfeatureUser? = nil
    ) -> String {
        self.getValue(forKey: key, defaultValue: defaultValue, user: user?.coreUser)
    }

    /// ObjC bridge for `getValue<Int>`.
    @objc public func getIntValue(
        for key: String, defaultValue: Int, user: ConfeatureUser? = nil
    ) -> Int {
        self.getValue(forKey: key, defaultValue: defaultValue, user: user?.coreUser)
    }

    /// ObjC bridge for `getValue<Double>`.
    @objc public func getDoubleValue(
        for key: String, defaultValue: Double, user: ConfeatureUser? = nil
    ) -> Double {
        self.getValue(forKey: key, defaultValue: defaultValue, user: user?.coreUser)
    }

    /// ObjC bridge for `getValue<Bool>`.
    @objc public func getBoolValue(
        for key: String, defaultValue: Bool, user: ConfeatureUser? = nil
    ) -> Bool {
        self.getValue(forKey: key, defaultValue: defaultValue, user: user?.coreUser)
    }

    /// ObjC bridge for `getValue<Any>`.
    @objc public func getAnyValue(
        for key: String, defaultValue: Any, user: ConfeatureUser? = nil
    ) -> Any {
        self.getValue(forKey: key, defaultValue: defaultValue, user: user?.coreUser)
    }

    /// ObjC bridge for `getValueDetails<String>`.
    @objc public func getStringValueDetails(
        for key: String, defaultValue: String, user: ConfeatureUser? = nil
    ) -> StringEvaluationDetails {
        let typed: TypedEvaluationDetails<String> = self.getValueDetails(
            forKey: key, defaultValue: defaultValue, user: user?.coreUser)
        return StringEvaluationDetails.fromTyped(typed)
    }

    /// ObjC bridge for `getValueDetails<Int>`.
    @objc public func getIntValueDetails(
        for key: String, defaultValue: Int, user: ConfeatureUser? = nil
    ) -> IntEvaluationDetails {
        let typed: TypedEvaluationDetails<Int> = self.getValueDetails(
            forKey: key, defaultValue: defaultValue, user: user?.coreUser)
        return IntEvaluationDetails.fromTyped(typed)
    }

    /// ObjC bridge for `getValueDetails<Double>`.
    @objc public func getDoubleValueDetails(
        for key: String, defaultValue: Double, user: ConfeatureUser? = nil
    ) -> DoubleEvaluationDetails {
        let typed: TypedEvaluationDetails<Double> = self.getValueDetails(
            forKey: key, defaultValue: defaultValue, user: user?.coreUser)
        return DoubleEvaluationDetails.fromTyped(typed)
    }

    /// ObjC bridge for `getValueDetails<Bool>`.
    @objc public func getBoolValueDetails(
        for key: String, defaultValue: Bool, user: ConfeatureUser? = nil
    ) -> BoolEvaluationDetails {
        let typed: TypedEvaluationDetails<Bool> = self.getValueDetails(
            forKey: key, defaultValue: defaultValue, user: user?.coreUser)
        return BoolEvaluationDetails.fromTyped(typed)
    }

    /// ObjC bridge for `getValueDetails<Any>`. Returns the non-generic
    /// ``EvaluationDetails`` (no per-type subclass for `Any`).
    @objc public func getAnyValueDetails(
        for key: String, defaultValue: Any, user: ConfeatureUser? = nil
    ) -> EvaluationDetails {
        let typed: TypedEvaluationDetails<Any> = self.getValueDetails(
            forKey: key, defaultValue: defaultValue, user: user?.coreUser)
        return EvaluationDetails(
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
