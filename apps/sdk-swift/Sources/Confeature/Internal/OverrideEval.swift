// SPDX-License-Identifier: MIT

import Foundation

/// Synchronous override evaluation — 7-branch decision tree.
///
/// Port of:
/// - `packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync` (TS canonical)
/// - `apps/sdk-python/.../override_eval.py:evaluate_override_sync`
/// - `apps/sdk-go/internal/overrideeval/eval.go:EvaluateSync`
/// - `apps/sdk-rust/src/internal/override_eval.rs:evaluate_sync`
/// - `apps/sdk-dotnet/.../OverrideEval.cs`
///
/// The 7 branches are byte-identical across every Confeature SDK;
/// the parity corpus is the cross-language gate.
///
/// Return type semantics:
/// - `(false, nil)`               → caller falls through to the
///   cache (Branches 1–3).
/// - `(true, Some(value))`        → resolved override result
///   (possibly the supplied default — Branches 4–6 honour the
///   LocalOnly contract: never fall through). Branch 7 returns the
///   typed override value.
enum OverrideEval {
    /// Walks the 7-branch decision tree.
    ///
    /// Algorithm — byte-identical to every other Confeature SDK port:
    ///
    /// 1. `overrides == nil`                                 → `(false, nil)`
    /// 2. `behaviour != .localOnly`                          → `(false, nil)`
    /// 3. `dataSource.getOverridesSync() == nil`             → `(false, nil)`
    /// 4. key absent                                         → `(true, default)`
    /// 5. raw value is `NSNull` / nil                        → `(true, default)`
    /// 6. `type(candidate) != type(default)`                 → `(true, default)`
    /// 7. happy path                                         → `(true, candidate)`
    static func evaluateSync(
        overrides: FlagOverrides?,
        key: String,
        defaultValue: Any?
    ) -> (found: Bool, value: Any?) {
        // Branch 1.
        guard let overrides else {
            return (false, nil)
        }

        // Branch 2.
        guard overrides.behaviour == .localOnly else {
            return (false, nil)
        }

        // Branch 3.
        guard let map = overrides.dataSource.getOverridesSync() else {
            return (false, nil)
        }

        // From here we are committed to the LocalOnly contract —
        // never fall through.

        // Branch 4.
        guard let raw = map[key] else {
            return (true, defaultValue)
        }

        // Branch 5 — NSNull / empty.
        if raw is NSNull {
            return (true, defaultValue)
        }

        // Branch 6 — type-mismatch check. A nil default bypasses
        // the check (matches the TS `defaultValue !== null`
        // semantics; nil in Swift is the equivalent sentinel).
        if let defaultValue, !sameKind(raw, defaultValue) {
            return (true, defaultValue)
        }

        // Branch 7 — happy path.
        return (true, raw)
    }

    /// Shared override router — Swift port of the canonical TS
    /// `evaluateOverride` (spec 135 / #435, epic #382, US3), mirroring
    /// sdk-python's `evaluate_override`, sdk-dotnet's `Evaluate`, and
    /// sdk-dart's `evaluateOverride`.
    ///
    /// Dispatches between the byte-identical flat-map path
    /// (``evaluateSync(overrides:key:defaultValue:)``) and the
    /// full-config path so the `getValue` / `resolve` call sites change
    /// minimally: a ``ConfigOverrideDataSource`` routes through the real
    /// evaluator (with `user` threaded); every other source (map /
    /// custom) keeps the existing byte-identical flat-map resolution.
    ///
    /// Dispatch is on the source TYPE, not the resolved value, so a
    /// full-config source whose evaluator returns the default still
    /// stays on the rule path (never mis-read as value-only). The
    /// LocalOnly "never fall through" contract is preserved on both
    /// paths.
    static func evaluate(
        overrides: FlagOverrides?,
        key: String,
        defaultValue: Any?,
        user: User?
    ) -> (found: Bool, value: Any?) {
        if let overrides,
            overrides.behaviour == .localOnly,
            let source = overrides.dataSource as? ConfigOverrideDataSource
        {
            return evaluateFullConfig(
                source: source, key: key, defaultValue: defaultValue, user: user)
        }
        // Every other source (map / custom) keeps the byte-identical
        // flat-map path.
        return evaluateSync(overrides: overrides, key: key, defaultValue: defaultValue)
    }

    /// Full-config override resolution — Swift port of the canonical TS
    /// `evaluateFullConfigOverrideSync`, mirroring sdk-python's
    /// `evaluate_full_config_override_sync` and sdk-dotnet's
    /// `EvaluateFullConfigSync`.
    ///
    /// Resolves `key` through the real Confeature evaluator so targeting
    /// rules / segments / prerequisites / percentage options apply
    /// offline — the rule-bearing sibling of ``evaluateSync``'s flat
    /// lookup. Always returns `(true, value)`: the LocalOnly contract
    /// forbids falling through to the cache, and the evaluator already
    /// returns `defaultValue` for any non-clean resolution.
    ///
    /// INV-4: the evaluator receives the FULL config map (`{p, f, s}`) —
    /// salt (`p.s`) + segments (`s`), never just `f` (the spec-129
    /// dropped-salt regression class).
    private static func evaluateFullConfig(
        source: ConfigOverrideDataSource,
        key: String,
        defaultValue: Any?,
        user: User?
    ) -> (found: Bool, value: Any?) {
        // The evaluator never throws — any failure resolves to the
        // caller's default. `nil` default is mapped to `NSNull()` so the
        // evaluator's getAll* probe path (type-guard bypass) is honoured.
        let result = Evaluator.evaluate(
            config: source.config, key: key,
            defaultValue: defaultValue ?? NSNull(), user: user)
        return (true, result.value)
    }

    /// Reports whether two values share a kind for the override-eval
    /// type-check.
    ///
    /// Numeric kinds (`Int`, `Double`, `Float`, `NSNumber` …) are
    /// folded into a single "number" bucket — this matches the TS
    /// canonical implementation where
    /// `typeof 42 === typeof 42.5 === "number"`.
    private static func sameKind(_ a: Any, _ b: Any) -> Bool {
        switch (a, b) {
        case (is Bool, is Bool):
            return true
        case (is String, is String):
            return true
        case (_, _) where isNumber(a) && isNumber(b):
            return true
        case (is [Any], is [Any]):
            return true
        case (is [String: Any], is [String: Any]):
            return true
        default:
            return false
        }
    }

    private static func isNumber(_ value: Any) -> Bool {
        // `Bool` bridges to NSNumber on Apple platforms — guard
        // explicitly so a `Bool` is NOT mis-classified as a number.
        if value is Bool { return false }
        switch value {
        case is Int, is Int8, is Int16, is Int32, is Int64,
            is UInt, is UInt8, is UInt16, is UInt32, is UInt64,
            is Float, is Double:
            return true
        case let n as NSNumber:
            // NSNumber backed by Bool: CFNumberGetType reports
            // kCFNumberCharType. The earlier `is Bool` branch
            // catches Swift's native Bool, but a bridged
            // NSNumber(value: false) needs an explicit check.
            return CFNumberGetType(n) != .charType
        default:
            return false
        }
    }
}
