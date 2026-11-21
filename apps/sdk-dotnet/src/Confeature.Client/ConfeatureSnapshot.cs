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
    /// Uses the local override data in LocalOnly mode and the cached
    /// configuration otherwise. <see cref="EvaluationDetails{T}.FetchTime"/>
    /// is captured from the snapshot's construction time. Error codes
    /// match the parity corpus' tier-0 set (<c>KEY_NOT_FOUND</c>,
    /// <c>TYPE_MISMATCH</c>, <c>UNSUPPORTED_TYPE</c>, <c>NO_CONFIG</c>,
    /// <c>MALFORMED_VALUE</c>).
    /// </remarks>
    /// <typeparam name="T">Caller's expected value type.</typeparam>
    /// <param name="key">Flag key.</param>
    /// <param name="defaultValue">Fallback returned on any failure path.</param>
    /// <param name="user">Targeting context, or null to use the snapshot's default user.</param>
    public EvaluationDetails<T> GetValueDetails<T>(string key, T defaultValue, User? user = null) =>
        GetNativeValueDetails(key, defaultValue, user).Details;

    internal (EvaluationDetails<T> Details, EvaluationError Error) GetNativeValueDetails<T>(
        string key,
        T defaultValue,
        User? user) =>
        GetValueDetailsCore(key, defaultValue, user ?? _defaultUser, null, requireExactType: false);

    internal (EvaluationDetails<T> Details, EvaluationError Error) GetProviderValueDetails<T>(
        string key,
        T defaultValue,
        IEvalUser? user) =>
        GetValueDetailsCore(key, defaultValue, null, user, requireExactType: true);

    private (EvaluationDetails<T> Details, EvaluationError Error) GetValueDetailsCore<T>(
        string key,
        T defaultValue,
        User? nativeUser,
        IEvalUser? providerUser,
        bool requireExactType)
    {
        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        var settings = _settings;
        if (_flagOverrides?.OverrideBehaviour == OverrideBehaviour.LocalOnly)
        {
            if (_flagOverrides.DataSource is not ConfigOverrideDataSource source)
            {
                return GetFlatOverrideDetails(key, defaultValue, nativeUser, _flagOverrides.DataSource, requireExactType);
            }

            // Use the parsed full config so local rules retain their variation IDs.
            settings = source.Settings;
        }

        var attributes = nativeUser is null ? providerUser : new UserAttributes(nativeUser);
        var result = Evaluator.EvaluateCore(settings, key, defaultValue, attributes);
        // The legacy evaluator also accepts a null fallback for a type-erased read.
        if (requireExactType && result.Error == EvaluationError.None && result.Value is not T)
        {
            return BuildDetails(key, defaultValue, nativeUser, EvaluationError.TypeMismatch);
        }

        var value = result.Error == EvaluationError.None ? CoerceValue(result.Value, defaultValue) : defaultValue;
        return BuildDetails(key, value, nativeUser, result.Error, result);
    }

    private (EvaluationDetails<T> Details, EvaluationError Error) GetFlatOverrideDetails<T>(
        string key,
        T defaultValue,
        User? user,
        IOverrideDataSource source,
        bool requireExactType)
    {
        var map = source.GetOverridesSync();
        if (map is null || !map.TryGetValue(key, out var setting) || setting is null)
        {
            return BuildDetails(key, defaultValue, user, EvaluationError.KeyNotFound);
        }

        var rawValue = setting.GetRawValue();
        if (rawValue is null)
        {
            return BuildDetails(key, defaultValue, user, EvaluationError.MalformedValue);
        }

        if ((requireExactType || defaultValue is not null) && rawValue.GetType() != typeof(T))
        {
            return BuildDetails(key, defaultValue, user, EvaluationError.TypeMismatch);
        }

        return BuildDetails(key, CoerceValue(rawValue, defaultValue), user, EvaluationError.None);
    }

    private (EvaluationDetails<T> Details, EvaluationError Error) BuildDetails<T>(
        string key,
        T value,
        User? user,
        EvaluationError error,
        EvaluationResult? result = null)
    {
        var isDefault = error != EvaluationError.None;
        var details = new EvaluationDetails<T>
        {
            Key = key,
            Value = value,
            VariationId = isDefault ? null : result?.VariationId,
            IsDefaultValue = isDefault,
            ErrorMessage = MapEvaluationError(error),
            FetchTime = _fetchTime,
            User = user,
            MatchedTargetingRule = !isDefault && result?.MatchedRule == true ? new TargetingRule() : null,
            MatchedPercentageOption = !isDefault && result?.MatchedOption == true ? new PercentageOption() : null,
        };
        return (details, error);
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
