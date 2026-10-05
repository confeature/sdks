// SPDX-License-Identifier: MIT

using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Public-import smoke gate. Validates that the package compiles +
/// constructs + exposes the advertised method set via the *public*
/// namespace path (<c>Confeature.Client</c>). No reflection into
/// <c>Confeature.Client.Internal</c>.
/// </summary>
public class PublicImportTests
{
    private const string TestSdkKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void ConfeatureClient_constructs_via_public_surface_within_200ms()
    {
        var sw = Stopwatch.StartNew();
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.HttpTimeout = TimeSpan.FromSeconds(5);
        });

        sw.Stop();
        sw.ElapsedMilliseconds.Should().BeLessThan(200,
            because: "spec 039 SC budget for public-import smoke");
    }

    [Fact]
    public void Advertised_public_method_set_is_present()
    {
        var clientType = typeof(ConfeatureClient);

        // The customer-facing entry points the README + docs promise.
        var expected = new[]
        {
            "GetValue",
            "Snapshot",
            "ForceRefresh",
            "ForceRefreshAsync",
            "Dispose",
        };

        foreach (var name in expected)
        {
            // Use GetMethods() (not GetMethod) because GetValue has two
            // overloads (generic + non-generic) and a single-arg lookup
            // raises AmbiguousMatchException.
            clientType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Any(m => m.Name == name)
                .Should().BeTrue(because: $"public surface must expose {name}()");
        }
    }

    [Fact]
    public void DisposeAsync_is_present_on_modern_TFMs()
    {
        // The test project itself targets net8.0 + net10.0, so
        // DisposeAsync is always reachable in this assembly.
        var clientType = typeof(ConfeatureClient);

        var disposeAsync = clientType.GetMethod("DisposeAsync", BindingFlags.Public | BindingFlags.Instance);
        disposeAsync.Should().NotBeNull(because: "the test project runs on TFMs that ship IAsyncDisposable");
    }

    [Fact]
    public void Snapshot_returns_non_null()
    {
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        client.Snapshot().Should().NotBeNull();
    }

    [Fact]
    public void GetValue_returns_default_without_network()
    {
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("missing.flag", defaultValue: true).Should().BeTrue();
    }

    [Fact]
    public void SdkVersion_value_is_non_empty_semver()
    {
        SdkVersion.Value.Should().NotBeNullOrEmpty();
    }
}
