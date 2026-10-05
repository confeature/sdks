// SPDX-License-Identifier: MIT

import Foundation

/// Bundles an ``OverrideDataSource`` with an ``OverrideBehaviour``.
///
/// Pass via the ``ConfeatureClient`` initializer's
/// `flagOverrides` parameter. Mirrors the upstream
/// `ConfigCat-iOS` `OverrideDataSource` factory + `FlagOverrides`
/// container 1:1.
public struct FlagOverrides: @unchecked Sendable {
    /// Override data source consulted on every evaluation.
    public let dataSource: OverrideDataSource

    /// How overrides interact with the remote configuration.
    public let behaviour: OverrideBehaviour

    /// Constructs a ``FlagOverrides`` bundle from a data source and a
    /// behaviour.
    public init(dataSource: OverrideDataSource, behaviour: OverrideBehaviour) {
        self.dataSource = dataSource
        self.behaviour = behaviour
    }

    /// Convenience factory mirroring ConfigCat-iOS's
    /// `FlagOverrides.localOnly(_:)` static factory.
    public static func localOnly(_ dataSource: OverrideDataSource) -> FlagOverrides {
        FlagOverrides(dataSource: dataSource, behaviour: .localOnly)
    }

    /// Builds a ``FlagOverrides`` from a complete, rule-bearing
    /// `config_v6` blob (`{p, f, s}`) evaluated offline through the
    /// real Confeature evaluator.
    ///
    /// The in-memory, rule-bearing offline-override factory (spec 135 /
    /// #435, epic #382, US3). With ``OverrideBehaviour/localOnly``,
    /// `getValue(forKey:defaultValue:user:)` resolves targeting rules /
    /// segments / prerequisites / percentage options purely from
    /// `config` through the real evaluator — no network fetch.
    ///
    /// Additive (Constitution Principle II): mirrors the JS
    /// federation's `createFlagOverridesFromConfig` and sdk-python's
    /// `create_flag_overrides_from_config` / sdk-dart's
    /// `createFlagOverridesFromConfig`. ConfigCat-iOS exposes the
    /// value-only `LocalDictionaryDataSource` + the file-based
    /// `LocalFileDataSource`; this is the runtime-agnostic in-memory
    /// full-config equivalent, so a customer can drive the full rule
    /// engine from a config blob already resident in memory (the corpus
    /// / test-harness use case). No ConfigCat-named member is renamed or
    /// retyped — ``localOnly(_:)`` and ``MapOverrideDataSource`` are
    /// untouched.
    public static func fromConfig(
        _ config: [String: Any], behaviour: OverrideBehaviour = .localOnly
    ) -> FlagOverrides {
        FlagOverrides(dataSource: ConfigOverrideDataSource(config), behaviour: behaviour)
    }
}
