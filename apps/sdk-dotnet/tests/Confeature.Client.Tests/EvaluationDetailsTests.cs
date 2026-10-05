// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using System.Threading.Tasks;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Spec 083 / #266 slice 5/12 — GetValueDetails + GetAllValues on
/// <see cref="ConfeatureClient"/> and <see cref="ConfeatureSnapshot"/>.
/// </summary>
/// <remarks>
/// Mirrors upstream <c>ConfigCat.Client</c>'s typed-details envelope +
/// bulk-read APIs. Sync and async siblings are both exercised so the
/// migrating consumer's call sites compile + behave identically.
/// </remarks>
public class EvaluationDetailsTests
{
    private const string ValidSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private static ConfeatureClient MakeClientWithOverrides(Dictionary<string, object> overridesMap)
    {
        return new ConfeatureClient(ValidSdkKey, options =>
        {
            options.PollingMode = PollingMode.ManualPoll();
            options.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(overridesMap),
                OverrideBehaviour.LocalOnly);
            options.CacheDirectory = ":memory:";
        });
    }

    [Fact]
    public void GetValueDetails_HappyPath_FromOverrides()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });

        var details = client.GetValueDetails("feature.x", false);

        details.Key.Should().Be("feature.x");
        details.Value.Should().BeTrue();
        details.IsDefaultValue.Should().BeFalse();
        details.ErrorMessage.Should().BeNull();
        details.VariationId.Should().BeNull();
        details.MatchedTargetingRule.Should().BeNull();
        details.MatchedPercentageOption.Should().BeNull();
    }

    [Fact]
    public async Task GetValueDetailsAsync_HappyPath_FromOverrides()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });

        var details = await client.GetValueDetailsAsync("feature.x", false);

        details.Value.Should().BeTrue();
        details.IsDefaultValue.Should().BeFalse();
        details.ErrorMessage.Should().BeNull();
    }

    [Fact]
    public void GetValueDetails_KeyNotFound_ReturnsDefault()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });

        var details = client.GetValueDetails<string>("feature.does-not-exist", "fallback");

        details.Value.Should().Be("fallback");
        details.IsDefaultValue.Should().BeTrue();
        details.ErrorMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public void GetValueDetails_OnDisposedClient_ReturnsClientClosed()
    {
        var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });
        client.Dispose();

        var details = client.GetValueDetails("feature.x", false);

        details.Value.Should().BeFalse();
        details.IsDefaultValue.Should().BeTrue();
        details.ErrorMessage.Should().Be("CLIENT_CLOSED");
    }

    [Fact]
    public async Task GetValueDetailsAsync_OnDisposedClient_ReturnsClientClosed()
    {
        var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });
        client.Dispose();

        var details = await client.GetValueDetailsAsync("feature.x", false);

        details.IsDefaultValue.Should().BeTrue();
        details.ErrorMessage.Should().Be("CLIENT_CLOSED");
    }

    [Fact]
    public void GetValueDetails_UserPropagation()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });
        var user = new User("alice@example.com");

        var details = client.GetValueDetails("feature.x", false, user);

        details.User.Should().BeSameAs(user);
    }

    [Fact]
    public void Snapshot_GetValueDetails_MirrorsClient()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["feature.x"] = true,
        });

        var snapshot = client.Snapshot();
        var details = snapshot.GetValueDetails("feature.x", false);

        details.Value.Should().BeTrue();
        details.IsDefaultValue.Should().BeFalse();
        details.ErrorMessage.Should().BeNull();
    }

    [Fact]
    public void GetAllValues_HappyPath_FromOverrides()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["a"] = true,
            ["b"] = "hello",
            ["c"] = 42,
        });

        var values = client.GetAllValues();

        values.Should().HaveCount(3);
        values["a"].Should().Be(true);
        values["b"].Should().Be("hello");
        values["c"].Should().Be(42);
    }

    [Fact]
    public async Task GetAllValuesAsync_HappyPath_FromOverrides()
    {
        using var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["a"] = true,
            ["b"] = "hello",
        });

        var values = await client.GetAllValuesAsync();

        values.Should().HaveCount(2);
        values["a"].Should().Be(true);
        values["b"].Should().Be("hello");
    }

    [Fact]
    public void GetAllValues_OnDisposedClient_ReturnsEmptyDictionary()
    {
        var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["x"] = true,
        });
        client.Dispose();

        var values = client.GetAllValues();

        values.Should().BeEmpty();
    }

    [Fact]
    public async Task GetAllValuesAsync_OnDisposedClient_ReturnsEmptyDictionary()
    {
        var client = MakeClientWithOverrides(new Dictionary<string, object>
        {
            ["x"] = true,
        });
        client.Dispose();

        var values = await client.GetAllValuesAsync();

        values.Should().BeEmpty();
    }
}
