// SPDX-License-Identifier: MIT

using System;
using System.Threading;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Spec 106 / #268 — slice 4/14 — sdk-dotnet hooks/events bus.
/// </summary>
/// <remarks>
/// Mirrors the upstream <c>ConfigCat.Client.ConfigCatClient</c> hook events surface — five
/// CLR events (ClientReady, ConfigChanged, ConfigFetched, FlagEvaluated, Error). Conformance
/// lives in <see cref="ApiSurfaceConformanceTests"/>; this file exercises behaviour.
/// </remarks>
public class HooksTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private static ConfeatureClient BuildClient(Action<ConfeatureClientOptions>? extra = null)
    {
        return new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            extra?.Invoke(o);
        });
    }

    [Fact]
    public void Subscribers_can_register_for_all_five_hook_events()
    {
        // Smoke test — the five events exist on the client and accept the expected handler
        // shapes. Pins the API contract: a migrating ConfigCat consumer's subscription call
        // sites compile unchanged (Principle II — drop-in compatibility).
        using var client = BuildClient();
        client.ClientReady += (_, _) => { };
        client.ConfigChanged += (_, _) => { };
        client.ConfigFetched += (_, _) => { };
        client.FlagEvaluated += (_, _) => { };
        client.Error += (_, _) => { };
    }

    [Fact]
    public void FlagEvaluated_fires_on_GetValueDetails()
    {
        using var client = BuildClient();
        var fires = 0;
        client.FlagEvaluated += (_, _) => Interlocked.Increment(ref fires);

        client.GetValueDetails("feature.unknown", false);
        client.GetValueDetails("feature.unknown2", false);

        fires.Should().Be(2, because: "FlagEvaluated fires once per GetValueDetails call");
    }

    [Fact]
    public void Handler_exception_is_caught_and_does_not_break_others()
    {
        using var client = BuildClient();
        var downstreamFires = 0;
        client.FlagEvaluated += (_, _) => throw new InvalidOperationException("boom");
        client.FlagEvaluated += (_, _) => Interlocked.Increment(ref downstreamFires);

        client.GetValueDetails("feature.unknown", false);

        downstreamFires.Should().Be(
            1,
            because: "a throwing handler MUST NOT prevent later handlers from firing");
    }

    [Fact]
    public void ConfigChanged_event_args_carry_settings_property()
    {
        // Pin the shape of the event args — ConfigChangedEventArgs MUST expose `Settings`.
        var settingsProperty = typeof(ConfigChangedEventArgs).GetProperty("Settings");
        settingsProperty.Should().NotBeNull(
            because: "ConfigChangedEventArgs.Settings is the upstream-aligned payload");
    }

    [Fact]
    public void Error_event_args_carry_message_and_exception_properties()
    {
        var messageProperty = typeof(ConfeatureClientErrorEventArgs).GetProperty("Message");
        var exceptionProperty = typeof(ConfeatureClientErrorEventArgs).GetProperty("Exception");
        messageProperty.Should().NotBeNull();
        exceptionProperty.Should().NotBeNull();
    }
}
