// SPDX-License-Identifier: MIT

namespace Confeature.Client.Internal;

/// <summary>
/// Synchronous override evaluation — port of the canonical TS
/// <c>evaluateOverrideSync</c>.
/// </summary>
/// <remarks>
/// <para>
/// 7-branch decision tree, byte-identical to:
/// </para>
/// <list type="bullet">
/// <item><description><c>packages/sdk-shared/src/override-eval.ts</c> (TS — canonical).</description></item>
/// <item><description><c>apps/sdk-python/.../override_eval.py</c>.</description></item>
/// <item><description><c>apps/sdk-go/internal/overrideeval/eval.go</c>.</description></item>
/// </list>
/// <para>
/// The helper is intentionally pure: no logger access, no SDK-key access,
/// no I/O. Pure data in → typed override or sentinel out.
/// </para>
/// </remarks>
internal static class OverrideEval
{
    /// <summary>
    /// Resolves <paramref name="key"/> synchronously against
    /// <paramref name="flagOverrides"/>.
    /// </summary>
    /// <typeparam name="T">The caller's expected value type.</typeparam>
    /// <param name="flagOverrides">The configured override pair, or <c>null</c>.</param>
    /// <param name="key">The flag key to resolve.</param>
    /// <param name="defaultValue">The caller's fallback.</param>
    /// <returns>
    /// <c>(false, null)</c> → caller falls through to cache-driven evaluation.
    /// <c>(true, value)</c> → <paramref name="key"/> is resolved (the value
    /// may be <paramref name="defaultValue"/> under the LocalOnly contract).
    /// </returns>
    public static (bool Found, object? Value) EvaluateSync<T>(
        FlagOverrides? flagOverrides,
        string key,
        T defaultValue)
    {
        // Branch 1: no overrides configured → caller falls through.
        if (flagOverrides is null)
        {
            return (false, null);
        }

        // Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
        // LocalOverRemote / RemoteOverLocal are deferred — the caller path
        // logs a WARNING and returns defaultValue, but THAT layer happens
        // at the client boundary. Here we simply fall through.
        if (flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly)
        {
            return (false, null);
        }

        // Branch 3: no synchronous data source available → fall through.
        var overridesMap = flagOverrides.DataSource.GetOverridesSync();
        if (overridesMap is null)
        {
            return (false, null);
        }

        // From here we are committed to the LocalOnly contract: NEVER fall
        // through to the cache — return either the typed override or the
        // supplied default.

        // Branch 4: key absent → return default.
        if (!overridesMap.TryGetValue(key, out var setting) || setting is null)
        {
            return (true, defaultValue);
        }

        // Branch 5: override slot empty → return default.
        // Slot order matches the canonical TS chain `raw.b ?? raw.s ?? raw.i ?? raw.d`.
        var candidate = setting.GetRawValue();
        if (candidate is null)
        {
            return (true, defaultValue);
        }

        // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
        // A null defaultValue intentionally bypasses the check (matches
        // the TS `defaultValue !== null` semantics). `default(T)` for an
        // unconstrained generic is the C# equivalent sentinel.
        if (defaultValue is not null && candidate.GetType() != typeof(T))
        {
            return (true, defaultValue);
        }

        // Branch 7: happy path — typed override value.
        return (true, candidate);
    }

    /// <summary>
    /// Non-generic counterpart of <see cref="EvaluateSync{T}"/>. The
    /// caller supplies <paramref name="defaultValue"/> as <c>object?</c>;
    /// the runtime type of <paramref name="defaultValue"/> is used for
    /// the TYPE_MISMATCH check.
    /// </summary>
    /// <remarks>
    /// Mirrors the 7-branch decision tree of <see cref="EvaluateSync{T}"/>
    /// exactly. Used by the public non-generic
    /// <c>ConfeatureClient.GetValue(string, object?, User?)</c> overload
    /// — which is the entry point the parity corpus consumes.
    /// </remarks>
    public static (bool Found, object? Value) EvaluateSyncDynamic(
        FlagOverrides? flagOverrides,
        string key,
        object? defaultValue)
    {
        if (flagOverrides is null)
        {
            return (false, null);
        }

        if (flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly)
        {
            return (false, null);
        }

        var overridesMap = flagOverrides.DataSource.GetOverridesSync();
        if (overridesMap is null)
        {
            return (false, null);
        }

        if (!overridesMap.TryGetValue(key, out var setting) || setting is null)
        {
            return (true, defaultValue);
        }

        var candidate = setting.GetRawValue();
        if (candidate is null)
        {
            return (true, defaultValue);
        }

        if (defaultValue is not null && candidate.GetType() != defaultValue.GetType())
        {
            return (true, defaultValue);
        }

        return (true, candidate);
    }

