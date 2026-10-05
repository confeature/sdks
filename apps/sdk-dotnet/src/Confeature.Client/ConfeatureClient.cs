// SPDX-License-Identifier: MIT

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;

namespace Confeature.Client;

/// <summary>
/// Top-level entry point of the Confeature .NET SDK. Construct via
/// <see cref="ConfeatureClient(string, Action{ConfeatureClientOptions}?)"/>.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors <c>ConfigCat.Client.ConfigCatClient</c> 1:1 at the API surface
/// (constitution Principle II). All members are safe for concurrent use;
/// <see cref="Dispose"/> and <c>DisposeAsync</c> are idempotent.
/// </para>
/// <para>
/// Override resolution runs BEFORE the cache-driven evaluator path
/// (spec-036 correctness, inherited from day one).
/// </para>
/// </remarks>
public sealed partial class ConfeatureClient : IDisposable
{
    // Track outstanding instances per cache key so the second+
    // construction emits a single INFO log entry (FR-031).
    private static readonly ConcurrentDictionary<string, int> InstanceCount = new();

    private readonly string _sdkKey;
    private readonly string _cacheKey;
    private readonly IConfeatureLogger _logger;
    private readonly FlagOverrides? _flagOverrides;
    private readonly User? _defaultUser;
    private readonly ConfigFetcher _fetcher;
    private readonly IConfigCache _cache;
    private readonly IPollService _pollService;
    private readonly bool _ownsHttpClient;

    private IReadOnlyDictionary<string, Setting>? _settings;
    private string _etag = string.Empty;
    private readonly object _stateGate = new();

    /// <summary>
    /// Wall-clock UTC timestamp of the active config's last successful
    /// fetch or cache restore. Surfaced via
    /// <see cref="EvaluationDetails{T}.FetchTime"/> (spec 083 / #266).
    /// <see cref="DateTime.MinValue"/> until a config has loaded.
    /// </summary>
    private DateTime _fetchTime;

    private int _disposed;

    // Spec 094 / #267 — mirrors ConfigCat.Client.ConfigCatClient.IsOffline. Volatile-int discipline
    // matches `_disposed`; read by FetchAndApplyAsync / ForceRefreshAsync / IsOffline property.
    private int _isOffline;

    /// <summary>Constructs a <see cref="ConfeatureClient"/>.</summary>
    /// <param name="sdkKey">
    /// The SDK key. Empty/null → <see cref="ArgumentException"/>.
    /// Invalid format (per <c>SdkKey.IsValidConfeatureKeyFormat</c>) logs
    /// a redacted WARNING and continues.
    /// </param>
    /// <param name="configure">
    /// Optional configure callback. When non-null, invoked against a
    /// fresh <see cref="ConfeatureClientOptions"/> instance before
    /// options are validated.
    /// </param>
    /// <exception cref="ArgumentException">When <paramref name="sdkKey"/> is null or empty.</exception>
    /// <exception cref="ArgumentOutOfRangeException">When options validate negative timeouts.</exception>
    public ConfeatureClient(string sdkKey, Action<ConfeatureClientOptions>? configure = null)
    {
        if (string.IsNullOrEmpty(sdkKey))
        {
            throw new ArgumentException("sdkKey must be non-empty.", nameof(sdkKey));
        }

        var options = new ConfeatureClientOptions();
        configure?.Invoke(options);
        options.Validate();

        _sdkKey = sdkKey;
        _logger = options.Logger ?? new TraceLogger();
        _logger.LogLevel = options.LogLevel;
        _flagOverrides = options.FlagOverrides;
        _defaultUser = options.DefaultUser;

        if (!SdkKey.IsValidConfeatureKeyFormat(sdkKey))
        {
            _logger.Warning(
                "INVALID_SDK_KEY format; continuing — runtime is lenient. sdkKey="
                + SdkKey.Redact(sdkKey));
        }

        _cacheKey = SdkKey.DeriveCacheKey(sdkKey);

        // 2nd+-instance warning (FR-031): emit a single INFO when a
        // second client is constructed against the same cache key.
        var prevCount = InstanceCount.AddOrUpdate(_cacheKey, 1, (_, v) => v + 1);
        if (prevCount > 1)
        {
            _logger.Info(
                "ConfeatureClient: a second instance was constructed against "
                + "the same SDK key. Consider reusing the existing instance. sdkKey="
                + SdkKey.Redact(sdkKey));
        }

        _cache = options.Cache ?? BuildDefaultCache(options.CacheDirectory, _logger);

        _ownsHttpClient = options.HttpClient is null;
        _fetcher = new ConfigFetcher(
            options.HttpClient,
            options.BaseUrl,
            sdkKey,
            SdkVersion.Value,
            options.HttpTimeout,
            _logger);

        // Restore any persisted cache entry into in-memory state before
        // wiring the poll service.
        TryRestoreCacheEntry();

        var pollingMode = options.PollingMode ?? PollingMode.AutoPoll();
        _pollService = PollServiceFactory.Make(pollingMode, _logger);

        // Skip starting the poll service when LocalOnly overrides are
        // in effect — the override-eval path resolves every call.
        if (_flagOverrides is null || _flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly)
        {
            _pollService.Start(FetchAndApplyAsync);
        }
    }

