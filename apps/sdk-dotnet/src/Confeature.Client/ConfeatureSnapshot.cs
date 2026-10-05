// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using Confeature.Client.Internal;

namespace Confeature.Client;

/// <summary>
/// Immutable view of the last-fetched config + reference to the
/// <see cref="Client.FlagOverrides"/> bundle. Methods are synchronous
/// and safe to call after the originating <see cref="ConfeatureClient"/>
/// has been disposed.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="GetValue{T}"/> consults overrides FIRST via the 7-branch
/// decision tree (spec-036 correctness, inherited from day one).
/// </para>
/// </remarks>
public sealed class ConfeatureSnapshot
{
    private readonly IReadOnlyDictionary<string, Setting>? _settings;
    private readonly FlagOverrides? _flagOverrides;
    private readonly User? _defaultUser;
    private readonly DateTime _fetchTime;

    internal ConfeatureSnapshot(
        IReadOnlyDictionary<string, Setting>? settings,
        FlagOverrides? flagOverrides,
        User? defaultUser)
        : this(settings, flagOverrides, defaultUser, default)
    {
    }

    internal ConfeatureSnapshot(
        IReadOnlyDictionary<string, Setting>? settings,
        FlagOverrides? flagOverrides,
        User? defaultUser,
        DateTime fetchTime)
    {
        _settings = settings;
        _flagOverrides = flagOverrides;
        _defaultUser = defaultUser;
        _fetchTime = fetchTime;
    }

    /// <summary>
    /// Wall-clock UTC timestamp of the active config's last successful
    /// fetch (or cache restore). <see cref="DateTime.MinValue"/> /
    /// <c>default</c> until a config has loaded. Captured at snapshot
    /// construction time — immutable across the snapshot's life so
    /// every <see cref="EvaluationDetails{T}.FetchTime"/> served by the
    /// snapshot is consistent.
    /// </summary>
    public DateTime FetchTime => _fetchTime;

    /// <summary>
    /// Resolves <paramref name="key"/> against the snapshot. Honours
    /// overrides synchronously before falling through to the cached
    /// config.
    /// </summary>
    /// <typeparam name="T">The caller's expected value type.</typeparam>
    /// <param name="key">The flag key.</param>
    /// <param name="defaultValue">Fallback returned on any failure path.</param>
    /// <param name="user">Targeting context. Accepted but unused in v1.</param>
    public T GetValue<T>(string key, T defaultValue, User? user = null)
    {
        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        var effectiveUser = user ?? _defaultUser;

        // Override path FIRST — spec-036 correctness. Route through the
        // full-config-aware router (spec 135 / #429) so a rule-bearing
        // override source resolves targeting rules; the flat-map source is
        // unchanged.
        if (_flagOverrides is not null)
        {
            var (found, value) = OverrideEval.Evaluate(_flagOverrides, key, defaultValue, effectiveUser);
            if (found)
            {
                return CoerceValue(value, defaultValue);
            }
        }

        var result = Evaluator.Evaluate(_settings, key, defaultValue, effectiveUser);
        return CoerceValue(result.Value, defaultValue);
    }

    /// <summary>Non-generic overload used by the parity corpus.</summary>
    public object? GetValue(string key, object? defaultValue, User? user = null)
    {
        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        var effectiveUser = user ?? _defaultUser;

        if (_flagOverrides is not null)
        {
            var (found, value) = OverrideEval.EvaluateDynamic(_flagOverrides, key, defaultValue, effectiveUser);
            if (found)
            {
                return value;
            }
        }

        var result = Evaluator.EvaluateDynamic(_settings, key, defaultValue, effectiveUser);
        return result.Value ?? defaultValue;
    }

