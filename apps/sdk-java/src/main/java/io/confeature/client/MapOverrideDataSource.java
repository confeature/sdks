// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * In-memory dictionary-backed {@link OverrideDataSource} — the production default for customers
 * that don't need an async fetch path.
 *
 * <p>The constructor defensively copies the supplied map so subsequent caller mutations don't leak
 * into the SDK's view. Value types are NOT validated here — type checks happen inside the 7-branch
 * override evaluator (Branch 6, TYPE_MISMATCH) which matches the cross-language canonical algorithm
 * exactly.
 */
public final class MapOverrideDataSource implements OverrideDataSource {

  private final Map<String, Object> snapshot;

  /** Constructs from a map of override values. {@code overrides} must be non-null. */
  public MapOverrideDataSource(Map<String, Object> overrides) {
    Objects.requireNonNull(overrides, "overrides");
    this.snapshot = Collections.unmodifiableMap(new LinkedHashMap<>(overrides));
  }

  @Override
  public Map<String, Object> getOverridesSync() {
    return snapshot;
  }
}
