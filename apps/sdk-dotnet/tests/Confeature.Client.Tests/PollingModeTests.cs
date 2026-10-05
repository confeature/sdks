// SPDX-License-Identifier: MIT

using System;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// Unit tests for <see cref="PollingMode"/>. Exercises each factory's
/// default-fill behaviour + the argument-range validation that mirrors
/// ConfigCat's <c>PollingMode</c> contract.
/// </summary>
public class PollingModeTests
{
    [Fact]
    public void AutoPoll_defaults_match_ConfigCat()
    {
        var mode = PollingMode.AutoPoll();

        mode.Kind.Should().Be(PollingModeKind.AutoPoll);
        mode.PollInterval.Should().Be(TimeSpan.FromSeconds(60));
        mode.MaxInitWaitTime.Should().Be(TimeSpan.FromSeconds(5));
        mode.CacheRefreshInterval.Should().BeNull();
    }

    [Fact]
    public void AutoPoll_honours_explicit_arguments()
    {
        var mode = PollingMode.AutoPoll(
            pollInterval: TimeSpan.FromSeconds(30),
            maxInitWaitTime: TimeSpan.FromSeconds(2));

        mode.PollInterval.Should().Be(TimeSpan.FromSeconds(30));
        mode.MaxInitWaitTime.Should().Be(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void AutoPoll_rejects_non_positive_pollInterval()
    {
        var act = () => PollingMode.AutoPoll(pollInterval: TimeSpan.Zero);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void AutoPoll_rejects_non_positive_maxInitWaitTime()
    {
        var act = () => PollingMode.AutoPoll(
            pollInterval: TimeSpan.FromSeconds(1),
            maxInitWaitTime: TimeSpan.FromSeconds(-1));

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void LazyLoad_defaults_match_ConfigCat()
    {
        var mode = PollingMode.LazyLoad();

        mode.Kind.Should().Be(PollingModeKind.LazyLoad);
        mode.CacheRefreshInterval.Should().Be(TimeSpan.FromSeconds(60));
        mode.PollInterval.Should().BeNull();
        mode.MaxInitWaitTime.Should().BeNull();
    }

    [Fact]
    public void LazyLoad_rejects_non_positive_cache_refresh()
    {
        var act = () => PollingMode.LazyLoad(cacheRefreshInterval: TimeSpan.Zero);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void ManualPoll_carries_no_timing_parameters()
    {
        var mode = PollingMode.ManualPoll();

        mode.Kind.Should().Be(PollingModeKind.ManualPoll);
        mode.PollInterval.Should().BeNull();
        mode.MaxInitWaitTime.Should().BeNull();
        mode.CacheRefreshInterval.Should().BeNull();
    }
}
