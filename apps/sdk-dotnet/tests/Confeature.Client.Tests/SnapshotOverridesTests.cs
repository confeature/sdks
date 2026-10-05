// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// spec-036 correctness gate for the .NET SDK. The snapshot path MUST
/// consult flag overrides synchronously — no thread wait, no waitFor
/// workaround. Inherited from day one for the .NET SDK (same gate
/// shape as the Python + Go inheritances).
/// </summary>
public class SnapshotOverridesTests
{
    private const string TestSdkKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void Snapshot_honours_overrides_synchronously()
    {
        var overrides = new Dictionary<string, object>
        {
            ["feature.dark-mode"] = true,
            ["feature.beta-toggle"] = false,
        };
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overrides),
                OverrideBehaviour.LocalOnly);
            o.CacheDirectory = ":memory:";
        });

        var snap = client.Snapshot();

        snap.GetValue("feature.dark-mode", false).Should().Be(true);
        snap.GetValue("feature.beta-toggle", true).Should().Be(false);
        snap.GetValue("missing.flag", "fallback").Should().Be("fallback");
    }

    [Fact]
    public void GetValue_on_client_honours_overrides_synchronously()
    {
        var overrides = new Dictionary<string, object> { ["k"] = true };
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overrides),
                OverrideBehaviour.LocalOnly);
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("k", false).Should().Be(true);
    }

    [Fact]
    public void Snapshot_GetAllKeys_returns_union_sorted()
    {
        var overrides = new Dictionary<string, object> { ["a"] = true, ["b"] = false };
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overrides),
                OverrideBehaviour.LocalOnly);
            o.CacheDirectory = ":memory:";
        });

        var keys = client.Snapshot().GetAllKeys();

        keys.Should().Equal("a", "b");
    }
}
