// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Customer-replaceable abstraction over the override map.
 *
 * An implementation returns the map of override values keyed by flag key. Values MUST be one of
 * [Boolean] / [String] / [Int] / [Double] — anything else falls through the
 * [io.confeature.android.internal.OverrideEval] TYPE_MISMATCH branch.
 *
 * Returning `null` from [getOverridesSync] signals "no sync data available" and causes the
 * override evaluator to fall through to the cache (matches the TS / Python / Go / .NET ports
 * byte-for-byte).
 */
public fun interface OverrideDataSource {
    /** Synchronous read. May return null to fall through. */
    public fun getOverridesSync(): Map<String, Any?>?
}
