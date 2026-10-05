// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * In-memory dictionary-backed [OverrideDataSource] — the production default for customers that
 * don't need an async fetch path.
 *
 * The constructor defensively copies the supplied map so subsequent caller mutations don't leak
 * into the SDK's view. Value types are NOT validated here — type checks happen inside the 7-branch
 * override evaluator (Branch 6, TYPE_MISMATCH) which matches the cross-language canonical algorithm
 * exactly.
 */
public class MapOverrideDataSource(overrides: Map<String, Any?>) : OverrideDataSource {
    private val snapshot: Map<String, Any?> =
        java.util.Collections.unmodifiableMap(LinkedHashMap(overrides))

    override fun getOverridesSync(): Map<String, Any?> = snapshot

    public companion object {
        /** Java-friendly factory matching ConfigCat's `MapOverrideDataSource.of(...)` shape. */
        @JvmStatic
        public fun of(overrides: Map<String, Any?>): MapOverrideDataSource =
            MapOverrideDataSource(overrides)
    }
}