    /// <summary>
    /// Full-config override resolution — port of the canonical TS
    /// <c>evaluateFullConfigOverrideSync</c> (spec 135 / #429).
    /// </summary>
    /// <remarks>
    /// <para>
    /// When the override source is a <see cref="ConfigOverrideDataSource"/>,
    /// resolves <paramref name="key"/> through the real evaluator so targeting
    /// rules / segments / prerequisites / percentage options apply offline —
    /// the rule-bearing sibling of <see cref="EvaluateSync{T}"/>'s flat lookup.
    /// </para>
    /// <para>
    /// Returns <c>(false, null)</c> when overrides are absent, behaviour is
    /// non-LocalOnly, or the source is NOT a full-config source (caller falls
    /// through to the flat-map helper). Returns <c>(true, value)</c> with the
    /// rule-resolved value otherwise — the LocalOnly contract never falls
    /// through to the cache (the evaluator already returns
    /// <paramref name="defaultValue"/> for any non-clean resolution).
    /// </para>
    /// <para>
    /// INV-4: the evaluator receives the parsed FULL config (salt <c>p.s</c> +
    /// segments <c>s</c> stamped on each setting by <c>ConfigParser</c>), never
    /// just <c>f</c> (the spec-129 dropped-salt regression class).
    /// </para>
    /// </remarks>
    private static (bool Found, object? Value) EvaluateFullConfigSync(
        FlagOverrides? flagOverrides,
        string key,
        object? defaultValue,
        User? user)
    {
        if (flagOverrides is null
            || flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly
            || flagOverrides.DataSource is not ConfigOverrideDataSource source)
        {
            return (false, null);
        }

        // Pass the parsed FULL config (salt + segments + f), never just `f`
        // (INV-4). The evaluator never throws — any failure resolves to the
        // caller's default.
        var result = Evaluator.EvaluateDynamic(source.Settings, key, defaultValue, user);
        return (true, result.Value ?? defaultValue);
    }

    /// <summary>
    /// Full-config override resolution that preserves the FULL evaluation
    /// envelope (value + VariationId + matched-rule / option + error) — the
    /// details-producing sibling of <see cref="EvaluateFullConfigSync"/>
    /// (spec 152 / #475, the #395 VariationId-through-override gap class).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns <c>(false, null)</c> when overrides are absent, behaviour is
    /// non-LocalOnly, or the source is NOT a full-config source (caller falls
    /// through to the flat-map details path). Returns <c>(true, result)</c>
    /// with the rule-resolved <see cref="EvaluationResult"/> otherwise — so a
    /// <c>GetValueDetails</c> call through a <see cref="ConfigOverrideDataSource"/>
    /// surfaces the matched VariationId, exactly as a CDN-served config would.
    /// </para>
    /// <para>
    /// INV-4: the evaluator receives the parsed FULL config (salt + segments
    /// stamped on each setting), never just <c>f</c>.
    /// </para>
    /// </remarks>
    public static (bool Found, EvaluationResult? Result) EvaluateFullConfigDetails(
        FlagOverrides? flagOverrides,
        string key,
        object? defaultValue,
        User? user)
    {
        if (flagOverrides is null
            || flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly
            || flagOverrides.DataSource is not ConfigOverrideDataSource source)
        {
            return (false, null);
        }

        return (true, Evaluator.EvaluateDynamic(source.Settings, key, defaultValue, user));
    }

    /// <summary>
    /// Shared override router — port of the canonical TS <c>evaluateOverride</c>
    /// (spec 135 / #429). Dispatches between the flat-map path and the
    /// full-config path so the client call site changes minimally.
    /// </summary>
    /// <remarks>
    /// A <see cref="ConfigOverrideDataSource"/> routes through the real
    /// evaluator; every other source (map / custom) keeps the existing
    /// byte-identical flat-map resolution. Dispatch is on the source TYPE, not
    /// the resolved value, so a full-config source whose evaluator returns the
    /// default still stays on the rule path. Preserves the LocalOnly
    /// no-fall-through contract on both paths.
    /// </remarks>
    public static (bool Found, object? Value) Evaluate<T>(
        FlagOverrides? flagOverrides,
        string key,
        T defaultValue,
        User? user)
    {
        if (flagOverrides is not null
            && flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly
            && flagOverrides.DataSource is ConfigOverrideDataSource)
        {
            return EvaluateFullConfigSync(flagOverrides, key, defaultValue, user);
        }

        return EvaluateSync(flagOverrides, key, defaultValue);
    }

    /// <summary>
    /// Non-generic counterpart of <see cref="Evaluate{T}"/> — dispatches the
    /// full-config path to the evaluator, every other source to the flat-map
    /// <see cref="EvaluateSyncDynamic"/>.
    /// </summary>
    public static (bool Found, object? Value) EvaluateDynamic(
        FlagOverrides? flagOverrides,
        string key,
        object? defaultValue,
        User? user)
    {
        if (flagOverrides is not null
            && flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly
            && flagOverrides.DataSource is ConfigOverrideDataSource)
        {
            return EvaluateFullConfigSync(flagOverrides, key, defaultValue, user);
        }

        return EvaluateSyncDynamic(flagOverrides, key, defaultValue);
    }
}
