// SPDX-License-Identifier: MIT
package io.confeature.client;

import java.util.Map;
import java.util.Objects;

/**
 * Pairs an {@link OverrideBehaviour} with an {@link OverrideDataSource}. Passed to {@code
 * ConfeatureClient.Builder#flagOverrides(FlagOverrides)}.
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.FlagOverrides} 1:1.
 */
public final class FlagOverrides {

  private final OverrideDataSource dataSource;
  private final OverrideBehaviour behaviour;

  /** Initialises a new {@link FlagOverrides}. */
  public FlagOverrides(OverrideDataSource dataSource, OverrideBehaviour behaviour) {
    this.dataSource = Objects.requireNonNull(dataSource, "dataSource");
    this.behaviour = Objects.requireNonNull(behaviour, "behaviour");
  }

  /**
   * Convenience factory matching ConfigCat's {@code FlagOverrides.localOnly} shape. The returned
   * instance has {@link OverrideBehaviour#LOCAL_ONLY}.
   */
  public static FlagOverrides localOnly(OverrideDataSource dataSource) {
    return new FlagOverrides(dataSource, OverrideBehaviour.LOCAL_ONLY);
  }

  /**
   * Builds a {@link FlagOverrides} from a complete, rule-bearing {@code config_v6} blob ({@code {p,
   * f, s}}) evaluated offline through the real evaluator.
   *
   * <p>Spec 135 / #430 (epic #382, US3) — additive, in-memory full-config override. ConfigCat's
   * official Java SDK exposes the value-only {@code OverrideDataSourceBuilder.localValues(map)} +
   * the file-based {@code OverrideDataSourceBuilder.localFile(...)}; this is the runtime-agnostic
   * in-memory equivalent of the file path (the corpus / test-harness use case), so a customer can
   * drive the full rule engine from a config blob already resident in memory. Mirrors the JS
   * federation's {@code createFlagOverridesFromConfig}, sdk-python's {@code
   * create_flag_overrides_from_config}, and sdk-dotnet's {@code FlagOverrides.LocalConfig}.
   *
   * <p>Additive only (Principle II): no ConfigCat-named member is renamed or retyped, and the
   * existing flat {@link MapOverrideDataSource} / {@code localOnly} path is byte-identical.
   *
   * <p>With {@link OverrideBehaviour#LOCAL_ONLY}, {@code getValue(key, default, user)} resolves
   * targeting rules / segments / prerequisites / percentage options purely from {@code config}
   * through the real evaluator — no network fetch. The WHOLE config is retained (salt {@code p.s} +
   * segments {@code s}, never just {@code f} — INV-4, the spec-129 dropped-salt regression class).
   *
   * @param config the parsed full {@code config_v6} blob ({@code {p, f, s}}).
   * @param behaviour how overrides interact with the remote config. Only {@link
   *     OverrideBehaviour#LOCAL_ONLY} is wired in v1.
   */
  public static FlagOverrides localConfig(Map<String, Object> config, OverrideBehaviour behaviour) {
    return new FlagOverrides(new ConfigOverrideDataSource(config), behaviour);
  }

  /** The data source providing override values. */
  public OverrideDataSource getDataSource() {
    return dataSource;
  }

  /** The configured override behaviour. */
  public OverrideBehaviour getBehaviour() {
    return behaviour;
  }
}