    private static IConfigCache BuildDefaultCache(string? cacheDirectory, IConfeatureLogger logger)
    {
        if (string.Equals(cacheDirectory, ":memory:", StringComparison.Ordinal))
        {
            return new InMemoryConfigCache();
        }

        var dir = string.IsNullOrEmpty(cacheDirectory)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Confeature")
            : cacheDirectory!;

        // If we couldn't resolve a writable directory (e.g.
        // LocalApplicationData is empty on a sandboxed runtime), fall
        // back to memory-only without surfacing an error.
        if (string.IsNullOrEmpty(dir))
        {
            return new InMemoryConfigCache();
        }

        return new FileSystemConfigCache(dir, logger);
    }

    private void TryRestoreCacheEntry()
    {
        try
        {
            var raw = _cache.Read(_cacheKey);
            if (string.IsNullOrEmpty(raw))
            {
                return;
            }

            using var doc = JsonDocument.Parse(raw!);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            string? etag = null;
            if (doc.RootElement.TryGetProperty("etag", out var etagElement)
                && etagElement.ValueKind == JsonValueKind.String)
            {
                etag = etagElement.GetString();
            }

            if (!doc.RootElement.TryGetProperty("body", out var bodyElement))
            {
                return;
            }

            // The body is a JSON object (the inner config_v6.json shape).
            // Clone the element so it survives the surrounding JsonDocument's
            // disposal at the end of this method.
            var parsed = ConfigParser.Parse(bodyElement.Clone());
            if (parsed is null)
            {
                return;
            }

            // Restore the cached fetch_at timestamp (seconds since epoch
            // per the envelope shape) — surfaced via EvaluationDetails.FetchTime.
            DateTime restoredFetchTime = default;
            if (doc.RootElement.TryGetProperty("fetched_at", out var fetchedAtElement)
                && fetchedAtElement.ValueKind == JsonValueKind.Number
                && fetchedAtElement.TryGetDouble(out var fetchedAtSeconds))
            {
                var millis = (long)(fetchedAtSeconds * 1000.0);
                restoredFetchTime = DateTimeOffset.FromUnixTimeMilliseconds(millis).UtcDateTime;
            }

            lock (_stateGate)
            {
                _settings = parsed;
                _etag = etag ?? string.Empty;
                _fetchTime = restoredFetchTime;
            }

            // Hook bus (spec 106 / #268) — cache hit fires ClientReady once.
            RaiseClientReadyOnce();
        }
        catch (JsonException ex)
        {
            _logger.Warning(
                "ConfeatureClient: failed to restore cache entry. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
            RaiseError("Failed to restore cache entry: " + ex.GetType().Name, ex);
        }
        catch (IOException ex)
        {
            // The cache layer already logged + flipped to memory-only;
            // we just continue with an empty in-memory config.
            _logger.Warning(
                "ConfeatureClient: I/O error reading cache. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
            RaiseError("Cache read I/O error: " + ex.GetType().Name, ex);
        }
    }

    private async Task<RefreshResult> FetchAndApplyAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _isOffline) == 1)
        {
            // Offline — mirrors upstream's RefreshResult.failure("OFFLINE_MODE"). The AutoPoll
            // timer still wakes on its cadence, but we short-circuit before any HTTP traffic.
            return RefreshResult.Failure("OFFLINE_MODE");
        }

