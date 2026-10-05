// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client;

/// <summary>
/// Identifies a polling mode variant. Used internally by the poll-service
/// factory; customers select a mode via the static factory members on
/// <see cref="PollingMode"/>.
/// </summary>
public enum PollingModeKind
{
    /// <summary><see cref="PollingMode.AutoPoll(TimeSpan?, TimeSpan?)"/>.</summary>
    AutoPoll = 0,

    /// <summary><see cref="PollingMode.LazyLoad(TimeSpan?)"/>.</summary>
    LazyLoad = 1,

    /// <summary><see cref="PollingMode.ManualPoll()"/>.</summary>
    ManualPoll = 2,
}

/// <summary>
/// Selects how <c>ConfeatureClient</c> refreshes the cached configuration.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors <c>ConfigCat.Client.PollingMode</c> 1:1 per constitution
/// Principle II. Three factory members cover the supported variants:
/// <see cref="AutoPoll(TimeSpan?, TimeSpan?)"/>,
/// <see cref="LazyLoad(TimeSpan?)"/>, and
/// <see cref="ManualPoll()"/>.
/// </para>
/// <para>
/// Defaults match ConfigCat verbatim (FR-013):
/// <list type="bullet">
///   <item><description><c>AutoPoll</c> → 60s poll, 5s init wait.</description></item>
///   <item><description><c>LazyLoad</c> → 60s cache refresh interval.</description></item>
///   <item><description><c>ManualPoll</c> → no automatic timing.</description></item>
/// </list>
/// </para>
/// </remarks>
public sealed class PollingMode
{
    private static readonly TimeSpan DefaultPollInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan DefaultMaxInitWaitTime = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan DefaultCacheRefreshInterval = TimeSpan.FromSeconds(60);

    private PollingMode(
        PollingModeKind kind,
        TimeSpan? pollInterval,
        TimeSpan? maxInitWaitTime,
        TimeSpan? cacheRefreshInterval)
    {
        Kind = kind;
        PollInterval = pollInterval;
        MaxInitWaitTime = maxInitWaitTime;
        CacheRefreshInterval = cacheRefreshInterval;
    }

    /// <summary>The variant of this polling mode.</summary>
    public PollingModeKind Kind { get; }

    /// <summary>The poll interval for <see cref="PollingModeKind.AutoPoll"/>; otherwise <c>null</c>.</summary>
    public TimeSpan? PollInterval { get; }

    /// <summary>The max init wait for <see cref="PollingModeKind.AutoPoll"/>; otherwise <c>null</c>.</summary>
    public TimeSpan? MaxInitWaitTime { get; }

    /// <summary>The cache refresh interval for <see cref="PollingModeKind.LazyLoad"/>; otherwise <c>null</c>.</summary>
    public TimeSpan? CacheRefreshInterval { get; }

    /// <summary>
    /// Constructs an <see cref="PollingModeKind.AutoPoll"/> mode that polls
    /// every <paramref name="pollInterval"/> with a first-fetch deadline
    /// of <paramref name="maxInitWaitTime"/>.
    /// </summary>
    /// <param name="pollInterval">Default: 60 seconds.</param>
    /// <param name="maxInitWaitTime">Default: 5 seconds.</param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// Thrown when either argument is non-positive.
    /// </exception>
    public static PollingMode AutoPoll(
        TimeSpan? pollInterval = null,
        TimeSpan? maxInitWaitTime = null)
    {
        var resolvedPoll = pollInterval ?? DefaultPollInterval;
        var resolvedMaxInit = maxInitWaitTime ?? DefaultMaxInitWaitTime;

        if (resolvedPoll <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(pollInterval),
                resolvedPoll,
                "pollInterval must be positive.");
        }

        if (resolvedMaxInit <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxInitWaitTime),
                resolvedMaxInit,
                "maxInitWaitTime must be positive.");
        }

        return new PollingMode(
            PollingModeKind.AutoPoll,
            resolvedPoll,
            resolvedMaxInit,
            cacheRefreshInterval: null);
    }

    /// <summary>
    /// Constructs a <see cref="PollingModeKind.LazyLoad"/> mode that
    /// fetches on-demand when the cache is older than
    /// <paramref name="cacheRefreshInterval"/>.
    /// </summary>
    /// <param name="cacheRefreshInterval">Default: 60 seconds.</param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// Thrown when the argument is non-positive.
    /// </exception>
    public static PollingMode LazyLoad(TimeSpan? cacheRefreshInterval = null)
    {
        var resolved = cacheRefreshInterval ?? DefaultCacheRefreshInterval;
        if (resolved <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(cacheRefreshInterval),
                resolved,
                "cacheRefreshInterval must be positive.");
        }

        return new PollingMode(
            PollingModeKind.LazyLoad,
            pollInterval: null,
            maxInitWaitTime: null,
            cacheRefreshInterval: resolved);
    }

    /// <summary>
    /// Constructs a <see cref="PollingModeKind.ManualPoll"/> mode that
    /// never fetches automatically; only an explicit
    /// <c>ConfeatureClient.ForceRefreshAsync</c> call triggers a fetch.
    /// </summary>
    public static PollingMode ManualPoll() => new(
        PollingModeKind.ManualPoll,
        pollInterval: null,
        maxInitWaitTime: null,
        cacheRefreshInterval: null);
}
