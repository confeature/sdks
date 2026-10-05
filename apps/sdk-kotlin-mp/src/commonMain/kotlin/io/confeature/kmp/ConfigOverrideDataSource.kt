// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Full-config-backed [OverrideDataSource] (spec 135 — additive, Principle II).
 *
 * <p>Holds a complete parsed `config_v6` blob (`{p,f,s}`) and exposes its `f` settings — **targeting
 * rules / segments / percentage options intact** — through the same [OverrideDataSource] contract
 * [MapOverrideDataSource] uses. Mirrors the canonical TS `ConfigOverrideDataSource`
 * (`packages/sdk-shared/src/flag-overrides.ts`) and how ConfigCat's file source feeds rule-bearing
 * Settings to the evaluator.
 *
 * <p>The whole config root is retained (not just `f`) so the full-config eval path resolves through
 * the real [io.confeature.kmp.internal.Evaluator] with the salt (`p.s`) + segments (`s`) intact —
 * **never just `f`** (the spec-129 dropped-salt regression this story must not reintroduce). The map
 * path stays byte-unchanged: this source overrides only [getConfigRootSync]; its [getOverridesSync]
 * returns the value-only view of `f` and is unused on the LocalOnly full-config route.
 *
 * <p>ConfigCat's only full-config entry point is the (JVM file) source; this in-memory factory is a
 * justified additive extension — the underlying shape (a full-config rule-bearing override source)
 * is faithful to ConfigCat's internal architecture and works on every KMP target.
 *
 * @param config the parsed `config_v6` root (`{p,f,s}`). Defensively shallow-copied.
 */
public class ConfigOverrideDataSource(config: Map<String, Any?>) : OverrideDataSource {
    private val configRoot: Map<String, Any?> = config.toMap()

    /**
     * Value-only view of the `f` settings, for callers that consult the flat map. The full-config
     * LocalOnly route never reads this — it routes through [getConfigRootSync] + the evaluator — but
     * the method keeps the [OverrideDataSource] contract honest. Non-map `f` → empty map.
     */
    @Suppress("UNCHECKED_CAST")
    override fun getOverridesSync(): Map<String, Any>? {
        val f = configRoot["f"] as? Map<String, Any?> ?: return emptyMap()
        // The flat view carries the raw setting envelopes keyed by flag key; the rule engine, not
        // this view, is the resolver on the full-config route. Non-null values only.
        val out = LinkedHashMap<String, Any>(f.size)
        for ((k, v) in f) if (v != null) out[k] = v
        return out
    }

    /** The full `{p,f,s}` config root — the capability probe that routes through the evaluator. */
    override fun getConfigRootSync(): Map<String, Any?> = configRoot
}