    /// <summary>
    /// Resolves <paramref name="key"/> and wraps the outcome in an
    /// <see cref="EvaluationDetails{T}"/> envelope. Mirrors ConfigCat's
    /// <c>ConfigCatClientSnapshot.GetValueDetails&lt;T&gt;</c> (spec 083 / #266).
    /// </summary>
    /// <remarks>
    /// Honours overrides FIRST (spec-036 correctness), then falls
    /// through to the v1 evaluator. <see cref="EvaluationDetails{T}.FetchTime"/>
    /// is captured from the snapshot's construction time. Error codes
    /// match the parity corpus' tier-0 set (<c>KEY_NOT_FOUND</c>,
    /// <c>TYPE_MISMATCH</c>, <c>UNSUPPORTED_TYPE</c>, <c>NO_CONFIG</c>,
    /// <c>MALFORMED_VALUE</c>).
    /// </remarks>
    /// <typeparam name="T">Caller's expected value type.</typeparam>
    /// <param name="key">Flag key.</param>
    /// <param name="defaultValue">Fallback returned on any failure path.</param>
    /// <param name="user">Targeting context. Accepted but unused in v1.</param>
    public EvaluationDetails<T> GetValueDetails<T>(string key, T defaultValue, User? user = null)
    {
        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        var effectiveUser = user ?? _defaultUser;

        // Full-config override (ConfigOverrideDataSource) FIRST — route through
        // the real evaluator so targeting rules / % options resolve offline AND
        // the matched VariationId propagates onto the details envelope (spec 152
        // / #475, the #395 gap class). The flat-map LocalOnly branch below only
        // sees base values and would null the VariationId.
        var (fullConfigFound, fullConfigResult) = OverrideEval.EvaluateFullConfigDetails(
            _flagOverrides, key, defaultValue, effectiveUser);
        if (fullConfigFound && fullConfigResult is not null)
        {
            var isDefaultFc = fullConfigResult.Error != EvaluationError.None;
            return new EvaluationDetails<T>
            {
                Key = key,
                Value = isDefaultFc ? defaultValue : CoerceValue(fullConfigResult.Value, defaultValue),
                VariationId = isDefaultFc ? null : fullConfigResult.VariationId,
                IsDefaultValue = isDefaultFc,
                ErrorMessage = MapEvaluationError(fullConfigResult.Error),
                FetchTime = _fetchTime,
                User = effectiveUser,
                MatchedTargetingRule = !isDefaultFc && fullConfigResult.MatchedRule ? new TargetingRule() : null,
                MatchedPercentageOption = !isDefaultFc && fullConfigResult.MatchedOption ? new PercentageOption() : null,
            };
        }

        // LocalOnly overrides commit to the override map (never fall through
        // to the cache). Distinguish KEY_NOT_FOUND vs override-hit vs
        // TYPE_MISMATCH by inspecting the map directly — OverrideEval's
        // `(found=true, value=defaultValue)` collapse hides those.
        if (_flagOverrides is not null
            && _flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly)
        {
            var overrideMap = _flagOverrides.DataSource.GetOverridesSync();
            if (overrideMap is null || !overrideMap.TryGetValue(key, out var overrideSetting) || overrideSetting is null)
            {
                return new EvaluationDetails<T>
                {
                    Key = key,
                    Value = defaultValue,
                    IsDefaultValue = true,
                    ErrorMessage = "KEY_NOT_FOUND",
                    FetchTime = _fetchTime,
                    User = effectiveUser,
                };
            }

            var rawOverride = overrideSetting.GetRawValue();
            if (rawOverride is null)
            {
                return new EvaluationDetails<T>
                {
                    Key = key,
                    Value = defaultValue,
                    IsDefaultValue = true,
                    ErrorMessage = "MALFORMED_VALUE",
                    FetchTime = _fetchTime,
                    User = effectiveUser,
                };
            }

            if (defaultValue is not null && rawOverride.GetType() != typeof(T))
            {
                return new EvaluationDetails<T>
                {
                    Key = key,
                    Value = defaultValue,
                    IsDefaultValue = true,
                    ErrorMessage = "TYPE_MISMATCH",
                    FetchTime = _fetchTime,
                    User = effectiveUser,
                };
            }

            return new EvaluationDetails<T>
            {
                Key = key,
                Value = CoerceValue(rawOverride, defaultValue),
                IsDefaultValue = false,
                ErrorMessage = null,
                FetchTime = _fetchTime,
                User = effectiveUser,
            };
        }

        var result = Evaluator.Evaluate(_settings, key, defaultValue, effectiveUser);
        var coercedFromCache = CoerceValue(result.Value, defaultValue);
        var errorCode = MapEvaluationError(result.Error);
        var isDefault = result.Error != EvaluationError.None;

        return new EvaluationDetails<T>
        {
            Key = key,
            Value = isDefault ? defaultValue : coercedFromCache,
            VariationId = isDefault ? null : result.VariationId,
            IsDefaultValue = isDefault,
            ErrorMessage = errorCode,
            FetchTime = _fetchTime,
            User = effectiveUser,
            MatchedTargetingRule = !isDefault && result.MatchedRule ? new TargetingRule() : null,
            MatchedPercentageOption = !isDefault && result.MatchedOption ? new PercentageOption() : null,
        };
    }

    /// <summary>
    /// Maps the internal <see cref="EvaluationError"/> enum to the stable
    /// uppercase string codes consumers see on
    /// <see cref="EvaluationDetails{T}.ErrorMessage"/>. Mirrors the
    /// codes used by sdk-java / sdk-android / sdk-python siblings.
    /// </summary>
    private static string? MapEvaluationError(EvaluationError error) => error switch
    {
        EvaluationError.None => null,
        EvaluationError.NoConfig => "NO_CONFIG",
        EvaluationError.KeyNotFound => "KEY_NOT_FOUND",
        EvaluationError.UnsupportedType => "UNSUPPORTED_TYPE",
        EvaluationError.TypeMismatch => "TYPE_MISMATCH",
        EvaluationError.MalformedValue => "MALFORMED_VALUE",
        EvaluationError.EvalException => "EVAL_EXCEPTION",
        _ => "UNKNOWN",
    };

    /// <summary>
    /// Returns the union of cached + override keys, sorted ascending for
    /// deterministic test output.
    /// </summary>
    public IReadOnlyList<string> GetAllKeys()
    {
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        if (_settings is not null)
        {
            foreach (var key in _settings.Keys)
            {
                seen.Add(key);
            }
        }

        if (_flagOverrides is not null)
        {
            var overridesMap = _flagOverrides.DataSource.GetOverridesSync();
            if (overridesMap is not null)
            {
                foreach (var key in overridesMap.Keys)
                {
                    seen.Add(key);
                }
            }
        }

        var list = new List<string>(seen.Count);
        foreach (var key in seen)
        {
            list.Add(key);
        }

        return list;
    }

    private static T CoerceValue<T>(object? raw, T defaultValue)
    {
        if (raw is T typed)
        {
            return typed;
        }

        if (raw is null)
        {
            return defaultValue;
        }

        return defaultValue;
    }
}
