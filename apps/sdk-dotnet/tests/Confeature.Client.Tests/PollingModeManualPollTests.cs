// SPDX-License-Identifier: MIT

using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using RichardSzalay.MockHttp;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Acceptance test for spec 039 User Story 4 (FR-029, ManualPoll lane).
/// Asserts that <see cref="PollingMode.ManualPoll"/>:
/// <list type="bullet">
///   <item><description>Fires zero requests on construction.</description></item>
///   <item><description>Fires zero requests after several <c>GetValue</c> calls.</description></item>
///   <item><description>Fires its first request only when <c>ForceRefreshAsync</c> runs.</description></item>
/// </list>
/// </summary>
public class PollingModeManualPollTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private const string TestBaseUrl = "https://cdn.test.confeature.io";

    [Fact]
    public async Task ManualPoll_fires_zero_requests_on_construction()
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
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        // Quiet window: confirm no background fetch happens.
        await Task.Delay(150);

        mockHttp.GetMatchCount(matcher).Should().Be(0);
    }

    [Fact]
    public void ManualPoll_fires_zero_requests_when_GetValue_called_repeatedly()
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
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        client.GetValue("feature.dark-mode", defaultValue: false);
        client.GetValue("feature.dark-mode", defaultValue: false);
        client.GetValue("feature.dark-mode", defaultValue: false);

        mockHttp.GetMatchCount(matcher).Should().Be(0);
    }

    [Fact]
    public async Task ManualPoll_fires_first_request_only_on_ForceRefreshAsync()
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
            o.PollingMode = PollingMode.ManualPoll();
            o.CacheDirectory = ":memory:";
        });

        mockHttp.GetMatchCount(matcher).Should().Be(0);

        var result = await client.ForceRefreshAsync(CancellationToken.None);

        result.IsSuccess.Should().BeTrue();
        mockHttp.GetMatchCount(matcher).Should().Be(1);
    }
}
