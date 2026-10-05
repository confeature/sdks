// SPDX-License-Identifier: MIT

using System;
using System.Net.Http;
using System.Threading.Tasks;
using FluentAssertions;
using RichardSzalay.MockHttp;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Acceptance test for spec 039 User Story 4 (FR-029, LazyLoad lane).
/// Asserts the LazyLoad polling-mode wiring on a real
/// <see cref="ConfeatureClient"/>:
/// <list type="bullet">
///   <item><description>No eager fetch on construction.</description></item>
///   <item><description>First <c>GetValue</c> call triggers a fetch.</description></item>
///   <item><description>A second <c>GetValue</c> call before TTL expiry does NOT refetch.</description></item>
///   <item><description>A <c>GetValue</c> call after TTL expiry refetches.</description></item>
/// </list>
/// </summary>
public class PollingModeLazyLoadTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private const string TestBaseUrl = "https://cdn.test.confeature.io";

    [Fact]
    public async Task LazyLoad_does_not_fetch_eagerly_on_construction()
    {
        var mockHttp = new MockHttpMessageHandler();
        var matcher = mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.LazyLoad(cacheRefreshInterval: TimeSpan.FromMilliseconds(100));
            o.CacheDirectory = ":memory:";
        });

        // Quiet window: no GetValue, no fetch.
        await Task.Delay(150);

        mockHttp.GetMatchCount(matcher).Should().Be(0);
    }

    [Fact]
    public void LazyLoad_fires_fetch_on_first_GetValue_call()
    {
        var mockHttp = new MockHttpMessageHandler();
        var matcher = mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.LazyLoad(cacheRefreshInterval: TimeSpan.FromMilliseconds(100));
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("feature.dark-mode", defaultValue: false).Should().BeTrue();

        mockHttp.GetMatchCount(matcher).Should().Be(1);
    }

    [Fact]
    public void LazyLoad_does_not_refetch_within_TTL_window()
    {
        var mockHttp = new MockHttpMessageHandler();
        var matcher = mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.LazyLoad(cacheRefreshInterval: TimeSpan.FromSeconds(60));
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("feature.dark-mode", defaultValue: false);
        client.GetValue("feature.dark-mode", defaultValue: false);
        client.GetValue("feature.dark-mode", defaultValue: false);

        mockHttp.GetMatchCount(matcher).Should().Be(1);
    }

    [Fact]
    public async Task LazyLoad_refetches_after_TTL_expires()
    {
        var mockHttp = new MockHttpMessageHandler();
        var matcher = mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        using var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.LazyLoad(cacheRefreshInterval: TimeSpan.FromMilliseconds(100));
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("feature.dark-mode", defaultValue: false);
        mockHttp.GetMatchCount(matcher).Should().Be(1);

        await Task.Delay(150); // exceed TTL
        client.GetValue("feature.dark-mode", defaultValue: false);

        mockHttp.GetMatchCount(matcher).Should().Be(2);
    }
}
