// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Full-config override source — holds a complete parsed `config_v6` blob (`{p, f, s}`) and routes
 * through the real evaluator offline.
 *
 * Spec 135 / #440 (epic #382, US3): the rule-bearing sibling of [MapOverrideDataSource]. Where the
 * map source emits value-only settings, this source retains the WHOLE `{p, f, s}` config — salt
 * (`p.s`) + segments (`s`) + rule-bearing settings (`f`) — so the Android evaluator can resolve
 * targeting rules / segments / prerequisites / percentage options purely from the supplied config,
 * with no network fetch.
 *
 * Additive extension (Constitution Principle II): ConfigCat's official Android SDK only exposes a
 * *file-based* full-config override (`OverrideDataSourceBuilder.localFile(...)`). This in-memory
 * form is the runtime-agnostic equivalent, mirroring the JS federation's
 * `ConfigOverrideDataSource` / `createFlagOverridesFromConfig`, sdk-python's
 * `ConfigOverrideDataSource`, and sdk-java's `ConfigOverrideDataSource`. No ConfigCat-named member
 * is renamed or retyped.
 *
 * The whole config map is retained (never just `f`) — the spec-129 dropped-salt regression guard
 * (INV-4): percentage bucketing reads `p.s` and segment conditions read `s`.
 *
 * [getOverridesSync] returns the rule-bearing `f` settings map so `getAllKeys` can enumerate the
 * override's flag keys; resolution itself never goes through that map — the override router
 * ([io.confeature.android.internal.OverrideEval.evaluate]) dispatches on the source TYPE so a
 * [ConfigOverrideDataSource] always routes through the real evaluator with the full config, never
 * the value-only flat-map path.
 */
public class ConfigOverrideDataSource(config: Map<String, Any?>) : OverrideDataSource {
    /** The full parsed `config_v6` blob (`{p, f, s}`), consumed by the evaluator. */
    public val config: Map<String, Any?> =
        java.util.Collections.unmodifiableMap(LinkedHashMap(config))

    /**
     * Returns the rule-bearing settings map (`f`), rules intact — exposed so `getAllKeys` can
     * enumerate the override's flag keys. Resolution itself never goes through this map: the router
     * evaluates the full config through the real evaluator.
     *
     * Returns an empty map when `f` is absent / malformed.
     */
    @Suppress("UNCHECKED_CAST")
    override fun getOverridesSync(): Map<String, Any?> =
        (config["f"] as? Map<String, Any?>) ?: emptyMap()
}
