// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * How [FlagOverrides] interact with the remote config. Mirrors ConfigCat's
 * `com.configcat.OverrideBehaviour`.
 *
 * v1 wires only [LOCAL_ONLY]. `LOCAL_OVER_REMOTE` and `REMOTE_OVER_LOCAL` are deferred to a
 * follow-up spec; until then, configuring them logs a WARNING and falls back to `defaultValue`.
 */
public enum class OverrideBehaviour {
    /** Use overrides exclusively; never consult the remote config. */
    LOCAL_ONLY,
}
