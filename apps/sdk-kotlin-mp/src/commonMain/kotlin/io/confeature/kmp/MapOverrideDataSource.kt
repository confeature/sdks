// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * In-memory map-backed [OverrideDataSource] — the production default for customers that don't need
 * an async fetch path.
 *
 * <p>The constructor defensively copies the supplied map so subsequent caller mutations don't leak
 * into the SDK's view. Value types are NOT validated here — type checks happen inside the 7-branch
 * override evaluator (Branch 6, TYPE_MISMATCH) which matches the cross-language canonical algorithm
 * exactly.
 */
public class MapOverrideDataSource(overrides: Map<String, Any>) : OverrideDataSource {
    private val snapshot: Map<String, Any> = overrides.toMap()

    override fun getOverridesSync(): Map<String, Any> = snapshot
}
