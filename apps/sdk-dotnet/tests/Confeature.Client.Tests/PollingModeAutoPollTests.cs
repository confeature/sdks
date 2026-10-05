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
/// Acceptance test for spec 039 User Story 4 (FR-029, AutoPoll lane).
/// Drives a real <see cref="ConfeatureClient"/> through a mocked HTTP
/// backend and counts requests via <see cref="MockHttpMessageHandler"/>'s
/// per-mock counter. Mirrors the ConfigCat AutoPoll semantics:
/// <list type="bullet">
///   <item><description>One request fires immediately on construction.</description></item>
///   <item><description>≥ 3 requests fire in 400 ms with a 100 ms cadence.</description></item>
///   <item><description><c>Dispose</c> halts the timer within 50 ms.</description></item>
/// </list>
/// </summary>
public class PollingModeAutoPollTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private const string TestBaseUrl = "https://cdn.test.confeature.io";

    [Fact]
    public async Task AutoPoll_fires_first_request_eagerly_on_construction()
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
            o.PollingMode = PollingMode.AutoPoll(
                pollInterval: TimeSpan.FromSeconds(60),
                maxInitWaitTime: TimeSpan.FromMilliseconds(500));
            o.CacheDirectory = ":memory:";
        });

        // The eager fetch is scheduled on a thread-pool task during
        // Start; give it up to 250ms to land. Without the small wait
        // the assertion races against the timer scheduling.
        await WaitForAtLeastAsync(() => mockHttp.GetMatchCount(matcher), threshold: 1, timeout: TimeSpan.FromMilliseconds(250));

        mockHttp.GetMatchCount(matcher).Should().BeGreaterThanOrEqualTo(1);
    }

    [Fact]
    public async Task AutoPoll_with_100ms_interval_fires_at_least_3_requests_in_400ms()
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
            o.PollingMode = PollingMode.AutoPoll(
                pollInterval: TimeSpan.FromMilliseconds(100),
                maxInitWaitTime: TimeSpan.FromMilliseconds(50));
            o.CacheDirectory = ":memory:";
        });

        // 400ms window with 100ms cadence + eager fetch → expect 4-5
        // hits in steady state. Lower bound of 3 absorbs scheduling jitter.
        await Task.Delay(400);

        mockHttp.GetMatchCount(matcher).Should().BeGreaterThanOrEqualTo(3);
    }

    [Fact]
    public async Task AutoPoll_halts_further_fetches_within_50ms_of_Dispose()
    {
        var mockHttp = new MockHttpMessageHandler();
        var matcher = mockHttp.When("*").Respond(
            "application/json",
            "{\"f\":{\"feature.dark-mode\":{\"t\":0,\"v\":{\"b\":true}}}}");
        using var http = new HttpClient(mockHttp);

        var client = new ConfeatureClient(TestSdkKey, o =>
        {
            o.HttpClient = http;
            o.BaseUrl = TestBaseUrl;
            o.PollingMode = PollingMode.AutoPoll(
                pollInterval: TimeSpan.FromMilliseconds(50),
                maxInitWaitTime: TimeSpan.FromMilliseconds(50));
            o.CacheDirectory = ":memory:";
        });

        // Let a couple of polls happen.
        await Task.Delay(150);
        client.Dispose();
        var sealedCount = mockHttp.GetMatchCount(matcher);

        // 50ms grace for any in-flight callback to land, then assert no
        // further requests fire across a 200ms quiet window.
        await Task.Delay(50);
        var postDisposeFloor = mockHttp.GetMatchCount(matcher);
        await Task.Delay(200);
        var postDisposeCeiling = mockHttp.GetMatchCount(matcher);

        // At most one in-flight request may land during the 50ms grace
        // window; nothing may land after that.
        postDisposeFloor.Should().BeLessThanOrEqualTo(sealedCount + 1);
        postDisposeCeiling.Should().Be(postDisposeFloor);
    }

    /// <summary>
    /// Polls <paramref name="probe"/> at 10ms intervals until it returns
    /// a value ≥ <paramref name="threshold"/> or <paramref name="timeout"/>
    /// elapses. Avoids a fixed Task.Delay that may pass before the
    /// thread-pool task has had a chance to run.
    /// </summary>
    private static async Task WaitForAtLeastAsync(Func<int> probe, int threshold, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (probe() >= threshold)
            {
                return;
            }

            await Task.Delay(10);
        }
    }
}
