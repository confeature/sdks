// SPDX-License-Identifier: MIT

using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for the three <see cref="IPollService"/> impls. Covers
/// auto-poll timer cadence, lazy-load on-demand staleness, manual-poll
/// no-fetch-on-construction, and the cancellation-after-dispose
/// invariant.
/// </summary>
public class PollServiceTests
{
    [Fact]
    public async Task AutoPoll_runs_eager_initial_fetch_on_Start()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new AutoPollService(
            pollInterval: TimeSpan.FromSeconds(60),
            maxInitWaitTime: TimeSpan.FromMilliseconds(500),
            logger: new CapturingLogger());
        service.Start(Cb);

        // Eager fetch is synchronous on Start.
        count.Should().Be(1);

        await service.DisposeAsync();
    }

    [Fact]
    public async Task AutoPoll_fires_periodically_at_pollInterval()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new AutoPollService(
            pollInterval: TimeSpan.FromMilliseconds(80),
            maxInitWaitTime: TimeSpan.FromMilliseconds(50),
            logger: new CapturingLogger());
        service.Start(Cb);

        // 1 eager + at least ~3 periodic in 400ms.
        await Task.Delay(400);

        await service.DisposeAsync();
        count.Should().BeGreaterThanOrEqualTo(3);
    }

    [Fact]
    public async Task AutoPoll_halts_within_50ms_of_Dispose()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new AutoPollService(
            pollInterval: TimeSpan.FromMilliseconds(30),
            maxInitWaitTime: TimeSpan.FromMilliseconds(50),
            logger: new CapturingLogger());
        service.Start(Cb);

        await service.DisposeAsync();
        var sealedCount = count;
        await Task.Delay(150);

        // No further callbacks fire after Dispose. Allow at most one
        // in-flight callback to land during the dispose window.
        count.Should().BeLessThanOrEqualTo(sealedCount + 1);
    }

    [Fact]
    public async Task AutoPoll_Dispose_is_idempotent()
    {
        var service = new AutoPollService(
            pollInterval: TimeSpan.FromSeconds(60),
            maxInitWaitTime: TimeSpan.FromMilliseconds(50),
            logger: new CapturingLogger());
        service.Start(_ => Task.FromResult(RefreshResult.Success));

        await service.DisposeAsync();
        await service.DisposeAsync(); // must not throw

        service.Dispose();
        service.Dispose(); // must not throw
    }

    [Fact]
    public async Task AutoPoll_logs_warning_when_eager_initial_fetch_throws()
    {
        var logger = new CapturingLogger();
        Task<RefreshResult> ThrowingCb(CancellationToken ct) =>
            throw new System.Net.Http.HttpRequestException("simulated network error");

        var service = new AutoPollService(
            pollInterval: TimeSpan.FromSeconds(60),
            maxInitWaitTime: TimeSpan.FromMilliseconds(500),
            logger: logger);

        // Start blocks on the eager fetch; the throw must be caught and
        // logged at Warning, not silently swallowed (constitution Rule 4).
        service.Start(ThrowingCb);

        var warnings = logger.MessagesAt(LogLevel.Warning);
        warnings.Should().ContainSingle(m =>
            m.Contains("AutoPoll initial fetch failed", StringComparison.Ordinal)
            && m.Contains("HttpRequestException", StringComparison.Ordinal));

        await service.DisposeAsync();
    }

    [Fact]
    public async Task AutoPoll_logs_warning_when_periodic_fetch_throws()
    {
        var logger = new CapturingLogger();
        var firstCall = true;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            // First call (eager initial fetch) succeeds so the periodic
            // timer is the lane under test; subsequent (timer) ticks throw.
            if (firstCall)
            {
                firstCall = false;
                return Task.FromResult(RefreshResult.Success);
            }

            throw new System.Net.Http.HttpRequestException("simulated periodic network error");
        }

        var service = new AutoPollService(
            pollInterval: TimeSpan.FromMilliseconds(60),
            maxInitWaitTime: TimeSpan.FromMilliseconds(50),
            logger: logger);
        service.Start(Cb);

        // Poll for the warning instead of a fixed Task.Delay so the
        // assertion races correctly against the ThreadPool-scheduled tick.
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(2);
        while (DateTime.UtcNow < deadline
               && !logger.MessagesAt(LogLevel.Warning).Any(m =>
                   m.Contains("AutoPoll periodic fetch failed", StringComparison.Ordinal)))
        {
            await Task.Delay(20);
        }

        await service.DisposeAsync();

        logger.MessagesAt(LogLevel.Warning).Should().Contain(m =>
            m.Contains("AutoPoll periodic fetch failed", StringComparison.Ordinal)
            && m.Contains("HttpRequestException", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LazyLoad_does_not_fetch_eagerly()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new LazyLoadService(TimeSpan.FromMilliseconds(50));
        service.Start(Cb);

        await Task.Delay(100);
        count.Should().Be(0);

        await service.DisposeAsync();
    }

    [Fact]
    public async Task LazyLoad_fetches_on_first_MaybeFetch_call()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new LazyLoadService(TimeSpan.FromMilliseconds(50));
        service.Start(Cb);

        await service.MaybeFetchForGetValueAsync(CancellationToken.None);
        count.Should().Be(1);

        // Second call before TTL expires → no fetch.
        await service.MaybeFetchForGetValueAsync(CancellationToken.None);
        count.Should().Be(1);

        // After TTL expires → fetch again.
        await Task.Delay(80);
        await service.MaybeFetchForGetValueAsync(CancellationToken.None);
        count.Should().Be(2);

        await service.DisposeAsync();
    }

    [Fact]
    public async Task ManualPoll_does_not_fetch_on_construction_or_Start()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new ManualPollService();
        service.Start(Cb);

        await Task.Delay(50);
        count.Should().Be(0);
    }

    [Fact]
    public async Task ManualPoll_fetches_only_on_ForceRefreshAsync()
    {
        var count = 0;
        Task<RefreshResult> Cb(CancellationToken ct)
        {
            Interlocked.Increment(ref count);
            return Task.FromResult(RefreshResult.Success);
        }

        var service = new ManualPollService();
        service.Start(Cb);

        var r = await service.ForceRefreshAsync(CancellationToken.None);
        r.IsSuccess.Should().BeTrue();
        count.Should().Be(1);
    }

    [Fact]
    public async Task ForceRefreshAsync_returns_NOT_STARTED_when_callback_absent()
    {
        var service = new ManualPollService();
        var r = await service.ForceRefreshAsync(CancellationToken.None);

        r.IsSuccess.Should().BeFalse();
        r.Error.Should().Be("NOT_STARTED");
    }

    [Fact]
    public void Factory_routes_PollingMode_to_correct_service_impl()
    {
        var logger = new CapturingLogger();
        PollServiceFactory.Make(PollingMode.AutoPoll(TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(5)), logger)
            .Should().BeOfType<AutoPollService>();
        PollServiceFactory.Make(PollingMode.LazyLoad(TimeSpan.FromSeconds(60)), logger)
            .Should().BeOfType<LazyLoadService>();
        PollServiceFactory.Make(PollingMode.ManualPoll(), logger)
            .Should().BeOfType<ManualPollService>();
    }
}
