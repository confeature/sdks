// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Full-config override source — holds a complete parsed {@code config_v6} blob ({@code {p, f, s}})
 * and routes through the real evaluator offline.
 *
 * <p>Spec 135 / #430 (epic #382, US3): the rule-bearing sibling of {@link MapOverrideDataSource}.
 * Where the map source emits value-only settings, this source retains the WHOLE {@code {p, f, s}}
 * config — salt ({@code p.s}) + segments ({@code s}) + rule-bearing settings ({@code f}) — so the
 * Java evaluator can resolve targeting rules / segments / prerequisites / percentage options purely
 * from the supplied config, no network fetch.
 *
 * <p>Additive extension (Principle II): ConfigCat's official Java SDK only exposes a
 * <em>file-based</em> full-config override ({@code OverrideDataSourceBuilder.localFile(...)}). This
 * in-memory form is the runtime-agnostic equivalent, mirroring the JS federation's {@code
 * ConfigOverrideDataSource} / {@code createFlagOverridesFromConfig}, sdk-python's {@code
 * ConfigOverrideDataSource}, and sdk-dotnet's {@code ConfigOverrideDataSource}. No ConfigCat-named
 * member is renamed or retyped.
 *
 * <p>The whole config map is retained (never just {@code f}) — the spec-129 dropped-salt regression
 * guard (INV-4): percentage bucketing reads {@code p.s} and segment conditions read {@code s}.
 *
 * <p>{@link #getOverridesSync()} returns the rule-bearing {@code f} settings map so {@code
 * getAllKeys} can enumerate the override's flag keys; resolution itself never goes through that map
 * — the override router ({@link io.confeature.client.internal.OverrideEval#evaluate}) dispatches on
 * the source TYPE so a {@link ConfigOverrideDataSource} always routes through the real evaluator
 * with the full config, never the value-only flat-map path.
 */
public final class ConfigOverrideDataSource implements OverrideDataSource {

  private final Map<String, Object> config;

  /**
   * Constructs from a full parsed {@code config_v6} blob ({@code {p, f, s}}). {@code config} must
   * be non-null. The map is defensively copied so subsequent caller mutations don't leak into the
   * SDK's view.
   */
  public ConfigOverrideDataSource(Map<String, Object> config) {
    Objects.requireNonNull(config, "config");
    this.config = Collections.unmodifiableMap(new LinkedHashMap<>(config));
  }

  /** The full parsed {@code config_v6} blob ({@code {p, f, s}}), consumed by the evaluator. */
  public Map<String, Object> getConfig() {
    return config;
  }

  /**
   * Returns the rule-bearing settings map ({@code f}), rules intact — exposed so {@code getAllKeys}
   * can enumerate the override's flag keys. Resolution itself never goes through this map: the
   * router evaluates the full config through the real evaluator.
   *
   * <p>Returns an empty map when {@code f} is absent / malformed.
   */
  @Override
  @SuppressWarnings("unchecked")
  public Map<String, Object> getOverridesSync() {
    final Object f = config.get("f");
    return f instanceof Map ? (Map<String, Object>) f : Collections.emptyMap();
  }
}
