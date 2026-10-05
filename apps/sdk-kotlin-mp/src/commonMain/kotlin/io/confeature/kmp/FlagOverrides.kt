// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Pairs an [OverrideBehaviour] with an [OverrideDataSource]. Passed to
 * `ConfeatureClient.Builder#flagOverrides(FlagOverrides)`.
 *
 * <p>Mirrors ConfigCat's `FlagOverrides` 1:1.
 */
public class FlagOverrides(
    public val dataSource: OverrideDataSource,
    public val behaviour: OverrideBehaviour,
) {
    public companion object {
        /**
         * Convenience factory matching ConfigCat's `FlagOverrides.localOnly` shape. The returned
         * instance has [OverrideBehaviour.LOCAL_ONLY].
         */
        public fun localOnly(dataSource: OverrideDataSource): FlagOverrides =
            FlagOverrides(dataSource, OverrideBehaviour.LOCAL_ONLY)

        /**
         * Build a [FlagOverrides] from a complete, rule-bearing `config_v6` blob (`{p,f,s}`)
         * evaluated offline through the real [io.confeature.kmp.internal.Evaluator] (spec 135 —
         * additive, Principle II). The in-memory equivalent of ConfigCat's file-based full-config
         * override: with [OverrideBehaviour.LOCAL_ONLY], `getValue(key, default, user)` resolves
         * targeting rules, segments, prerequisites and percentage options purely from [config] —
         * no network fetch.
         *
         * <p>Spelled to match the existing map-factory idiom ([localOnly] + [MapOverrideDataSource]
         * → [localConfig] + [ConfigOverrideDataSource]). See [createFlagOverridesFromConfig] for the
         * ConfigCat-named top-level factory.
         */
        public fun localConfig(config: Map<String, Any?>): FlagOverrides =
            FlagOverrides(ConfigOverrideDataSource(config), OverrideBehaviour.LOCAL_ONLY)
    }
}

/**
 * Build a [FlagOverrides] from a complete, rule-bearing `config_v6` blob (`{p,f,s}`) evaluated
 * offline through the real [io.confeature.kmp.internal.Evaluator] (spec 135 — additive,
 * Principle II). Mirrors the canonical TS `createFlagOverridesFromConfig`
 * (`packages/sdk-shared/src/flag-overrides.ts`) 1:1 in name + arity.
 *
 * @param config the parsed `config_v6` root (`{p,f,s}`).
 * @param behaviour how overrides interact with remote config (v1 wires only
 *   [OverrideBehaviour.LOCAL_ONLY]).
 * @param watchChanges accepted for signature compatibility; ignored (the config is already resident
 *   in memory).
 */
@Suppress("UNUSED_PARAMETER")
public fun createFlagOverridesFromConfig(
    config: Map<String, Any?>,
    behaviour: OverrideBehaviour,
    watchChanges: Boolean = false,
): FlagOverrides = FlagOverrides(ConfigOverrideDataSource(config), behaviour)