        string previousETag;
        lock (_stateGate)
        {
            previousETag = _etag;
        }

        var result = await _fetcher.FetchAsync(previousETag, cancellationToken).ConfigureAwait(false);
        switch (result.Status)
        {
            case FetchStatus.Fetched:
                {
                    var parsed = ConfigParser.Parse(result.Body);
                    if (parsed is null)
                    {
                        _logger.Error(
                            "ConfeatureClient: fetched body has unexpected shape. sdkKey="
                            + SdkKey.Redact(_sdkKey));
                        return RefreshResult.Failure("MALFORMED_JSON");
                    }

                    var fetchedAtUtc = DateTime.UtcNow;
                    lock (_stateGate)
                    {
                        _settings = parsed;
                        _etag = result.ETag;
                        _fetchTime = fetchedAtUtc;
                    }

                    PersistCacheEntry(result.RawBody, result.ETag);
                    // Hook bus (spec 106 / #268) — fire ConfigChanged + ConfigFetched(success),
                    // then ClientReady on the first successful fetch.
                    RaiseConfigChanged(parsed);
                    RaiseConfigFetched(isSuccess: true, errorMessage: null);
                    RaiseClientReadyOnce();
                    return RefreshResult.Success;
                }

            case FetchStatus.NotModified:
                if (!string.IsNullOrEmpty(result.ETag))
                {
                    lock (_stateGate)
                    {
                        _etag = result.ETag;
                    }
                }

                RaiseConfigFetched(isSuccess: true, errorMessage: null);
                RaiseClientReadyOnce();
                return RefreshResult.Success;

            default:
                var failureReason = result.Error ?? "Config fetch failed.";
                RaiseConfigFetched(isSuccess: false, errorMessage: failureReason);
                RaiseError(failureReason);
                return RefreshResult.Failure(failureReason);
        }
    }

    private void PersistCacheEntry(string? rawBody, string etag)
    {
        if (string.IsNullOrEmpty(rawBody))
        {
            return;
        }

        try
        {
            // Envelope shape mirrors Python (`body` + `etag` + `fetched_at`).
            // Cross-language compat: a Python or Go client can read this
            // file unchanged.
            var fetchedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
            // Use raw JSON for the body so the disk file is identical to the wire payload.
            var sb = new System.Text.StringBuilder();
            sb.Append("{\"body\":");
            sb.Append(rawBody);
            sb.Append(",\"etag\":");
            sb.Append(JsonSerializer.Serialize(etag ?? string.Empty));
            sb.Append(",\"fetched_at\":");
            sb.Append(fetchedAt.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            sb.Append('}');

            _cache.Write(_cacheKey, sb.ToString());
        }
        catch (IOException ex)
        {
            _logger.Warning(
                "ConfeatureClient: failed to persist cache entry. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
        }
    }

    /// <summary>
    /// Resolves <paramref name="key"/> against the cached config + any
    /// configured overrides.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Override resolution runs FIRST (spec-036 correctness). Falls
    /// through to the four-type evaluator (spec 070) against the last
    /// successfully fetched config — resolving <c>boolean</c> /
    /// <c>string</c> / <c>int</c> / <c>double</c> settings to their
    /// .NET-native types.
    /// </para>
    /// <para>
    /// Returns <paramref name="defaultValue"/> when:
    /// </para>
    /// <list type="bullet">
    ///   <item><description>The client is disposed.</description></item>
    ///   <item><description>The flag is unknown.</description></item>
    ///   <item><description>The setting's <c>T</c> is not one of <c>0</c> / <c>1</c> / <c>2</c> / <c>3</c> (UNSUPPORTED_TYPE).</description></item>
    ///   <item><description><typeparamref name="T"/> does not match the setting's runtime type (TYPE_MISMATCH).</description></item>
    /// </list>
    /// </remarks>
    /// <typeparam name="T">The caller's expected value type.</typeparam>
    /// <param name="key">The flag key to resolve.</param>
    /// <param name="defaultValue">Fallback returned on any failure path.</param>
    /// <param name="user">Targeting context. Accepted but unused in v1.</param>
    public T GetValue<T>(string key, T defaultValue, User? user = null)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            _logger.Warning(
                "GetValue called after Dispose. sdkKey="
                + SdkKey.Redact(_sdkKey) + " key=" + key);
            return defaultValue;
        }

        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        // Override path FIRST — spec-036 correctness. Route through the
        // full-config-aware router (spec 135 / #429): a rule-bearing
        // ConfigOverrideDataSource resolves targeting rules through the real
        // evaluator (user threaded); the flat-map source keeps the
        // byte-identical value-only path.
        if (_flagOverrides is not null)
        {
            var (found, value) = OverrideEval.Evaluate(_flagOverrides, key, defaultValue, user ?? _defaultUser);
            if (found)
            {
                return CoerceValue(value, defaultValue);
            }

            if (_flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly)
            {
                _logger.Warning(
                    "override behaviour not implemented; falling back to default. sdkKey="
                    + SdkKey.Redact(_sdkKey)
                    + " behaviour=" + _flagOverrides.OverrideBehaviour);
                return defaultValue;
            }
        }

        // LazyLoad's staleness-driven fetch hook. Blocks the calling
        // thread on the .NET side (sync GetValue customer contract).
        try
        {
            _pollService.MaybeFetchForGetValueAsync(CancellationToken.None)
                .GetAwaiter()
                .GetResult();
        }
        catch (OperationCanceledException)
        {
            // Client cancellation; carry on with whatever's cached.
        }

        IReadOnlyDictionary<string, Setting>? settings;
        lock (_stateGate)
        {
            settings = _settings;
        }

        var effectiveUser = user ?? _defaultUser;
        var result = Evaluator.Evaluate(settings, key, defaultValue, effectiveUser);
        return CoerceValue(result.Value, defaultValue);
    }

    /// <summary>
    /// Non-generic overload of <see cref="GetValue{T}"/>. Used by the
    /// parity corpus where the value type is only known at runtime.
    /// </summary>
    /// <remarks>
    /// Behaves exactly like the generic overload: consults overrides
    /// first, then falls through to the v1 evaluator. The supplied
    /// <paramref name="defaultValue"/> is also the type discriminator
    /// the evaluator's TYPE_MISMATCH check uses.
    /// </remarks>
    public object? GetValue(string key, object? defaultValue, User? user = null)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            _logger.Warning(
                "GetValue called after Dispose. sdkKey="
                + SdkKey.Redact(_sdkKey) + " key=" + key);
            return defaultValue;
        }

        if (key is null)
        {
            throw new ArgumentNullException(nameof(key));
        }

        if (_flagOverrides is not null)
        {
            var (found, value) = OverrideEval.EvaluateDynamic(_flagOverrides, key, defaultValue, user ?? _defaultUser);
            if (found)
            {
                return value;
            }

            if (_flagOverrides.OverrideBehaviour != OverrideBehaviour.LocalOnly)
            {
                _logger.Warning(
                    "override behaviour not implemented; falling back to default. sdkKey="
                    + SdkKey.Redact(_sdkKey)
                    + " behaviour=" + _flagOverrides.OverrideBehaviour);
                return defaultValue;
            }
        }

        try
        {
            _pollService.MaybeFetchForGetValueAsync(CancellationToken.None)
                .GetAwaiter()
                .GetResult();
        }
        catch (OperationCanceledException)
        {
            // Client cancellation; carry on with whatever's cached.
        }

        IReadOnlyDictionary<string, Setting>? settings;
        lock (_stateGate)
        {
            settings = _settings;
        }

        var effectiveUser = user ?? _defaultUser;
        var result = Evaluator.EvaluateDynamic(settings, key, defaultValue, effectiveUser);
        return result.Value ?? defaultValue;
    }

    /// <summary>Returns an immutable view of the current config + overrides.</summary>
    public ConfeatureSnapshot Snapshot()
    {
        IReadOnlyDictionary<string, Setting>? settings;
        DateTime capturedFetchTime;
        lock (_stateGate)
        {
            settings = _settings;
            capturedFetchTime = _fetchTime;
        }

        return new ConfeatureSnapshot(settings, _flagOverrides, _defaultUser, capturedFetchTime);
    }

    /// <summary>
    /// Returns the union of cached-config + override keys, sorted ordinally.
    /// </summary>
    /// <remarks>
    /// Mirrors ConfigCat's <c>ConfigCatClient.GetAllKeys()</c> (spec 077 / #269).
    /// Disposed clients return an empty list (matches the closed-client read
    /// semantics elsewhere on this class). Delegates to
    /// <see cref="ConfeatureSnapshot.GetAllKeys"/> so the read path is
    /// identical to the snapshot accessor.
    /// </remarks>
    public IReadOnlyList<string> GetAllKeys()
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return System.Array.Empty<string>();
        }

        return Snapshot().GetAllKeys();
    }

    /// <summary>
    /// Resolves <paramref name="key"/> and wraps the outcome in an
    /// <see cref="EvaluationDetails{T}"/> envelope (spec 083 / #266).
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetValueDetails&lt;T&gt;</c>
    /// 1:1 — same name, arity, generic constraint, and closed-client semantics.
    /// Synchronous wrapper around <see cref="GetValueDetailsAsync{T}(string, T, User?, CancellationToken)"/>.
    /// Closed clients return <c>IsDefaultValue=true</c> + <c>ErrorMessage="CLIENT_CLOSED"</c>.
    /// </remarks>
    public EvaluationDetails<T> GetValueDetails<T>(string key, T defaultValue, User? user = null)
    {
        return GetValueDetailsAsync(key, defaultValue, user, CancellationToken.None)
            .GetAwaiter()
            .GetResult();
    }

    /// <summary>
    /// Async variant of <see cref="GetValueDetails{T}(string, T, User?)"/>.
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetValueDetailsAsync&lt;T&gt;</c>
    /// 1:1. Triggers the LazyLoad staleness-driven fetch hook before delegating
    /// to a fresh snapshot.
    /// </remarks>
    public async Task<EvaluationDetails<T>> GetValueDetailsAsync<T>(
        string key,
        T defaultValue,
        User? user = null,
        CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return new EvaluationDetails<T>
            {
                Key = key,
                Value = defaultValue,
                User = user ?? _defaultUser,
                IsDefaultValue = true,
                ErrorMessage = "CLIENT_CLOSED",
            };
        }

        try
        {
            await _pollService.MaybeFetchForGetValueAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Caller cancellation; carry on with whatever's cached.
        }

        var details = Snapshot().GetValueDetails(key, defaultValue, user);
        RaiseFlagEvaluated(details);
        return details;
    }

    /// <summary>
    /// Returns the resolved value of every known flag for
    /// <paramref name="user"/> (spec 083 / #266).
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetAllValues</c> —
    /// iterates the union of cached config flag keys + override keys,
    /// resolves each via <see cref="GetValue(string, object?, User?)"/>.
    /// Closed clients return an empty dictionary.
    /// </remarks>
    public IReadOnlyDictionary<string, object?> GetAllValues(User? user = null)
    {
        return GetAllValuesAsync(user, CancellationToken.None).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Async variant of <see cref="GetAllValues(User?)"/>.
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetAllValuesAsync</c> 1:1.
    /// </remarks>
    public async Task<IReadOnlyDictionary<string, object?>> GetAllValuesAsync(
        User? user = null,
        CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return new Dictionary<string, object?>(System.StringComparer.Ordinal);
        }

        try
        {
            await _pollService.MaybeFetchForGetValueAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Caller cancellation; carry on with whatever's cached.
        }

        var snapshot = Snapshot();
        var keys = snapshot.GetAllKeys();
        var values = new Dictionary<string, object?>(keys.Count, System.StringComparer.Ordinal);
        foreach (var key in keys)
        {
            values[key] = snapshot.GetValue<object?>(key, null, user);
        }

        return values;
    }

    /// <summary>
    /// Triggers an immediate fetch. Synchronous wrapper around
    /// <see cref="ForceRefreshAsync(CancellationToken)"/>.
    /// </summary>
    public RefreshOutcome ForceRefresh()
    {
        return ForceRefreshAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    /// <summary>
    /// Triggers an immediate fetch. Idempotent — multiple in-flight
    /// refreshes serialise on the underlying <c>HttpClient</c>.
    /// </summary>
    public async Task<RefreshOutcome> ForceRefreshAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return new RefreshOutcome { IsSuccess = false, Error = "CLIENT_CLOSED" };
        }

        // LocalOnly overrides never fetch; treat refresh as a no-op success.
        if (_flagOverrides is not null && _flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly)
        {
            return new RefreshOutcome { IsSuccess = true };
        }

        if (Volatile.Read(ref _isOffline) == 1)
        {
            // Offline — no HTTP; mirrors upstream's RefreshResult.failure("OFFLINE_MODE").
            return new RefreshOutcome { IsSuccess = false, Error = "OFFLINE_MODE" };
        }

        var result = await _pollService.ForceRefreshAsync(cancellationToken).ConfigureAwait(false);
        return new RefreshOutcome
        {
            IsSuccess = result.IsSuccess,
            Error = result.Error,
        };
    }

    /// <summary>
    /// Returns <c>true</c> when HTTP polling is suspended. Mirrors
    /// <c>ConfigCat.Client.ConfigCatClient.IsOffline</c> (spec 094 / #267). Disposed clients
    /// return <c>true</c>. LocalOnly clients return <c>true</c> (mirrors upstream — LocalOnly
    /// never polls, so the client is always "offline" with respect to remote config).
    /// </summary>
    public bool IsOffline
    {
        get
        {
            if (Volatile.Read(ref _disposed) == 1)
            {
                return true;
            }

            if (_flagOverrides is not null && _flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly)
            {
                return true;
            }

            return Volatile.Read(ref _isOffline) == 1;
        }
    }

    /// <summary>
    /// Re-enables HTTP polling. Idempotent. Mirrors
    /// <c>ConfigCat.Client.ConfigCatClient.SetOnline()</c> (spec 094 / #267). Disposed clients
    /// log a warning + no-op. LocalOnly clients log a warning + no-op (LocalOnly never polls —
    /// the flag has no effect).
    /// </summary>
    public void SetOnline()
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            _logger.Warning("SetOnline called after Dispose. sdkKey=" + SdkKey.Redact(_sdkKey));
            return;
        }

        if (_flagOverrides is not null && _flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly)
        {
            _logger.Warning(
                "Client is configured to use the LocalOnly override behaviour, thus SetOnline has"
                + " no effect. sdkKey=" + SdkKey.Redact(_sdkKey));
            return;
        }

        Volatile.Write(ref _isOffline, 0);
    }

    /// <summary>
    /// Suspends HTTP polling; serves from the cached config. Idempotent. Mirrors
    /// <c>ConfigCat.Client.ConfigCatClient.SetOffline()</c> (spec 094 / #267). Disposed clients
    /// log a warning + no-op. LocalOnly clients are a silent no-op (mirrors upstream — LocalOnly
    /// never polls, so suspending polling is meaningless but not surprising).
    /// </summary>
    public void SetOffline()
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            _logger.Warning("SetOffline called after Dispose. sdkKey=" + SdkKey.Redact(_sdkKey));
            return;
        }

        if (_flagOverrides is not null && _flagOverrides.OverrideBehaviour == OverrideBehaviour.LocalOnly)
        {
            return;
        }

        Volatile.Write(ref _isOffline, 1);
    }

    /// <summary>Releases all resources. Idempotent.</summary>
    public void Dispose()
    {
        if (Interlocked.CompareExchange(ref _disposed, 1, 0) != 0)
        {
            return;
        }

        OnDispose();
    }

    private void OnDispose()
    {
        try
        {
            _pollService.Dispose();
        }
        catch (Exception ex)
        {
            _logger.Warning(
                "ConfeatureClient: poll service dispose raised. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
        }

        if (_ownsHttpClient)
        {
            try
            {
                _fetcher.Dispose();
            }
            catch (Exception ex)
            {
                _logger.Warning(
                    "ConfeatureClient: fetcher dispose raised. sdkKey="
                    + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
            }
        }

        // Decrement the per-cache-key instance counter so a subsequent
        // construction doesn't redundantly emit the 2nd-instance warning.
        InstanceCount.AddOrUpdate(_cacheKey, 0, (_, v) => Math.Max(0, v - 1));
    }

    /// <summary>
    /// Coerces an internal evaluation result back to the caller's
    /// expected type <typeparamref name="T"/>. Returns
    /// <paramref name="defaultValue"/> when coercion fails.
    /// </summary>
    private static T CoerceValue<T>(object? raw, T defaultValue)
    {
        if (raw is T typed)
        {
            return typed;
        }

        // raw may legitimately equal the default reference; preserve.
        if (raw is null)
        {
            return defaultValue;
        }

        return defaultValue;
    }
}

/// <summary>Outcome of <see cref="ConfeatureClient.ForceRefresh"/> / <see cref="ConfeatureClient.ForceRefreshAsync"/>.</summary>
public sealed class RefreshOutcome
{
    /// <summary><c>true</c> when the underlying fetch returned 200 or 304.</summary>
    public bool IsSuccess { get; init; }

    /// <summary>Short, key-free reason code on failure. Empty on success.</summary>
    public string Error { get; init; } = string.Empty;
}

#if NETSTANDARD2_1_OR_GREATER || NET8_0_OR_GREATER
public sealed partial class ConfeatureClient : IAsyncDisposable
{
    /// <summary>Async dispose. Idempotent. Awaits the poll service's async tear-down.</summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.CompareExchange(ref _disposed, 1, 0) != 0)
        {
            return;
        }

        try
        {
            await _pollService.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Warning(
                "ConfeatureClient: poll service async dispose raised. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
        }

        if (_ownsHttpClient)
        {
            try
            {
                _fetcher.Dispose();
            }
            catch (Exception ex)
            {
                _logger.Warning(
                    "ConfeatureClient: fetcher dispose raised. sdkKey="
                    + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
            }
        }

        InstanceCount.AddOrUpdate(_cacheKey, 0, (_, v) => Math.Max(0, v - 1));
    }
}
#else
public sealed partial class ConfeatureClient
{
    /// <summary>
    /// netstandard2.0 lacks <c>IAsyncDisposable</c>. This sentinel
    /// surface lets customers initiate an async tear-down across every
    /// TFM without preprocessor branches at the call site.
    /// </summary>
    public async Task CloseAsync()
    {
        if (Interlocked.CompareExchange(ref _disposed, 1, 0) != 0)
        {
            return;
        }

        try
        {
            await _pollService.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.Warning(
                "ConfeatureClient: poll service async dispose raised. sdkKey="
                + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
        }

        if (_ownsHttpClient)
        {
            try
            {
                _fetcher.Dispose();
            }
            catch (Exception ex)
            {
                _logger.Warning(
                    "ConfeatureClient: fetcher dispose raised. sdkKey="
                    + SdkKey.Redact(_sdkKey) + " reason=" + ex.Message);
            }
        }

        InstanceCount.AddOrUpdate(_cacheKey, 0, (_, v) => Math.Max(0, v - 1));
    }
}
#endif
