// SPDX-License-Identifier: MIT

using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using RichardSzalay.MockHttp;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Integration tests exercising <see cref="ConfeatureClient"/>'s
/// fetch-and-apply pipeline against a mocked HTTP backend. Covers:
/// successful 200 → in-memory settings, ForceRefresh propagation, cache
/// restoration on construction, and MALFORMED_JSON error handling.
/// </summary>
public class ConfeatureClientNetworkTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private const string TestBaseUrl = "https://cdn.test.confeature.io";

    [Fact]
    public async Task ForceRefresh_with_200_response_populates_settings_for_GetValue()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        var refresh = await client.ForceRefreshAsync(System.Threading.CancellationToken.None);
        refresh.IsSuccess.Should().BeTrue();

        client.GetValue("feature.dark-mode", defaultValue: false).Should().BeTrue();
    }

    [Fact]
    public async Task ForceRefresh_with_malformed_JSON_returns_failure()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond("application/json", "<not-json>");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        var refresh = await client.ForceRefreshAsync(System.Threading.CancellationToken.None);

        refresh.IsSuccess.Should().BeFalse();
    }

    [Fact]
    public async Task ForceRefresh_with_500_response_returns_failure_and_keeps_client_usable()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond(HttpStatusCode.InternalServerError);
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        var refresh = await client.ForceRefreshAsync(System.Threading.CancellationToken.None);

        refresh.IsSuccess.Should().BeFalse();
        // Default surfaces because no settings ever landed.
        client.GetValue("feature.dark-mode", defaultValue: false).Should().BeFalse();
    }

    [Fact]
    public void Constructor_restores_persisted_cache_entry_so_GetValue_sees_it_without_a_fetch()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "confeature-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            // Hand-craft the envelope that PersistCacheEntry writes —
            // {body, etag, fetched_at}. Body uses the standard config_v6.json shape.
            var envelope = "{\"body\":{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}"
                + ",\"etag\":\"\\\"abc\\\"\",\"fetched_at\":1.0}";

            var seedCache = new Confeature.Client.Internal.FileSystemConfigCache(
                tempDir, new CapturingLogger());
            var cacheKey = Confeature.Client.Internal.SdkKey.DeriveCacheKey(TestSdkKey);
            seedCache.Write(cacheKey, envelope);

            using var client = new ConfeatureClient(TestSdkKey, o =>
            {
                o.PollingMode = PollingMode.ManualPoll();
                o.CacheDirectory = tempDir;
            });

            client.GetValue("feature.dark-mode", defaultValue: false).Should().BeTrue();
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                try
                {
                    Directory.Delete(tempDir, recursive: true);
                }
                catch (IOException)
                {
                    // Best-effort cleanup; not a failure signal.
                }
            }
        }
    }

    [Fact]
    public void Constructor_ignores_corrupt_cache_envelope_and_logs_warning()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "confeature-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            var seedCache = new Confeature.Client.Internal.FileSystemConfigCache(
                tempDir, new CapturingLogger());
            var cacheKey = Confeature.Client.Internal.SdkKey.DeriveCacheKey(TestSdkKey);
            seedCache.Write(cacheKey, "<not-json-at-all>");

            var logger = new CapturingLogger { LogLevel = LogLevel.Warning };
            using var client = new ConfeatureClient(TestSdkKey, o =>
            {
                o.PollingMode = PollingMode.ManualPoll();
                o.CacheDirectory = tempDir;
                o.Logger = logger;
            });

            // Default surfaces because the corrupt entry was ignored.
            client.GetValue("feature.dark-mode", defaultValue: false).Should().BeFalse();
            logger.MessagesAt(LogLevel.Warning).Should()
                .Contain(m => m.Contains("failed to restore cache entry"));
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                try
                {
                    Directory.Delete(tempDir, recursive: true);
                }
                catch (IOException)
                {
                    // Best-effort cleanup; not a failure signal.
                }
            }
        }
    }

    [Fact]
    public void Snapshot_exposes_evaluated_keys_after_refresh()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"a\":{\"t\":0,\"v\":{\"b\":true}},\"b\":{\"t\":0,\"v\":{\"b\":false}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        client.ForceRefresh();

        var snapshot = client.Snapshot();
        snapshot.GetAllKeys().Should().Equal("a", "b");
        snapshot.GetValue("a", defaultValue: false).Should().BeTrue();
        snapshot.GetValue("b", defaultValue: true).Should().BeFalse();
    }

    [Fact]
    public void Invalid_sdk_key_format_logs_warning_but_continues()
    {
        var logger = new CapturingLogger { LogLevel = LogLevel.Warning };

        using var client = new ConfeatureClient("not-a-valid-sdk-key-format", o =>
        {
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
            o.Logger = logger;
        });

        logger.MessagesAt(LogLevel.Warning).Should()
            .Contain(m => m.Contains("INVALID_SDK_KEY"));
    }
}
