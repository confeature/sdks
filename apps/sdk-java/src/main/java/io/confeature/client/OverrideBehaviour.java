// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * How {@link FlagOverrides} interact with the remote config. Mirrors ConfigCat's {@code
 * com.configcat.OverrideBehaviour}.
 *
 * <p>v1 wires only {@link #LOCAL_ONLY}. {@code LOCAL_OVER_REMOTE} and {@code REMOTE_OVER_LOCAL} are
 * deferred to a follow-up spec; until then, configuring them logs a WARNING and falls back to
 * {@code defaultValue}.
 */
public enum OverrideBehaviour {
  /** Use overrides exclusively; never consult the remote config. */
  LOCAL_ONLY
}
