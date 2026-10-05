// SPDX-License-Identifier: MIT
package io.confeature.client;

import io.confeature.client.internal.Evaluator;
import io.confeature.client.internal.OverrideEval;
import java.util.Collection;
import java.util.Collections;
import java.util.Map;
import java.util.TreeSet;

/**
 * Immutable read-side view returned by {@code ConfeatureClient#snapshot()}.
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClientSnapshot}: customers that want a
 * stable view of the config across multiple evaluations (e.g. a request scope) can take a snapshot
 * once and then resolve every key against the same captured state.
 *
 * <p>Override resolution runs FIRST (spec-036 correctness, inherited from day one), then falls
 * through to the v1 boolean evaluator against the captured config.
 */
public final class Snapshot {

  private final Map<String, Object> settings;
  // Full parsed config_v6 root ({p,f,s}) — fed to the targeting-aware evaluator
  // (spec 126). `settings` (the `f` map) backs getAllKeys / getSettings.
  private final Map<String, Object> configRoot;
  private final FlagOverrides flagOverrides;
  private final User defaultUser;
  private final long fetchTimeUnixMillis;

  /**
   * Constructs a snapshot. Callers (the client) supply the parsed "f" map; immutability is the
   * caller's responsibility — the snapshot defensively wraps it in {@link
   * Collections#unmodifiableMap}.
   */
  public Snapshot(Map<String, Object> settings, FlagOverrides flagOverrides, User defaultUser) {
    this(settings, null, flagOverrides, defaultUser, 0L);
  }

  /**
   * Constructs a snapshot with a captured fetch time. The fetch time is the wall-clock epoch-millis
   * of the live client's last successful fetch / cache restore, captured at snapshot construction.
   * Surfaced via {@link EvaluationDetails#getFetchTimeUnixMilliseconds()} on every {@link
   * #getValueDetails(String, Object, User)} call.
   */
  public Snapshot(
      Map<String, Object> settings,
      FlagOverrides flagOverrides,
      User defaultUser,
      long fetchTimeUnixMillis) {
    this(settings, null, flagOverrides, defaultUser, fetchTimeUnixMillis);
  }

  /**
   * Constructs a snapshot with the full parsed config root ({@code {p,f,s}}) — the targeting-aware
   * evaluator (spec 126) reads the {@code p.s} salt + {@code s} segments from it. {@code
   * configRoot} may be {@code null}, in which case a minimal {@code {f}} envelope is synthesized
   * from {@code settings} so salt-less / segment-less configs still evaluate.
   */
  public Snapshot(
      Map<String, Object> settings,
      Map<String, Object> configRoot,
      FlagOverrides flagOverrides,
      User defaultUser,
      long fetchTimeUnixMillis) {
    this.settings = settings == null ? null : Collections.unmodifiableMap(settings);
    this.configRoot = configRoot == null ? null : Collections.unmodifiableMap(configRoot);
    this.flagOverrides = flagOverrides;
    this.defaultUser = defaultUser;
    this.fetchTimeUnixMillis = fetchTimeUnixMillis;
  }

  /**
   * The full config root the evaluator consumes; synthesizes a minimal {@code {f}} envelope when
   * only the {@code f} map was captured.
   */
  private Map<String, Object> configForEval() {
    if (configRoot != null) {
      return configRoot;
    }
    if (settings == null) {
      return null;
    }
    final Map<String, Object> synthetic = new java.util.LinkedHashMap<>(1);
    synthetic.put("f", settings);
    return synthetic;
  }

  /**
   * Resolves {@code key} against the captured config + any configured overrides.
   *
   * <p>Override resolution runs FIRST. Falls through to the v1 boolean evaluator against the
   * captured config. Returns {@code defaultValue} on any failure path (key absent, unsupported
   * type, type mismatch).
   */
  public Object getValue(String key, Object defaultValue, User user) {
    final User effectiveUser = user == null ? defaultUser : user;

    // Override path FIRST — route through the full-config-aware router (spec
    // 135 / #430) so a rule-bearing ConfigOverrideDataSource resolves
    // targeting rules through the real evaluator (user threaded); the flat-map
    // source keeps the byte-identical value-only path.
    if (flagOverrides != null) {
      final OverrideEval.EvalResult overrideResult =
          OverrideEval.evaluate(flagOverrides, key, defaultValue, effectiveUser);
      if (overrideResult.isFound()) {
        return overrideResult.getValue();
      }
      // Non-LocalOnly behaviours are not wired in v1 — the client logs
      // a WARNING + returns defaultValue at the boundary. The snapshot
      // path is symmetrical: fall through to the captured config.
    }

    final Evaluator.Result result =
        Evaluator.evaluate(configForEval(), key, defaultValue, effectiveUser);
    return result.getValue();
  }

  /** Returns the snapshot's underlying setting map (or {@code null} when none was captured). */
  public Map<String, Object> getSettings() {
    return settings;
  }

  /**
   * Returns the union of cached-config + override keys, sorted ordinally for deterministic output.
   *
   * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClient#getAllKeys()} return shape ({@link
   * Collection}{@code <}{@link String}{@code >}). Returns an empty collection when neither the
   * cached config nor any overrides expose keys.
   */
  public Collection<String> getAllKeys() {
    final TreeSet<String> keys = new TreeSet<>();
    if (settings != null) {
      keys.addAll(settings.keySet());
    }
    if (flagOverrides != null) {
      final Map<String, Object> overridesMap = flagOverrides.getDataSource().getOverridesSync();
      if (overridesMap != null) {
        keys.addAll(overridesMap.keySet());
      }
    }
    return Collections.unmodifiableCollection(keys);
  }

