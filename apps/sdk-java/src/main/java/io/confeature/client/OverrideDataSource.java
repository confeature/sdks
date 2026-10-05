// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Map;

/**
 * Customer-replaceable abstraction over the override map.
 *
 * <p>An implementation returns the map of override values keyed by flag key. Values MUST be one of
 * {@link Boolean} / {@link String} / {@link Integer} / {@link Double} — anything else falls through
 * the {@link io.confeature.client.internal.OverrideEval} TYPE_MISMATCH branch.
 *
 * <p>Returning {@code null} from {@link #getOverridesSync()} signals "no sync data available" and
 * causes the override evaluator to fall through to the cache (matches the TS / Python / Go / .NET
 * ports byte-for-byte).
 */
public interface OverrideDataSource {

  /** Synchronous read. May return {@code null} to fall through. */
  Map<String, Object> getOverridesSync();
}
