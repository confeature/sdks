// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.ConfigOverrideDataSource;
import io.confeature.client.FlagOverrides;
import io.confeature.client.OverrideBehaviour;
import io.confeature.client.OverrideDataSource;
import io.confeature.client.User;
import java.util.Map;

/**
 * Synchronous override evaluation — port of the canonical TS {@code evaluateOverrideSync}.
 *
 * <p>7-branch decision tree, byte-identical to:
 *
 * <ul>
 *   <li>{@code packages/sdk-shared/src/override-eval.ts} (TS — canonical).
 *   <li>{@code apps/sdk-python/.../override_eval.py}.
 *   <li>{@code apps/sdk-go/internal/overrideeval/eval.go}.
 *   <li>{@code apps/sdk-dotnet/.../Internal/OverrideEval.cs}.
 * </ul>
 *
 * <p>The helper is intentionally pure: no logger access, no SDK-key access, no I/O. Pure data in →
 * typed override or sentinel out.
 */
public final class OverrideEval {

  private OverrideEval() {
    // Utility class.
  }

  /**
   * Result envelope. {@code found=false} → caller falls through to the cache (Branches 1-3). {@code
   * found=true} → {@code value} is the resolved override result, possibly the supplied default
   * (Branches 4-6: LocalOnly contract — don't fall through). Branch 7 returns the typed override
   * value.
   */
  public static final class EvalResult {
    private final boolean found;
    private final Object value;

    public EvalResult(boolean found, Object value) {
      this.found = found;
      this.value = value;
    }

    public boolean isFound() {
      return found;
    }

    public Object getValue() {
      return value;
    }
  }

  /**
   * Walks the 7-branch decision tree.
   *
   * <p>Algorithm — byte-identical to TS / Python / Go / .NET ports:
   *
   * <ol>
   *   <li>{@code flagOverrides == null} → {@code (false, null)} // fall through.
   *   <li>{@code behaviour != LOCAL_ONLY} → {@code (false, null)} // deferred.
   *   <li>{@code dataSource.getOverridesSync()} returns {@code null} → {@code (false, null)}.
   *   <li>key absent → {@code (true, defaultValue)} // LocalOnly contract.
   *   <li>candidate value {@code null} → {@code (true, defaultValue)} // empty override.
   *   <li>{@code candidate.getClass() != defaultValue.getClass()} (and default not null) → {@code
   *       (true, defaultValue)} // TYPE_MISMATCH.
   *   <li>happy path → {@code (true, candidate)}.
   * </ol>
   *
   * <p>The TYPE_MISMATCH branch (6) preserves the LocalOnly contract: a {@code null} default
   * bypasses the type check (matches the TS {@code defaultValue !== null} ternary; Java's {@code
   * null} is the equivalent sentinel).
   */
  public static EvalResult evaluateSync(
      FlagOverrides flagOverrides, String key, Object defaultValue) {
    // Branch 1: no overrides configured → caller falls through.
    if (flagOverrides == null) {
      return new EvalResult(false, null);
    }

    // Branch 2: non-LocalOnly behaviours short-circuit. (v1 enum only
    // declares LOCAL_ONLY, but this guard future-proofs the algorithm
    // for when LOCAL_OVER_REMOTE / REMOTE_OVER_LOCAL land.)
    if (flagOverrides.getBehaviour() != OverrideBehaviour.LOCAL_ONLY) {
      return new EvalResult(false, null);
    }

    // Branch 3: no synchronous data source available → fall through.
    final OverrideDataSource dataSource = flagOverrides.getDataSource();
    if (dataSource == null) {
      return new EvalResult(false, null);
    }
    final Map<String, Object> overrides = dataSource.getOverridesSync();
    if (overrides == null) {
      return new EvalResult(false, null);
    }

    // From here we are committed to the LocalOnly contract: NEVER fall
    // through to the cache — return either the typed override or the
    // supplied default.

    // Branch 4: key absent → return default.
    if (!overrides.containsKey(key)) {
      return new EvalResult(true, defaultValue);
    }

    // Branch 5: override slot empty / null → return default.
    final Object candidate = overrides.get(key);
    if (candidate == null) {
      return new EvalResult(true, defaultValue);
    }

    // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
    // A null defaultValue bypasses the check (matches the TS semantics).
    if (defaultValue != null && !candidate.getClass().equals(defaultValue.getClass())) {
      return new EvalResult(true, defaultValue);
    }

    // Branch 7: happy path — typed override value.
    return new EvalResult(true, candidate);
  }

