// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Customer-replaceable abstraction over the override map.
 *
 * <p>An implementation returns the map of override values keyed by flag key. Values MUST be one of
 * [Boolean] / [String] / [Int] / [Double] — anything else falls through the
 * [io.confeature.kmp.internal.OverrideEval] TYPE_MISMATCH branch.
 *
 * <p>Returning null from [getOverridesSync] signals "no sync data available" and causes the
 * override evaluator to fall through to the cache (matches the TS / Python / Go / .NET / Java ports
 * byte-for-byte).
 */
public interface OverrideDataSource {
    /** Synchronous read. May return null to fall through. */
    public fun getOverridesSync(): Map<String, Any>?

    /**
     * Synchronous read of the FULL parsed `config_v6` root (`{p,f,s}`) when this source carries a
     * complete, rule-bearing config — `null` for value-only sources (the default).
     *
     * <p>Additive (spec 135, Principle II): only a [ConfigOverrideDataSource] returns a non-null
     * root. The override router uses a non-null result as the capability probe that routes the key
     * through the real [io.confeature.kmp.internal.Evaluator] with the full `{p,f,s}` config — salt
     * (`p.s`) + segments (`s`) intact (NOT just `f`; the spec-129 dropped-salt regression). Every
     * value-only source (e.g. [MapOverrideDataSource]) inherits the default `null` and keeps the
     * byte-identical flat-map path.
     */
    public fun getConfigRootSync(): Map<String, Any?>? = null
}
