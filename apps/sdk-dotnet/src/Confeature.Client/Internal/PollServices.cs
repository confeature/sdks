// SPDX-License-Identifier: MIT

using System;
using System.Threading;
using System.Threading.Tasks;

namespace Confeature.Client.Internal;

/// <summary>
/// Outcome of an <see cref="IPollService.ForceRefreshAsync"/> call.
/// </summary>
internal sealed class RefreshResult
{
    /// <summary>Convenience instance: the fetch (200 or 304) succeeded.</summary>
    public static readonly RefreshResult Success = new() { IsSuccess = true };

    /// <summary>Convenience constructor for a failure with a short reason code.</summary>
    public static RefreshResult Failure(string reason) => new() { IsSuccess = false, Error = reason };

    /// <summary><c>true</c> when the underlying fetch returned 200 or 304.</summary>
    public bool IsSuccess { get; init; }

    /// <summary>Short, key-free reason code on failure. Empty on success.</summary>
    public string Error { get; init; } = string.Empty;
}

/// <summary>
/// Callback invoked by the polling layer to perform one fetch +
/// cache-apply round-trip. Returns a <see cref="RefreshResult"/>.
/// </summary>
internal delegate Task<RefreshResult> FetchCallback(CancellationToken cancellationToken);

/// <summary>
/// Polymorphic polling surface. Three impls: AutoPoll, LazyLoad, ManualPoll.
/// </summary>
/// <remarks>
/// <para>Lifecycle (mirrors Go + Python pollservice):</para>
/// <list type="bullet">
///   <item><description><see cref="Start"/>: idempotent. AutoPoll runs the eager initial fetch (bounded by MaxInitWaitTime) then starts the timer. LazyLoad / ManualPoll just record the callback.</description></item>
///   <item><description><see cref="ForceRefreshAsync"/>: invokes the callback synchronously.</description></item>
///   <item><description><see cref="MaybeFetchForGetValueAsync"/>: LazyLoad's on-demand hook. Other modes return immediately.</description></item>
///   <item><description><see cref="DisposeAsync"/> / <see cref="IDisposable.Dispose"/>: idempotent (Interlocked.Exchange on _disposed). AutoPoll halts its timer + cancels the running fetch within ~50ms.</description></item>
/// </list>
/// </remarks>
internal interface IPollService : IDisposable
{
    /// <summary>Records the fetch callback. Idempotent.</summary>
    void Start(FetchCallback callback);

    /// <summary>Invokes the callback synchronously. Returns the fetch outcome.</summary>
    Task<RefreshResult> ForceRefreshAsync(CancellationToken cancellationToken);

    /// <summary>LazyLoad's on-demand staleness check + fetch. Other modes return immediately.</summary>
    Task MaybeFetchForGetValueAsync(CancellationToken cancellationToken);

    /// <summary>Async dispose. Idempotent. Waits up to 5s for in-flight work.</summary>
    Task DisposeAsync();
}

/// <summary>
/// Factory: builds the right service for the supplied <see cref="PollingMode"/>.
/// </summary>
internal static class PollServiceFactory
{
    public static IPollService Make(PollingMode mode, IConfeatureLogger logger)
    {
        if (mode is null)
        {
            throw new ArgumentNullException(nameof(mode));
        }

        if (logger is null)
        {
            throw new ArgumentNullException(nameof(logger));
        }

        return mode.Kind switch
        {
            PollingModeKind.AutoPoll => new AutoPollService(
                mode.PollInterval ?? TimeSpan.FromSeconds(60),
                mode.MaxInitWaitTime ?? TimeSpan.FromSeconds(5),
                logger),
            PollingModeKind.LazyLoad => new LazyLoadService(
                mode.CacheRefreshInterval ?? TimeSpan.FromSeconds(60)),
            PollingModeKind.ManualPoll => new ManualPollService(),
            _ => new ManualPollService(),
        };
    }
}

/// <summary>
/// Background-poll variant. Spawns a <see cref="Timer"/> that fires
/// at <c>pollInterval</c>; runs an eager initial fetch on
/// <see cref="Start"/> bounded by <c>maxInitWaitTime</c>.
/// </summary>
internal sealed class AutoPollService : IPollService
{
    private readonly TimeSpan _pollInterval;
    private readonly TimeSpan _maxInitWaitTime;
    private readonly IConfeatureLogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _gate = new();