  /**
   * Full-config override resolution — port of the canonical TS {@code
   * evaluateFullConfigOverrideSync} (spec 135 / #430).
   *
   * <p>When the override source is a {@link ConfigOverrideDataSource}, resolves {@code key} through
   * the real {@link Evaluator} so targeting rules / segments / prerequisites / percentage options
   * apply offline — the rule-bearing sibling of {@link #evaluateSync}'s flat lookup.
   *
   * <p>Returns {@code (false, null)} when overrides are absent, behaviour is non-LocalOnly, or the
   * source is NOT a full-config source (caller falls through to the flat-map helper). Returns
   * {@code (true, value)} with the rule-resolved value otherwise — the LocalOnly contract never
   * falls through to the cache (the evaluator already returns {@code defaultValue} for any
   * non-clean resolution).
   *
   * <p>INV-4: the evaluator receives the FULL config map (salt {@code p.s} + segments {@code s}),
   * never just {@code f} (the spec-129 dropped-salt regression class). The evaluator never throws —
   * any failure resolves to the caller's default.
   */
  private static EvalResult evaluateFullConfigSync(
      FlagOverrides flagOverrides, String key, Object defaultValue, User user) {
    if (flagOverrides == null
        || flagOverrides.getBehaviour() != OverrideBehaviour.LOCAL_ONLY
        || !(flagOverrides.getDataSource() instanceof ConfigOverrideDataSource)) {
      return new EvalResult(false, null);
    }

    final ConfigOverrideDataSource source =
        (ConfigOverrideDataSource) flagOverrides.getDataSource();
    // Pass the FULL config map (salt + segments + f), never just `f` (INV-4).
    final Evaluator.Result result = Evaluator.evaluate(source.getConfig(), key, defaultValue, user);
    return new EvalResult(true, result.getValue());
  }

  /**
   * Details-returning sibling of {@link #evaluate} for the FULL-config path — port of the canonical
   * TS {@code evaluateFullConfigOverrideDetailsSync} (#395 / spec 152 variationId parity).
   *
   * <p>When the override source is a {@link ConfigOverrideDataSource}, resolves {@code key} through
   * the real {@link Evaluator} against the FULL config map (salt {@code p.s} + segments {@code s} +
   * {@code f}, INV-4) and returns the COMPLETE {@link Evaluator.Result} — value + {@code
   * variationId} + matched targeting rule / percentage option. This is the seam the full-config
   * corpus surfaced as a null {@code variationId} through {@code getValueDetails} (the #395 gap):
   * the value path routes through the evaluator but the details path used the flat-map branches.
   *
   * <p>Returns {@code null} when overrides are absent, behaviour is non-LocalOnly, or the source is
   * NOT a full-config source — the caller then builds details on the flat-map / cache path.
   */
  public static Evaluator.Result evaluateFullConfigDetails(
      FlagOverrides flagOverrides, String key, Object defaultValue, User user) {
    if (flagOverrides == null
        || flagOverrides.getBehaviour() != OverrideBehaviour.LOCAL_ONLY
        || !(flagOverrides.getDataSource() instanceof ConfigOverrideDataSource)) {
      return null;
    }
    final ConfigOverrideDataSource source =
        (ConfigOverrideDataSource) flagOverrides.getDataSource();
    // Pass the FULL config map (salt + segments + f), never just `f` (INV-4).
    return Evaluator.evaluate(source.getConfig(), key, defaultValue, user);
  }

  /**
   * Shared override router — port of the canonical TS {@code evaluateOverride} (spec 135 / #430).
   * Dispatches between the flat-map path and the full-config path so the client call site changes
   * minimally.
   *
   * <p>A {@link ConfigOverrideDataSource} routes through the real {@link Evaluator}; every other
   * source (map / custom) keeps the existing byte-identical flat-map resolution. Dispatch is on the
   * source TYPE, not the resolved value, so a full-config source whose evaluator returns the
   * default still stays on the rule path. Preserves the LocalOnly no-fall-through contract on both
   * paths.
   */
  public static EvalResult evaluate(
      FlagOverrides flagOverrides, String key, Object defaultValue, User user) {
    if (flagOverrides != null
        && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY
        && flagOverrides.getDataSource() instanceof ConfigOverrideDataSource) {
      return evaluateFullConfigSync(flagOverrides, key, defaultValue, user);
    }
    return evaluateSync(flagOverrides, key, defaultValue);
  }
}
