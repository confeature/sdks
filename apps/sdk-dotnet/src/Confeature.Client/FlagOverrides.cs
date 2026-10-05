// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;

namespace Confeature.Client;

/// <summary>
/// Pairs an <see cref="OverrideBehaviour"/> with an
/// <see cref="IOverrideDataSource"/>. Passed via
/// <c>ConfeatureClientOptions.FlagOverrides</c>.
/// </summary>
/// <remarks>
/// Mirrors <c>ConfigCat.Client.FlagOverrides</c> 1:1.
/// </remarks>
public sealed class FlagOverrides
{
    /// <summary>Initialises a new <see cref="FlagOverrides"/>.</summary>
    /// <param name="dataSource">
    /// The data source providing the override map. Must be non-null.
    /// </param>
    /// <param name="behaviour">
    /// How overrides interact with the remote config. Only
    /// <see cref="OverrideBehaviour.LocalOnly"/> is wired in v1; the other
    /// variants log a WARNING and fall back to <c>defaultValue</c>.
    /// </param>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="dataSource"/> is <c>null</c>.
    /// </exception>
    public FlagOverrides(IOverrideDataSource dataSource, OverrideBehaviour behaviour)
    {
        DataSource = dataSource ?? throw new ArgumentNullException(nameof(dataSource));
        OverrideBehaviour = behaviour;
    }

    /// <summary>The data source providing override values.</summary>
    public IOverrideDataSource DataSource { get; }

    /// <summary>The configured override behaviour.</summary>
    public OverrideBehaviour OverrideBehaviour { get; }

    /// <summary>
    /// Builds a <see cref="FlagOverrides"/> from a complete, rule-bearing
    /// <c>config_v6</c> blob (<c>{p, f, s}</c>) evaluated offline through the
    /// real evaluator.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Spec 135 / #429 (epic #382, US3) — additive, in-memory full-config
    /// override. ConfigCat's official .NET SDK exposes the value-only
    /// <c>FlagOverrides.LocalDictionary(...)</c> + the file-based
    /// <c>FlagOverrides.LocalFile(...)</c>; this is the runtime-agnostic
    /// in-memory equivalent of the file path (the corpus / test-harness use
    /// case), so a customer can drive the full rule engine from a config blob
    /// already resident in memory. Mirrors the JS federation's
    /// <c>createFlagOverridesFromConfig</c> and sdk-python's
    /// <c>create_flag_overrides_from_config</c>.
    /// </para>
    /// <para>
    /// Additive only (Principle II): no ConfigCat-named member is renamed or
    /// retyped, and the existing flat <see cref="MapOverrideDataSource"/> /
    /// <c>LocalOnly</c> path is byte-identical.
    /// </para>
    /// <para>
    /// With <see cref="OverrideBehaviour.LocalOnly"/>,
    /// <c>GetValue(key, default, user)</c> resolves targeting rules / segments
    /// / prerequisites / percentage options purely from <paramref name="config"/>
    /// through the real evaluator — no network fetch. The WHOLE config is
    /// retained (salt <c>p.s</c> + segments <c>s</c>, never just <c>f</c> —
    /// INV-4, the spec-129 dropped-salt regression class).
    /// </para>
    /// </remarks>
    /// <param name="config">
    /// The parsed full <c>config_v6</c> blob (<c>{p, f, s}</c>) as a
    /// <see cref="JsonElement"/>.
    /// </param>
    /// <param name="behaviour">
    /// How overrides interact with the remote config. Only
    /// <see cref="OverrideBehaviour.LocalOnly"/> is wired in v1.
    /// </param>
    public static FlagOverrides LocalConfig(JsonElement config, OverrideBehaviour behaviour) =>
        new(new ConfigOverrideDataSource(config), behaviour);
}

/// <summary>
/// Customer-replaceable abstraction over the override map.
/// </summary>
/// <remarks>
/// Customer implementations that only supply the async flavour fall back
/// gracefully — <see cref="GetOverridesSync"/> returning <c>null</c>
/// signals "no sync data; consult the async path".
/// </remarks>
public interface IOverrideDataSource
{
    /// <summary>
    /// Synchronous read. Returns <c>null</c> when no sync data is
    /// available — the override evaluator will then fall through to the
    /// async path.
    /// </summary>
    IReadOnlyDictionary<string, SettingValue>? GetOverridesSync();

    /// <summary>
    /// Async read. Awaited by the polling layer.
    /// </summary>
    Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
        CancellationToken cancellationToken = default);
}

/// <summary>
/// In-memory dictionary-backed override source — the production default.
/// </summary>
/// <remarks>
/// Converts each primitive value to a <see cref="SettingValue"/> slot
/// once at construction time and returns the same map on every call
/// (stable identity, which the override evaluator relies on for cheap
/// short-circuit checks).
/// </remarks>
public sealed class MapOverrideDataSource : IOverrideDataSource
{
    private readonly IReadOnlyDictionary<string, SettingValue> _map;