    private FetchCallback? _callback;
    private Timer? _timer;
    private int _started;
    private int _disposed;

    public AutoPollService(TimeSpan pollInterval, TimeSpan maxInitWaitTime, IConfeatureLogger logger)
    {
        if (pollInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(pollInterval), pollInterval, "pollInterval must be positive.");
        }

        if (maxInitWaitTime <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(maxInitWaitTime), maxInitWaitTime, "maxInitWaitTime must be positive.");
        }

        _pollInterval = pollInterval;
        _maxInitWaitTime = maxInitWaitTime;
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <inheritdoc />
    public void Start(FetchCallback callback)
    {
        if (callback is null)
        {
            throw new ArgumentNullException(nameof(callback));
        }

        // sync start; idempotent. The eager fetch runs synchronously
        // (bounded by MaxInitWaitTime) so the first GetValue from the
        // customer's code hits a populated config when possible.
        if (Interlocked.CompareExchange(ref _started, 1, 0) != 0)
        {
            return;
        }

        if (Volatile.Read(ref _disposed) == 1)
        {
            return;
        }

        lock (_gate)
        {
            _callback = callback;
        }

        // Eager initial fetch, bounded by MaxInitWaitTime.
        RunEagerInitialFetch(callback);

        // Spawn the periodic timer. dueTime = pollInterval so the next
        // fetch fires one interval after the eager one (matches Python +
        // Go behaviour).
        var timer = new Timer(OnTimerTick, state: null, dueTime: _pollInterval, period: _pollInterval);
        Timer? old;
        lock (_gate)
        {
            old = _timer;
            _timer = timer;
        }

        old?.Dispose();
    }

    private void RunEagerInitialFetch(FetchCallback callback)
    {
        using var initCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        initCts.CancelAfter(_maxInitWaitTime);
        try
        {
            // Block the calling thread up to maxInitWaitTime — same
            // contract as Python (start() blocks until first fetch
            // returns or the timer expires).
            _ = callback(initCts.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            // Init deadline hit OR client disposed mid-fetch — both are
            // benign. The customer's first GetValue will resolve against
            // whatever is in the cache (possibly defaultValue).
        }
        catch (Exception ex)
        {
            // Belt-and-braces: the callback fail-closes inside ConfigFetcher
            // already; this guard prevents a customer-thrown override-source
            // exception from killing initial start-up. Log at Warning so the
            // failure is observable instead of being silently swallowed.
            // The type name only: an exception message may quote the
            // request URL, which carries the SDK key (#803 FR-002).
            _logger.Warning($"AutoPoll initial fetch failed: {ex.GetType().Name}");
        }
    }

    private void OnTimerTick(object? state)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return;
        }

        FetchCallback? cb;
        lock (_gate)
        {
            cb = _callback;
        }

        if (cb is null)
        {
            return;
        }

        // Fire-and-forget the periodic fetch. Errors are absorbed by the
        // callback (which fail-closes inside ConfigFetcher); a top-level
        // exception here would terminate the timer.
        _ = Task.Run(async () =>
        {
            try
            {
                await cb(_cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Client disposed mid-tick. Stop quietly.
            }
            catch (Exception ex)
            {
                // Same fail-closed rationale as RunEagerInitialFetch. Log
                // at Warning so periodic failures surface to the customer's
                // log sink instead of being silently swallowed.
                _logger.Warning($"AutoPoll periodic fetch failed: {ex.GetType().Name}");
            }
        });
    }

    /// <inheritdoc />
    public async Task<RefreshResult> ForceRefreshAsync(CancellationToken cancellationToken)
    {
        FetchCallback? cb;
        lock (_gate)
        {
            cb = _callback;
        }

        if (cb is null)
        {
            return RefreshResult.Failure("NOT_STARTED");
        }

        return await cb(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public Task MaybeFetchForGetValueAsync(CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        // AutoPoll fetches on a schedule; nothing to do on-demand.
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public void Dispose()
    {
        // Synchronous dispose blocks on DisposeAsync. Acceptable since
        // the timer + CTS are cheap to tear down.
        DisposeAsync().GetAwaiter().GetResult();
    }

    /// <inheritdoc />
    public async Task DisposeAsync()
    {
        if (Interlocked.CompareExchange(ref _disposed, 1, 0) != 0)
        {
            return;
        }

        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // CTS was disposed by a concurrent Dispose — benign.
        }

        Timer? timer;
        lock (_gate)
        {
            timer = _timer;
            _timer = null;
        }

        if (timer is not null)
        {
            // Timer.DisposeAsync waits for any in-flight callback to
            // finish (or fail). Bounded by the callback's own cancellation
            // honouring + the 5s ForceRefresh-style budget upstream.
            //
            // Gate on net8.0+ only: Timer.DisposeAsync was added in .NET Core
            // 3.0 and lives in .NET 6/8/10, but is NOT in the netstandard2.1
            // reference assembly (netstandard2.1 froze before that API
            // shipped). The synchronous Dispose() fallback covers both
            // netstandard2.0 and netstandard2.1 consumers.
#if NET8_0_OR_GREATER
            await timer.DisposeAsync().ConfigureAwait(false);
#else
            timer.Dispose();
            await Task.CompletedTask.ConfigureAwait(false);
#endif
        }

        _cts.Dispose();
    }
}

/// <summary>
/// Lazy variant. Refreshes on <see cref="MaybeFetchForGetValueAsync"/>
/// if the cache is older than <c>cacheRefreshInterval</c>.
/// </summary>
internal sealed class LazyLoadService : IPollService
{
    private readonly TimeSpan _cacheRefreshInterval;
    private readonly object _gate = new();
    private FetchCallback? _callback;
    private DateTime _lastFetchedAtUtc = DateTime.MinValue;
    private int _disposed;

    public LazyLoadService(TimeSpan cacheRefreshInterval)
    {
        if (cacheRefreshInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(cacheRefreshInterval),
                cacheRefreshInterval,
                "cacheRefreshInterval must be positive.");
        }

        _cacheRefreshInterval = cacheRefreshInterval;
    }

    /// <inheritdoc />
    public void Start(FetchCallback callback)
    {
        if (callback is null)
        {
            throw new ArgumentNullException(nameof(callback));
        }

        lock (_gate)
        {
            _callback = callback;
        }
    }

    /// <inheritdoc />
    public async Task<RefreshResult> ForceRefreshAsync(CancellationToken cancellationToken)
    {
        FetchCallback? cb;
        lock (_gate)
        {
            cb = _callback;
        }

        if (cb is null)
        {
            return RefreshResult.Failure("NOT_STARTED");
        }

        var result = await cb(cancellationToken).ConfigureAwait(false);
        if (result.IsSuccess)
        {
            lock (_gate)
            {
                _lastFetchedAtUtc = DateTime.UtcNow;
            }
        }

        return result;
    }

    /// <inheritdoc />
    public async Task MaybeFetchForGetValueAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return;
        }

        FetchCallback? cb;
        DateTime lastFetched;
        lock (_gate)
        {
            cb = _callback;
            lastFetched = _lastFetchedAtUtc;
        }

        if (cb is null)
        {
            return;
        }

        if (lastFetched != DateTime.MinValue && DateTime.UtcNow - lastFetched < _cacheRefreshInterval)
        {
            return;
        }

        var result = await cb(cancellationToken).ConfigureAwait(false);
        if (result.IsSuccess)
        {
            lock (_gate)
            {
                _lastFetchedAtUtc = DateTime.UtcNow;
            }
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Interlocked.Exchange(ref _disposed, 1);
    }

    /// <inheritdoc />
    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }
}

/// <summary>
/// Explicit variant. Only <see cref="ForceRefreshAsync"/> triggers a fetch.
/// </summary>
internal sealed class ManualPollService : IPollService
{
    private readonly object _gate = new();
    private FetchCallback? _callback;
    private int _disposed;

    /// <inheritdoc />
    public void Start(FetchCallback callback)
    {
        if (callback is null)
        {
            throw new ArgumentNullException(nameof(callback));
        }

        lock (_gate)
        {
            _callback = callback;
        }
    }

    /// <inheritdoc />
    public async Task<RefreshResult> ForceRefreshAsync(CancellationToken cancellationToken)
    {
        FetchCallback? cb;
        lock (_gate)
        {
            cb = _callback;
        }

        if (cb is null)
        {
            return RefreshResult.Failure("NOT_STARTED");
        }

        return await cb(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public Task MaybeFetchForGetValueAsync(CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Interlocked.Exchange(ref _disposed, 1);
    }

    /// <inheritdoc />
    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }
}
