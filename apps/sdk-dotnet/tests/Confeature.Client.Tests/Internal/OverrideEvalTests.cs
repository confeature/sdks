// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="OverrideEval"/>'s 7-branch decision tree.
/// Each branch is exercised by at least one test.
/// </summary>
public class OverrideEvalTests
{
    private static FlagOverrides Local(IReadOnlyDictionary<string, object> map) =>
        new(new MapOverrideDataSource(map), OverrideBehaviour.LocalOnly);

    [Fact]
    public void Branch1_no_overrides_falls_through()
    {
        var (found, value) = OverrideEval.EvaluateSync<bool>(flagOverrides: null, "k", defaultValue: false);

        found.Should().BeFalse();
        value.Should().BeNull();
    }

    [Fact]
    public void Branch2_non_LocalOnly_behaviour_falls_through()
    {
        var overrides = new FlagOverrides(
            new MapOverrideDataSource(new Dictionary<string, object> { ["k"] = true }),
            OverrideBehaviour.LocalOverRemote);

        var (found, _) = OverrideEval.EvaluateSync<bool>(overrides, "k", defaultValue: false);

        found.Should().BeFalse();
    }

    [Fact]
    public void Branch3_null_sync_data_source_falls_through()
    {
        var overrides = new FlagOverrides(new NullSyncDataSource(), OverrideBehaviour.LocalOnly);

        var (found, _) = OverrideEval.EvaluateSync<bool>(overrides, "k", defaultValue: false);

        found.Should().BeFalse();
    }

    [Fact]
    public void Branch4_key_absent_returns_default()
    {
        var overrides = Local(new Dictionary<string, object> { ["other"] = true });

        var (found, value) = OverrideEval.EvaluateSync<bool>(overrides, "missing", defaultValue: true);

        found.Should().BeTrue();
        value.Should().Be(true);
    }

    [Fact]
    public void Branch5_empty_slot_returns_default()
    {
        // We cannot construct a "null slot" SettingValue via the public
        // factory; bypass via a hand-built map.
        var overrides = new FlagOverrides(new EmptySettingDataSource(), OverrideBehaviour.LocalOnly);

        var (found, value) = OverrideEval.EvaluateSync<bool>(overrides, "k", defaultValue: false);

        found.Should().BeTrue();
        value.Should().Be(false);
    }

    [Fact]
    public void Branch6_type_mismatch_returns_default()
    {
        var overrides = Local(new Dictionary<string, object> { ["k"] = "string-value" });

        var (found, value) = OverrideEval.EvaluateSync<bool>(overrides, "k", defaultValue: false);

        found.Should().BeTrue();
        value.Should().Be(false);
    }

    [Fact]
    public void Branch7_happy_path_returns_typed_override()
    {
        var overrides = Local(new Dictionary<string, object> { ["k"] = true });

        var (found, value) = OverrideEval.EvaluateSync<bool>(overrides, "k", defaultValue: false);

        found.Should().BeTrue();
        value.Should().Be(true);
    }

    [Fact]
    public void EvaluateSyncDynamic_routes_int_default_through_TYPE_MISMATCH()
    {
        var overrides = Local(new Dictionary<string, object> { ["k"] = true });

        var (found, value) = OverrideEval.EvaluateSyncDynamic(overrides, "k", defaultValue: 42);

        found.Should().BeTrue();
        value.Should().Be(42);
    }

    [Fact]
    public void EvaluateSyncDynamic_returns_string_override_when_default_is_string()
    {
        var overrides = Local(new Dictionary<string, object> { ["k"] = "hello" });

        var (found, value) = OverrideEval.EvaluateSyncDynamic(overrides, "k", defaultValue: "default");

        found.Should().BeTrue();
        value.Should().Be("hello");
    }

    private sealed class NullSyncDataSource : IOverrideDataSource
    {
        public IReadOnlyDictionary<string, SettingValue>? GetOverridesSync() => null;
        public System.Threading.Tasks.Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
            System.Threading.CancellationToken cancellationToken = default) =>
            System.Threading.Tasks.Task.FromResult<IReadOnlyDictionary<string, SettingValue>>(
                new Dictionary<string, SettingValue>());
    }

    private sealed class EmptySettingDataSource : IOverrideDataSource
    {
        private readonly IReadOnlyDictionary<string, SettingValue> _map =
            new Dictionary<string, SettingValue> { ["k"] = new SettingValue() };

        public IReadOnlyDictionary<string, SettingValue>? GetOverridesSync() => _map;
        public System.Threading.Tasks.Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
            System.Threading.CancellationToken cancellationToken = default) =>
            System.Threading.Tasks.Task.FromResult(_map);
    }
}