  /**
   * Resolves {@code key} and wraps the outcome in an {@link EvaluationDetails} envelope.
   *
   * <p>Mirrors {@link #getValue(String, Object, User)} but surfaces the variation id / fetch time /
   * targeting-rule envelope upstream consumers rely on. Spec 080 / #266.
   *
   * <p>For consumers configured with {@link OverrideBehaviour#LOCAL_ONLY}, the override map is the
   * only source of truth: a key present in the map yields the typed value with {@code error=null};
   * a missing key yields the default with {@code error="KEY_NOT_FOUND"}. Without overrides (or with
   * non-LocalOnly behaviour), the evaluator's result is reported directly.
   */
  public EvaluationDetails<Object> getValueDetails(String key, Object defaultValue, User user) {
    final User effectiveUser = user == null ? defaultUser : user;
    final boolean isLocalOnly =
        flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY;

    // Full-config override path (#395 / spec 152): a rule-bearing
    // ConfigOverrideDataSource resolves through the real evaluator, so the
    // details envelope carries the matched option's variationId — the seam the
    // full-config corpus surfaced as null. Dispatch on the source TYPE (mirrors
    // the value path's OverrideEval.evaluate), never falling back to the
    // flat-map branches for a full-config source.
    final Evaluator.Result overrideDetails =
        OverrideEval.evaluateFullConfigDetails(flagOverrides, key, defaultValue, effectiveUser);
    if (overrideDetails != null) {
      final String overrideErrorCode =
          overrideDetails.getError() == Evaluator.Error.NONE
              ? null
              : overrideDetails.getError().name();
      return new EvaluationDetails<>(
          key,
          overrideDetails.getValue(),
          overrideErrorCode != null ? null : overrideDetails.getVariationId(),
          fetchTimeUnixMillis,
          effectiveUser,
          overrideErrorCode != null,
          overrideErrorCode,
          overrideDetails.hasMatchedTargetingRule() ? TargetingRule.MATCHED : null,
          overrideDetails.hasMatchedPercentageOption() ? PercentageOption.MATCHED : null);
    }

    if (isLocalOnly) {
      final OverrideEval.EvalResult overrideResult =
          OverrideEval.evaluateSync(flagOverrides, key, defaultValue);
      // LocalOnly contract: distinguish "override hit" from "missing key
      // returning default". We re-query the map to disambiguate —
      // OverrideEval.evaluateSync returns the default on both
      // KEY_NOT_FOUND and TYPE_MISMATCH branches, indistinguishable from
      // a legitimate hit whose value equals the default.
      final OverrideDataSource dataSource = flagOverrides.getDataSource();
      final Map<String, Object> overridesMap =
          dataSource == null ? null : dataSource.getOverridesSync();
      final boolean keyPresent = overridesMap != null && overridesMap.containsKey(key);
      if (!keyPresent) {
        return new EvaluationDetails<>(
            key,
            defaultValue,
            null,
            fetchTimeUnixMillis,
            effectiveUser,
            true,
            "KEY_NOT_FOUND",
            null,
            null);
      }
      final Object candidate = overridesMap.get(key);
      if (candidate == null) {
        // Branch 5 — empty/null override slot returns default.
        return new EvaluationDetails<>(
            key,
            defaultValue,
            null,
            fetchTimeUnixMillis,
            effectiveUser,
            true,
            "MALFORMED_VALUE",
            null,
            null);
      }
      if (defaultValue != null && !candidate.getClass().equals(defaultValue.getClass())) {
        // Branch 6 — TYPE_MISMATCH.
        return new EvaluationDetails<>(
            key,
            defaultValue,
            null,
            fetchTimeUnixMillis,
            effectiveUser,
            true,
            "TYPE_MISMATCH",
            null,
            null);
      }
      // Branch 7 — happy path.
      return new EvaluationDetails<>(
          key,
          overrideResult.getValue(),
          null,
          fetchTimeUnixMillis,
          effectiveUser,
          false,
          null,
          null,
          null);
    }

    final Evaluator.Result result =
        Evaluator.evaluate(configForEval(), key, defaultValue, effectiveUser);
    final String errorCode =
        result.getError() == Evaluator.Error.NONE ? null : result.getError().name();
    return new EvaluationDetails<>(
        key,
        result.getValue(),
        errorCode != null ? null : result.getVariationId(),
        fetchTimeUnixMillis,
        effectiveUser,
        errorCode != null,
        errorCode,
        result.hasMatchedTargetingRule() ? TargetingRule.MATCHED : null,
        result.hasMatchedPercentageOption() ? PercentageOption.MATCHED : null);
  }

  /**
   * Typed overload of {@link #getValueDetails(String, Object, User)} — mirrors the typed {@code
   * getValue} overload at {@code ConfeatureClient}'s API surface (spec 080 / FR-004).
   */
  @SuppressWarnings("unchecked")
  public <T> EvaluationDetails<T> getValueDetails(
      String key, T defaultValue, User user, Class<T> type) {
    final EvaluationDetails<Object> raw = getValueDetails(key, (Object) defaultValue, user);
    final Object rawValue = raw.getValue();
    final T typedValue;
    boolean isDefaultValue = raw.isDefaultValue();
    String error = raw.getError();
    if (rawValue == null) {
      typedValue = defaultValue;
    } else if (type.isInstance(rawValue)) {
      typedValue = (T) rawValue;
    } else {
      typedValue = defaultValue;
      isDefaultValue = true;
      if (error == null) {
        error = "TYPE_MISMATCH";
      }
    }
    return new EvaluationDetails<>(
        raw.getKey(),
        typedValue,
        raw.getVariationId(),
        raw.getFetchTimeUnixMilliseconds(),
        raw.getUser(),
        isDefaultValue,
        error,
        raw.getMatchedTargetingRule(),
        raw.getMatchedPercentageOption());
  }
}