    /// <summary>
    /// Initialises a new <see cref="MapOverrideDataSource"/> from a
    /// dictionary of primitive override values.
    /// </summary>
    /// <param name="overrides">
    /// A dictionary mapping flag keys to <see cref="bool"/> /
    /// <see cref="string"/> / <see cref="int"/> / <see cref="double"/>
    /// override values. Other value types throw at construction time.
    /// </param>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="overrides"/> is <c>null</c>.
    /// </exception>
    /// <exception cref="ArgumentException">
    /// Thrown when any value is not one of the supported primitive types.
    /// </exception>
    public MapOverrideDataSource(IReadOnlyDictionary<string, object> overrides)
    {
        if (overrides is null)
        {
            throw new ArgumentNullException(nameof(overrides));
        }

        var converted = new Dictionary<string, SettingValue>(overrides.Count, StringComparer.Ordinal);
        foreach (var kvp in overrides)
        {
            converted[kvp.Key] = ToSettingValue(kvp.Key, kvp.Value);
        }

        _map = converted;
    }

    /// <inheritdoc />
    public IReadOnlyDictionary<string, SettingValue>? GetOverridesSync() => _map;

    /// <inheritdoc />
    public Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
        CancellationToken cancellationToken = default) => Task.FromResult(_map);

    private static SettingValue ToSettingValue(string key, object value)
    {
        // Order matters: bool MUST be checked before int (a C# bool is not
        // an int the way Python's is, but keeping the order explicit
        // mirrors the Python implementation byte-for-byte).
        return value switch
        {
            bool b => SettingValue.Of(b),
            string s => SettingValue.Of(s),
            int i => SettingValue.Of(i),
            double d => SettingValue.Of(d),
            null => throw new ArgumentException(
                $"Override value for key '{key}' is null; expected bool / string / int / double.",
                nameof(value)),
            _ => throw new ArgumentException(
                $"Unsupported override value type for key '{key}': {value.GetType().Name}. " +
                "Supported types are bool, string, int, double.",
                nameof(value)),
        };
    }
}

/// <summary>
/// Full-config override source — holds a complete parsed <c>config_v6</c>
/// blob (<c>{p, f, s}</c>) and routes through the real evaluator offline.
/// </summary>
/// <remarks>
/// <para>
/// Spec 135 / #429 (epic #382, US3): the rule-bearing sibling of
/// <see cref="MapOverrideDataSource"/>. Where the map source emits value-only
/// settings, this source retains the WHOLE <c>{p, f, s}</c> config — salt
/// (<c>p.s</c>) + segments (<c>s</c>) + rule-bearing settings (<c>f</c>) — so
/// the evaluator can resolve targeting rules / segments / prerequisites /
/// percentage options purely from the supplied config, no network fetch.
/// </para>
/// <para>
/// Additive extension (Principle II): ConfigCat's official .NET SDK only
/// exposes a <em>file-based</em> full-config override
/// (<c>FlagOverrides.LocalFile</c>). This in-memory form is the
/// runtime-agnostic equivalent, mirroring the JS federation's
/// <c>ConfigOverrideDataSource</c> / <c>createFlagOverridesFromConfig</c> and
/// sdk-python's <c>ConfigOverrideDataSource</c>.
/// </para>
/// <para>
/// The whole config is parsed once at construction (the salt + segments are
/// stamped on every parsed <c>Setting</c> by <c>ConfigParser</c>; never just
/// <c>f</c> — INV-4, the spec-129 dropped-salt regression class). The override
/// router (<c>OverrideEval.EvaluateFullConfigSync</c>) dispatches on the source
/// TYPE so a <see cref="ConfigOverrideDataSource"/> always routes through the
/// evaluator, never the flat-map path.
/// </para>
/// <para>
/// <see cref="GetOverridesSync"/> returns the value-only base envelopes of the
/// settings (so <c>GetAllKeys</c> / <c>GetAllValues</c> / <c>GetValueDetails</c>
/// can enumerate the override's keys); rule resolution itself never goes
/// through this flat map.
/// </para>
/// </remarks>
public sealed class ConfigOverrideDataSource : IOverrideDataSource
{
    private readonly IReadOnlyDictionary<string, SettingValue> _baseValues;

    /// <summary>
    /// Parses <paramref name="config"/> (the full <c>{p, f, s}</c> blob) into
    /// the evaluator's settings model once, retaining salt + segments.
    /// </summary>
    /// <param name="config">The parsed full <c>config_v6</c> blob.</param>
    public ConfigOverrideDataSource(JsonElement config)
    {
        Settings = ConfigParser.Parse(config) ?? new Dictionary<string, Setting>(StringComparer.Ordinal);

        var baseValues = new Dictionary<string, SettingValue>(Settings.Count, StringComparer.Ordinal);
        foreach (var kvp in Settings)
        {
            if (kvp.Value?.V is not null)
            {
                baseValues[kvp.Key] = kvp.Value.V;
            }
        }

        _baseValues = baseValues;
    }

    /// <summary>
    /// The parsed, rule-bearing settings (salt + segments stamped on each).
    /// Consumed by the full-config override router, never the flat-map path.
    /// </summary>
    internal IReadOnlyDictionary<string, Setting> Settings { get; }

    /// <inheritdoc />
    public IReadOnlyDictionary<string, SettingValue>? GetOverridesSync() => _baseValues;

    /// <inheritdoc />
    public Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
        CancellationToken cancellationToken = default) => Task.FromResult(_baseValues);
}
