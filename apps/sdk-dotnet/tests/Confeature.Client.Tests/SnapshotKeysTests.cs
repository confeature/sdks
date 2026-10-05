// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Unit tests for <see cref="ConfeatureSnapshot.GetAllKeys"/>. Verifies
/// the snapshot returns the union of cached + override keys, sorted
/// ordinally for deterministic output.
/// </summary>
public class SnapshotKeysTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void GetAllKeys_returns_override_keys_only_when_no_config_cached()
    {
        using var client = new ConfeatureClient(TestSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.CacheDirectory = ":memory:";
            options.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(new Dictionary<string, object>
                {
                    ["alpha"] = true,
                    ["beta"] = false,
                    ["zeta"] = true,
                }),
                OverrideBehaviour.LocalOnly);
        });

        var keys = client.Snapshot().GetAllKeys();

        keys.Should().Equal("alpha", "beta", "zeta");
    }

    [Fact]
    public void GetAllKeys_returns_empty_list_for_no_overrides_no_config()
    {
        using var client = new ConfeatureClient(TestSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.CacheDirectory = ":memory:";
        });

        var keys = client.Snapshot().GetAllKeys();

        keys.Should().BeEmpty();
    }
}
