// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Pairs an [OverrideBehaviour] with an [OverrideDataSource]. Passed to
 * [ConfeatureClient.Builder.flagOverrides].
 *
 * Mirrors ConfigCat's `com.configcat.FlagOverrides` 1:1.
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
        @JvmStatic
        public fun localOnly(dataSource: OverrideDataSource): FlagOverrides =
            FlagOverrides(dataSource, OverrideBehaviour.LOCAL_ONLY)

        /**
         * Builds a [FlagOverrides] from a complete, rule-bearing `config_v6` blob (`{p, f, s}`)
         * evaluated offline through the real evaluator.
         *
         * Spec 135 / #440 (epic #382, US3) — additive, in-memory full-config override. ConfigCat's
         * official Android SDK exposes the value-only `OverrideDataSourceBuilder.localValues(map)`
         * plus the file-based `OverrideDataSourceBuilder.localFile(...)`; this is the
         * runtime-agnostic in-memory equivalent of the file path (the corpus / test-harness use
         * case), so a customer can drive the full rule engine from a config blob already resident
         * in memory. Mirrors the JS federation's `createFlagOverridesFromConfig`, sdk-python's
         * `create_flag_overrides_from_config`, and sdk-java's `FlagOverrides.localConfig`.
         *
         * Additive only (Principle II): no ConfigCat-named member is renamed or retyped, and the
         * existing flat [MapOverrideDataSource] / [localOnly] path is byte-identical.
         *
         * With [OverrideBehaviour.LOCAL_ONLY], `getValue(key, default, user)` resolves targeting
         * rules / segments / prerequisites / percentage options purely from [config] through the
         * real evaluator — no network fetch. The WHOLE config is retained (salt `p.s` + segments
         * `s`, never just `f` — INV-4, the spec-129 dropped-salt regression class).
         *
         * @param config the parsed full `config_v6` blob (`{p, f, s}`).
         * @param behaviour how overrides interact with the remote config. Only
         *   [OverrideBehaviour.LOCAL_ONLY] is wired in v1.
         */
        @JvmStatic
        public fun localConfig(config: Map<String, Any?>, behaviour: OverrideBehaviour): FlagOverrides =
            FlagOverrides(ConfigOverrideDataSource(config), behaviour)
    }
}
