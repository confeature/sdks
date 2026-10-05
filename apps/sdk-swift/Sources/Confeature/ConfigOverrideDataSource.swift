// SPDX-License-Identifier: MIT

import Foundation

/// Full-config override source — holds a complete parsed `config_v6`
/// blob (`{p, f, s}`) and routes through the real evaluator offline.
///
/// Spec 135 / #435 (epic #382, US3): the rule-bearing sibling of
/// ``MapOverrideDataSource``. Where the map source emits a value-only
/// override dictionary, this source retains the WHOLE `{p, f, s}`
/// config — salt (`p.s`) + segments (`s`) + rule-bearing settings
/// (`f`) — so the Confeature evaluator can resolve targeting rules /
/// segments / prerequisites / percentage options purely from the
/// supplied config, with no network fetch.
///
/// Additive extension (Constitution Principle II): ConfigCat-iOS only
/// exposes a *file-based* full-config override
/// (`FlagOverrides(dataSource:behaviour:)` fed a `LocalFileDataSource`)
/// alongside the value-only `LocalDictionaryDataSource`. This in-memory
/// full-config form is the runtime-agnostic equivalent of the file path
/// (the corpus / test-harness use case), mirroring the JS federation's
/// `ConfigOverrideDataSource` / `createFlagOverridesFromConfig` and
/// sdk-python / sdk-dotnet / sdk-dart's `ConfigOverrideDataSource`. No
/// ConfigCat-named member is renamed or retyped.
///
/// The whole config map is retained (never just `f`) — the spec-129
/// dropped-salt regression guard (INV-4): percentage bucketing reads
/// `p.s` and segment conditions read `s`.
///
/// This source intentionally does NOT route rule-bearing data through
/// the value-only ``getOverridesSync()`` contract: ``getOverridesSync()``
/// returns the flat *base* value envelopes (so key enumeration /
/// `getAllKeys` / `getAllValues` work), but resolution itself never
/// goes through that flat map — the override router
/// (``OverrideEval/evaluate(overrides:key:defaultValue:user:)``)
/// dispatches on the source TYPE so a ``ConfigOverrideDataSource``
/// always routes through the evaluator with the full ``config``.
public struct ConfigOverrideDataSource: OverrideDataSource, @unchecked Sendable {
    /// The full parsed `config_v6` blob (`{p, f, s}`). Consumed by the
    /// full-config override router; never the flat-map path.
    public let config: [String: Any]

    private let baseValues: [String: Any]

    /// Constructs a ``ConfigOverrideDataSource`` from a complete parsed
    /// `config_v6` blob (`{p, f, s}`).
    ///
    /// The full map is retained verbatim (INV-4: salt `p.s` + segments
    /// `s` are NOT dropped). The flat base-value map exposed by
    /// ``getOverridesSync()`` is derived once at construction so key
    /// enumeration is cheap and stable.
    public init(_ config: [String: Any]) {
        self.config = config
        self.baseValues = Self.baseValues(of: config)
    }

    /// Returns the flat *base* value envelopes of the settings (the
    /// served `setting["v"]`), so `getAllKeys` / `getAllValues` can
    /// enumerate the override's flag keys. Rule resolution never goes
    /// through this map — the router evaluates the full config through
    /// the real evaluator.
    public func getOverridesSync() -> [String: Any]? {
        baseValues
    }

    /// Derives the flat base-value map from `config.f`, selecting each
    /// setting's served `v` envelope by the present scalar slot.
    private static func baseValues(of config: [String: Any]) -> [String: Any] {
        guard let settings = config["f"] as? [String: Any] else { return [:] }
        var out: [String: Any] = [:]
        for (key, raw) in settings {
            guard
                let setting = raw as? [String: Any],
                let valueSlot = setting["v"] as? [String: Any]
            else { continue }
            if let b = valueSlot["b"] as? Bool {
                out[key] = b
            } else if let s = valueSlot["s"] as? String {
                out[key] = s
            } else if let i = Evaluator.readInt(valueSlot["i"]) {
                out[key] = i
            } else if let d = Evaluator.readDouble(valueSlot["d"]) {
                out[key] = d
            }
        }
        return out
    }
}
