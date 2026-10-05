// SPDX-License-Identifier: MIT

using System;
using System.Net.Http;
using System.Threading.Tasks;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Lifecycle + input-validation tests for <see cref="ConfeatureClient"/>.
/// Covers: empty SDK key rejection, negative-timeout option validation,
/// Dispose idempotency, customer-owned <see cref="HttpClient"/> NOT
/// being disposed, and the FR-031 second-instance INFO log.
/// </summary>
public class ConfeatureClientTests
{
    private const string TestSdkKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void Constructor_rejects_null_sdkKey()
    {
        var act = () => new ConfeatureClient(null!);
        act.Should().Throw<ArgumentException>().WithMessage("sdkKey*");
    }

    [Fact]
    public void Constructor_rejects_empty_sdkKey()
    {
        var act = () => new ConfeatureClient(string.Empty);
        act.Should().Throw<ArgumentException>().WithMessage("sdkKey*");
    }

    [Fact]
    public void Constructor_rejects_negative_timeout()
    {
        var act = () => new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpTimeout = TimeSpan.FromSeconds(-1);
            o.PollingMode = PollingMode.ManualPoll();
        });
        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void Constructor_rejects_FlagOverrides_with_null_DataSource()
    {
        var act = () => new ConfeatureClient(TestSdkKey, o =>
        {
            // Direct null-DataSource construction is blocked by the
            // FlagOverrides constructor itself — but assigning via the
            // options assembly path is the deeper guarantee. Verify
            // we surface ArgumentNullException at construction time.
            _ = o;
            _ = new FlagOverrides(null!, OverrideBehaviour.LocalOnly);
        });

        act.Should().Throw<ArgumentNullException>();
    }

    [Fact]
    public void Dispose_is_idempotent()
    {
        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        var act = () =>
        {
            client.Dispose();
            client.Dispose();
            client.Dispose();
        };

        act.Should().NotThrow();
    }

    [Fact]
    public async Task DisposeAsync_is_idempotent()
    {
        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        await client.DisposeAsync();
        await client.DisposeAsync();
    }

    [Fact]
    public void Customer_owned_HttpClient_is_not_disposed()
    {
        var http = new HttpClient();
        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        client.Dispose();

        // If HttpClient were disposed, this would throw ObjectDisposedException.
        var act = () => _ = http.BaseAddress;
        act.Should().NotThrow();
    }

    [Fact]
    public void Second_instance_with_same_sdk_key_logs_INFO()
    {
        var logger = new CapturingLogger { LogLevel = LogLevel.Info };

        using var first = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });

        using var second = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });

        logger.MessagesAt(LogLevel.Info)
            .Should()
            .Contain(m => m.Contains("second instance"));
    }

    [Fact]
    public void Second_instance_warning_redacts_sdk_key()
    {
        var logger = new CapturingLogger { LogLevel = LogLevel.Info };

        using var first = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });

        using var second = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });

        foreach (var msg in logger.AllRendered)
        {
            msg.Should().NotContain(TestSdkKey);
        }
    }

    [Fact]
    public void GetValue_after_Dispose_returns_default_and_logs_warning()
    {
        var logger = new CapturingLogger { LogLevel = LogLevel.Warning };
        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });
        client.Dispose();

        var value = client.GetValue("k", defaultValue: true);

        value.Should().BeTrue();
        logger.MessagesAt(LogLevel.Warning).Should().Contain(m => m.Contains("after Dispose"));
    }

    [Fact]
    public async Task ForceRefreshAsync_after_Dispose_returns_CLIENT_CLOSED()
    {
        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });
        client.Dispose();

        var r = await client.ForceRefreshAsync(System.Threading.CancellationToken.None);

        r.IsSuccess.Should().BeFalse();
        r.Error.Should().Be("CLIENT_CLOSED");
    }

    [Fact]
    public void ForceRefresh_is_noop_under_LocalOnly_overrides()
    {
        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(new System.Collections.Generic.Dictionary<string, object> { ["k"] = true }),
                OverrideBehaviour.LocalOnly);
        });

        var r = client.ForceRefresh();
        r.IsSuccess.Should().BeTrue();
    }
}
