// SPDX-License-Identifier: MIT

using System.Collections.Generic;
using System.Threading.Tasks;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Spec 094 / #267 — slice 5/14 — sdk-dotnet online/offline triplet.
/// </summary>
/// <remarks>
/// Mirrors the upstream <c>ConfigCat.Client.ConfigCatClient.SetOnline()</c> /
/// <c>SetOffline()</c> methods and <c>IsOffline</c> property, including the LocalOnly +
/// closed-client edge cases. Conformance lives in <see cref="ApiSurfaceConformanceTests"/>;
/// this file exercises behaviour.
/// </remarks>
public class OnlineOfflineTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private static ConfeatureClient BuildClient(System.Action<ConfeatureClientOptions>? extra = null)
    {
        return new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            extra?.Invoke(o);
        });
    }

    private static FlagOverrides LocalOnlyOverride() =>
        new FlagOverrides(
            new MapOverrideDataSource(new Dictionary<string, object> { ["feature.x"] = true }),
            OverrideBehaviour.LocalOnly);

    // ── default state ────────────────────────────────────────────────────

    [Fact]
    public void Freshly_constructed_client_is_online()
    {
        using var client = BuildClient();
        client.IsOffline.Should().BeFalse();
    }

    // ── basic state transitions ──────────────────────────────────────────

    [Fact]
    public void SetOffline_flips_the_flag()
    {
        using var client = BuildClient();
        client.SetOffline();
        client.IsOffline.Should().BeTrue();
    }

    [Fact]
    public void SetOnline_resets_the_flag()
    {
        using var client = BuildClient();
        client.SetOffline();
        client.IsOffline.Should().BeTrue();
        client.SetOnline();
        client.IsOffline.Should().BeFalse();
    }

    [Fact]
    public void Setters_are_idempotent()
    {
        using var client = BuildClient();
        client.SetOffline();
        client.SetOffline();
        client.SetOffline();
        client.IsOffline.Should().BeTrue();
        client.SetOnline();
        client.SetOnline();
        client.SetOnline();
        client.IsOffline.Should().BeFalse();
    }

    // ── forceRefresh interaction ─────────────────────────────────────────

    [Fact]
    public async Task ForceRefreshAsync_while_offline_returns_failure()
    {
        using var client = BuildClient();
        client.SetOffline();
        var outcome = await client.ForceRefreshAsync(default).ConfigureAwait(true);
        outcome.IsSuccess.Should().BeFalse();
        outcome.Error.Should().Be("OFFLINE_MODE");
    }

    [Fact]
    public void ForceRefresh_while_offline_returns_failure_sync()
    {
        using var client = BuildClient();
        client.SetOffline();
        var outcome = client.ForceRefresh();
        outcome.IsSuccess.Should().BeFalse();
        outcome.Error.Should().Be("OFFLINE_MODE");
    }

    // ── LocalOnly semantics ──────────────────────────────────────────────

    [Fact]
    public void LocalOnly_client_is_offline_by_definition()
    {
        using var client = BuildClient(o => o.FlagOverrides = LocalOnlyOverride());
        client.IsOffline.Should().BeTrue();
    }

    [Fact]
    public void LocalOnly_SetOnline_is_no_op()
    {
        using var client = BuildClient(o => o.FlagOverrides = LocalOnlyOverride());
        client.SetOnline();
        client.IsOffline.Should().BeTrue("LocalOnly still reports offline=true");
    }

    [Fact]
    public void LocalOnly_SetOffline_is_no_op()
    {
        using var client = BuildClient(o => o.FlagOverrides = LocalOnlyOverride());
        client.SetOffline();
        client.IsOffline.Should().BeTrue();
    }

    // ── Closed-client semantics ──────────────────────────────────────────

    [Fact]
    public void Closed_client_reports_offline()
    {
        var client = BuildClient();
        client.Dispose();
        client.IsOffline.Should().BeTrue();
    }

    [Fact]
    public void Closed_client_SetOnline_is_no_op()
    {
        var client = BuildClient();
        client.Dispose();
        // Should not throw — SetOnline on disposed client is a warning + no-op.
        var act = () => client.SetOnline();
        act.Should().NotThrow();
    }

    [Fact]
    public void Closed_client_SetOffline_is_no_op()
    {
        var client = BuildClient();
        client.Dispose();
        var act = () => client.SetOffline();
        act.Should().NotThrow();
    }

    // ── GetValue still serves cached config / overrides while offline ────

    [Fact]
    public void LocalOnly_GetValue_works_while_offline()
    {
        using var client = BuildClient(o => o.FlagOverrides = LocalOnlyOverride());
        // LocalOnly is already offline; override path still resolves.
        var v = client.GetValue("feature.x", false, null);
        v.Should().Be(true);
    }
}
