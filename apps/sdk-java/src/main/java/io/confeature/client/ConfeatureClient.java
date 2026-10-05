// SPDX-License-Identifier: MIT
package io.confeature.client;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.internal.ConfigFetcher;
import io.confeature.client.internal.Evaluator;
import io.confeature.client.internal.FilesystemCache;
import io.confeature.client.internal.OverrideEval;
import io.confeature.client.internal.SdkKey;
import java.io.IOException;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Top-level entry point of the Confeature Java SDK. Construct via {@link #get(String)} or {@link
 * #builder(String)}.
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClient} 1:1 at the API surface (constitution
 * Principle II). All members are safe for concurrent use; {@link #close()} is idempotent.
 *
 * <p>Override resolution runs BEFORE the cache-driven evaluator path (spec-036 correctness,
 * inherited from day one).
 */
public final class ConfeatureClient implements AutoCloseable {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final String sdkKey;
  private final String cacheKey;
  private final Logger logger;
  private final FlagOverrides flagOverrides;
  private final User defaultUser;
  private final ConfigFetcher fetcher;
  private final ConfigCache cache;
  private final PollingMode pollingMode;
  private final ScheduledExecutorService scheduler;
  private final AtomicBoolean closed = new AtomicBoolean(false);
  // Spec 091 / #267 — mirrors com.configcat.ConfigService offline flag.
  // Read by fetchAndApply / maybeLazyFetch / isOffline; mutated by
  // setOnline / setOffline. AtomicBoolean provides sufficient memory
  // ordering — no need to extend stateGate's coverage.
  private final AtomicBoolean offline = new AtomicBoolean(false);
  // Spec 103 / #268 — mirrors com.configcat.ConfigCatHooks. The four hook
  // points (clientReady, configChanged, flagEvaluated, clientError) are
  // wired below in fetchAndApply / getValueDetails / tryRestoreCacheEntry.
  private final ConfeatureHooks hooks;
  private final AtomicBoolean clientReadyFired = new AtomicBoolean(false);
  private final Object stateGate = new Object();

  // Mutable state — always read/written under stateGate.
  private Map<String, Object> settings;
  // Full parsed config_v6 root ({p,f,s}) — carries the p.s salt + s segments the
  // targeting-aware evaluator needs (spec 126). `settings` (the `f` map) is kept
  // for getAllKeys / snapshot; the evaluator is fed this root.
  private Map<String, Object> configRoot;
  private String etag = "";
  private long lastFetchEpochSeconds;

  /**
   * Wall-clock epoch-millis of the active config's last successful fetch / cache restore. Surfaced
   * via {@link EvaluationDetails#getFetchTimeUnixMilliseconds()} (spec 080 / #266). {@code 0L}
   * until a config has loaded.
   */
  private volatile long fetchTimeUnixMillis = 0L;

  private ConfeatureClient(Builder b) {
    if (b.sdkKey == null || b.sdkKey.isEmpty()) {
      throw new IllegalArgumentException("sdkKey must be non-empty");
    }

    this.sdkKey = b.sdkKey;
    this.logger = b.logger != null ? b.logger : Logger.defaultLogger();
    this.hooks = new ConfeatureHooks(this.logger);
    this.flagOverrides = b.flagOverrides;
    this.defaultUser = b.defaultUser;
    this.pollingMode = b.pollingMode != null ? b.pollingMode : PollingMode.autoPoll();

    if (!SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
      logger.warning(
          "INVALID_SDK_KEY format; continuing — runtime is lenient. sdkKey="
              + SdkKey.redact(sdkKey));
    }

    this.cacheKey = SdkKey.deriveCacheKey(sdkKey);
    this.cache = b.cache != null ? b.cache : buildDefaultCache(b.cacheDirectory, sdkKey, logger);
    this.fetcher = new ConfigFetcher(b.baseUrl, sdkKey, b.httpTimeout, logger);

    // Hydrate from cache (if any) BEFORE wiring the scheduler.
    final boolean cacheHydrated = tryRestoreCacheEntry();
    if (cacheHydrated) {
      // Cache hit — the client is immediately ready; mirrors upstream's
      // ConfigService behaviour where a non-empty cache fires onClientReady
      // synchronously during construction.
      fireClientReadyOnce();
    }

    final boolean localOnly =
        flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY;
    if (pollingMode.getKind() == PollingMode.Kind.AUTO_POLL && !localOnly) {
      this.scheduler =
          Executors.newSingleThreadScheduledExecutor(
              r -> {
                final Thread t = new Thread(r, "confeature-java-sdk-autopoll");
                t.setDaemon(true);
                return t;
              });
      schedulePoll();
    } else {
      this.scheduler = null;
    }
  }

  /** Constructs a client with default options. */
  public static ConfeatureClient get(String sdkKey) {
    return builder(sdkKey).build();
  }

  /** Returns a fresh builder. */
  public static Builder builder(String sdkKey) {
    return new Builder(sdkKey);
  }

  /**
   * Returns the {@link ConfeatureHooks} bus for this client. Mirrors {@code
   * com.configcat.ConfigCatClient#getHooks()} (Principle II, epic #268).
   */
  public ConfeatureHooks getHooks() {
    return hooks;
  }

  /**
   * Resolves {@code key} against the cached config + any configured overrides.
   *
   * <p>Override resolution runs FIRST (spec-036 correctness). Falls through to the four-type
   * evaluator (boolean / string / int / double) against the last successfully fetched config.
   * Returns {@code defaultValue} on any failure path (key absent, unsupported type, type mismatch,
   * client closed, lazy-load fetch fails).
   *
   * @param key flag key; must be non-null.
   * @param defaultValue caller's fallback (also the TYPE_MISMATCH discriminator).
   * @param user targeting context; may be null.
   */
  public Object getValue(String key, Object defaultValue, User user) {
    Objects.requireNonNull(key, "key");
    if (closed.get()) {
      logger.warning(
          "getValue called after close. sdkKey=" + SdkKey.redact(sdkKey) + " key=" + key);
      return defaultValue;
    }

    final User effectiveUser = user == null ? defaultUser : user;

    // Override path FIRST — spec-036 correctness. Route through the
    // full-config-aware router (spec 135 / #430): a rule-bearing
    // ConfigOverrideDataSource resolves targeting rules through the real
    // evaluator (user threaded); the flat-map source keeps the byte-identical
    // value-only path.
    if (flagOverrides != null) {
      final OverrideEval.EvalResult overrideResult =
          OverrideEval.evaluate(flagOverrides, key, defaultValue, effectiveUser);
      if (overrideResult.isFound()) {
        return overrideResult.getValue();
      }
      if (flagOverrides.getBehaviour() != OverrideBehaviour.LOCAL_ONLY) {
        logger.warning(
            "Override behaviour not implemented; falling back to default. sdkKey="
                + SdkKey.redact(sdkKey)
                + " behaviour="
                + flagOverrides.getBehaviour());
        return defaultValue;
      }
    }

    // LazyLoad's staleness-driven fetch hook (synchronous customer contract).
    maybeLazyFetch();

    final Map<String, Object> currentConfig;
    synchronized (stateGate) {
      currentConfig = configForEval();
    }
    final Evaluator.Result result =
        Evaluator.evaluate(currentConfig, key, defaultValue, effectiveUser);
    return result.getValue();
  }

  /** Convenience overload — typed default. The TYPE_MISMATCH branch fires on a type mismatch. */
  @SuppressWarnings("unchecked")
  public <T> T getValue(String key, T defaultValue, User user, Class<T> type) {
    final Object raw = getValue(key, (Object) defaultValue, user);
    if (raw == null) {
      return defaultValue;
    }
    if (type.isInstance(raw)) {
      return (T) raw;
    }
    return defaultValue;
  }

  /** Returns an immutable snapshot of the current config + overrides. */
  public Snapshot snapshot() {
    final Map<String, Object> currentSettings;
    final Map<String, Object> currentConfig;
    synchronized (stateGate) {
      currentSettings = settings == null ? null : new LinkedHashMap<>(settings); // defensive copy
      currentConfig = configRoot == null ? null : new LinkedHashMap<>(configRoot);
    }
    return new Snapshot(
        currentSettings, currentConfig, flagOverrides, defaultUser, fetchTimeUnixMillis);
  }

  /**
   * The full parsed config root ({@code {p,f,s}}) the evaluator consumes. When only the {@code f}
   * map is available (override-only / legacy cache paths), synthesizes a minimal {@code {f}}
   * envelope so salt-less / segment-less configs still evaluate. Must be called under stateGate.
   */
  private Map<String, Object> configForEval() {
    if (configRoot != null) {
      return configRoot;
    }
    if (settings == null) {
      return null;
    }
    final Map<String, Object> synthetic = new LinkedHashMap<>(1);
    synthetic.put("f", settings);
    return synthetic;
  }

  /**
   * Returns the union of cached-config + override keys, sorted ordinally.
   *
   * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClient#getAllKeys()} return shape ({@link
   * Collection}{@code <}{@link String}{@code >}). Closed clients return an empty collection
   * (matches the closed-client read semantics of {@link #getValue(String, Object, User)}).
   * Delegates to {@link Snapshot#getAllKeys()} so the underlying read path is identical to the
   * snapshot accessor.
   */
  public Collection<String> getAllKeys() {
    if (closed.get()) {
      return Collections.emptyList();
    }
    return snapshot().getAllKeys();
  }

  /**
   * Resolves {@code key} and wraps the outcome in an {@link EvaluationDetails} envelope.
   *
   * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClient#getValueDetails} (spec 080 / #266).
   * Closed clients return {@link EvaluationDetails} with {@code isDefaultValue=true} and {@code
   * error="CLIENT_CLOSED"} (matches the closed-client read semantics of {@link #getValue(String,
   * Object, User)}).
   */
  public EvaluationDetails<Object> getValueDetails(String key, Object defaultValue, User user) {
    Objects.requireNonNull(key, "key");
    if (closed.get()) {
      logger.warning(
          "getValueDetails called after close. sdkKey=" + SdkKey.redact(sdkKey) + " key=" + key);
      final User effectiveUser = user == null ? defaultUser : user;
      return new EvaluationDetails<>(
          key,
          defaultValue,
          null,
          fetchTimeUnixMillis,
          effectiveUser,
          true,
          "CLIENT_CLOSED",
          null,
          null);
    }
    // LazyLoad's staleness-driven fetch hook (synchronous customer contract).
    maybeLazyFetch();
    final EvaluationDetails<Object> details = snapshot().getValueDetails(key, defaultValue, user);
    hooks.invokeOnFlagEvaluated(details);
    return details;
  }

  /**
   * Typed overload of {@link #getValueDetails(String, Object, User)} — same semantics, the result's
   * {@link EvaluationDetails#getValue()} is narrowed to {@code T}.
   */
  public <T> EvaluationDetails<T> getValueDetails(
      String key, T defaultValue, User user, Class<T> type) {
    Objects.requireNonNull(key, "key");
    Objects.requireNonNull(type, "type");
    if (closed.get()) {
      logger.warning(
          "getValueDetails called after close. sdkKey=" + SdkKey.redact(sdkKey) + " key=" + key);
      final User effectiveUser = user == null ? defaultUser : user;
      return new EvaluationDetails<>(
          key,
          defaultValue,
          null,
          fetchTimeUnixMillis,
          effectiveUser,
          true,
          "CLIENT_CLOSED",
          null,
          null);
    }
    maybeLazyFetch();
    final EvaluationDetails<T> details = snapshot().getValueDetails(key, defaultValue, user, type);
    hooks.invokeOnFlagEvaluated(details);
    return details;
  }

  /**
   * Returns the resolved value of every known flag for {@code user}.
   *
   * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCatClient#getAllValues} return shape ({@link
   * Map}{@code <}{@link String}{@code , }{@link Object}{@code >}). Iterates the union of cached
   * config flag keys + override keys (same set as {@link #getAllKeys()}); per-key value is resolved
   * via {@link #getValue(String, Object, User)} with {@code null} as the default. Entries whose
   * resolved value is {@code null} are omitted, mirroring upstream's exclusion semantics. Closed
   * clients return an empty map.
   */
  public Map<String, Object> getAllValues(User user) {
    if (closed.get()) {
      return Collections.emptyMap();
    }
    final Collection<String> keys = snapshot().getAllKeys();
    final Map<String, Object> result = new LinkedHashMap<>();
    for (String key : keys) {
      final Object value = getValue(key, null, user);
      if (value != null) {
        result.put(key, value);
      }
    }
    return result;
  }

  /** Triggers an immediate fetch. Returns {@code true} on 200 / 304 success. */
  public boolean forceRefresh() {
    if (closed.get()) {
      return false;
    }
    if (flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY) {
      // LocalOnly overrides never fetch; treat refresh as a no-op success.
      return true;
    }
    if (offline.get()) {
      // Offline mode — no HTTP traffic; mirrors upstream's RefreshResult.failure("OFFLINE_MODE").
      return false;
    }
    return fetchAndApply();
  }

  /**
   * Re-enables HTTP polling. Idempotent.
   *
   * <p>Mirrors {@code com.configcat.ConfigCatClient#setOnline()} (spec 091 / #267). Closed clients
   * log a warning and return without mutating state. LocalOnly clients log a warning and return
   * without mutating state (LocalOnly never polls — the flag has no effect).
   */
  public void setOnline() {
    if (closed.get()) {
      logger.warning("setOnline called after close. sdkKey=" + SdkKey.redact(sdkKey));
      return;
    }
    if (flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY) {
      logger.warning(
          "Client is configured to use the LOCAL_ONLY override behaviour, thus setOnline has no"
              + " effect. sdkKey="
              + SdkKey.redact(sdkKey));
      return;
    }
    offline.set(false);
  }

  /**
   * Suspends HTTP polling; serves from the cached config. Idempotent.
   *
   * <p>Mirrors {@code com.configcat.ConfigCatClient#setOffline()} (spec 091 / #267). Closed clients
   * log a warning and return without mutating state. LocalOnly clients are a silent no-op (mirrors
   * upstream — LocalOnly never polls, so suspending polling is meaningless but not surprising).
   */
  public void setOffline() {
    if (closed.get()) {
      logger.warning("setOffline called after close. sdkKey=" + SdkKey.redact(sdkKey));
      return;
    }
    if (flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY) {
      return;
    }
    offline.set(true);
  }

  /**
   * Returns {@code true} when HTTP polling is suspended.
   *
   * <p>Mirrors {@code com.configcat.ConfigCatClient#isOffline()} (spec 091 / #267). Closed clients
   * return {@code true}. LocalOnly clients return {@code true} (mirrors upstream — LocalOnly never
   * polls, so the client is always "offline" with respect to remote config).
   */
  public boolean isOffline() {
    if (closed.get()) {
      return true;
    }
    if (flagOverrides != null && flagOverrides.getBehaviour() == OverrideBehaviour.LOCAL_ONLY) {
      return true;
    }
    return offline.get();
  }

  /** Closes the client. Idempotent; shuts down the AutoPoll scheduler + fetcher. */
  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) {
      return;
    }
    try {
      if (scheduler != null) {
        scheduler.shutdownNow();
        // 50ms is the documented graceful-stop budget (FR-007 in spec
        // 037, mirrored across SDKs).
        if (!scheduler.awaitTermination(50, TimeUnit.MILLISECONDS)) {
          logger.warning(
              "ConfeatureClient: AutoPoll scheduler did not terminate within 50ms. sdkKey="
                  + SdkKey.redact(sdkKey));
        }
      }
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
      logger.warning(
          "ConfeatureClient: interrupted while closing scheduler. sdkKey=" + SdkKey.redact(sdkKey));
    }
    try {
      fetcher.close();
    } catch (RuntimeException ex) {
      logger.warning(
          "ConfeatureClient: fetcher close raised. sdkKey="
              + SdkKey.redact(sdkKey)
              + " reason="
              + ex.getMessage());
    }
  }

  // --- internals ---

  private void schedulePoll() {
    final long initialDelayMs = pollingMode.getMaxInitWaitTime().toMillis();
    final long periodMs = pollingMode.getPollInterval().toMillis();
    scheduler.scheduleAtFixedRate(
        this::fetchAndApplyIgnoringResult, initialDelayMs, periodMs, TimeUnit.MILLISECONDS);
  }

  private void fetchAndApplyIgnoringResult() {
    try {
      fetchAndApply();
    } catch (RuntimeException ex) {
      // The scheduler swallows uncaught exceptions silently; log them
      // here so an AutoPoll outage is observable.
      logger.error(
          "ConfeatureClient: AutoPoll iteration raised. sdkKey=" + SdkKey.redact(sdkKey), ex);
    }
  }

  private void maybeLazyFetch() {
    if (pollingMode.getKind() != PollingMode.Kind.LAZY_LOAD) {
      return;
    }
    if (offline.get()) {
      // Offline — serve from the cached settings map; no staleness-driven fetch.
      return;
    }
    final Duration refreshInterval = pollingMode.getCacheRefreshInterval();
    final long nowSeconds = System.currentTimeMillis() / 1000L;
    final boolean stale;
    synchronized (stateGate) {
      stale = (nowSeconds - lastFetchEpochSeconds) >= refreshInterval.getSeconds();
    }
    if (stale) {
      fetchAndApply();
    }
  }

  private boolean fetchAndApply() {
    if (offline.get()) {
      // Offline — the AutoPoll scheduler still wakes on its cadence, but
      // we short-circuit before any HTTP traffic. Mirrors upstream
      // configservice.refresh() guard.
      return false;
    }
    final String previousEtag;
    synchronized (stateGate) {
      previousEtag = etag;
    }
    final ConfigFetcher.FetchResult result = fetcher.fetch(previousEtag);
    switch (result.getStatus()) {
      case FETCHED:
        {
          final Map<String, Object> parsedSettings = extractSettingsMap(result.getBody());
          final long nowMillis = System.currentTimeMillis();
          final long nowSeconds = nowMillis / 1000L;
          synchronized (stateGate) {
            settings = parsedSettings;
            configRoot = result.getBody();
            etag = result.getEtag();
            lastFetchEpochSeconds = nowSeconds;
          }
          // Stamp wall-clock millis for EvaluationDetails (spec 080 / #266).
          fetchTimeUnixMillis = nowMillis;
          persistCache(result.getRawBody(), result.getEtag(), nowSeconds);
          // Hook bus (spec 103 / #268) — fire configChanged with the new
          // settings, then clientReady on the first successful fetch.
          hooks.invokeOnConfigChanged(parsedSettings);
          fireClientReadyOnce();
          return true;
        }
      case NOT_MODIFIED:
        {
          final long nowMillis = System.currentTimeMillis();
          final long nowSeconds = nowMillis / 1000L;
          synchronized (stateGate) {
            if (!result.getEtag().isEmpty()) {
              etag = result.getEtag();
            }
            lastFetchEpochSeconds = nowSeconds;
          }
          // `not_modified` still confirms freshness — update the stamp.
          fetchTimeUnixMillis = nowMillis;
          fireClientReadyOnce();
          return true;
        }
      case FAILED:
      default:
        // Hook bus (spec 103 / #268) — fire clientError on fetch failure.
        hooks.invokeOnError("Config fetch failed.");
        return false;
    }
  }

  private void fireClientReadyOnce() {
    if (clientReadyFired.compareAndSet(false, true)) {
      hooks.invokeOnClientReady();
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> extractSettingsMap(Map<String, Object> body) {
    if (body == null) {
      return null;
    }
    final Object f = body.get("f");
    if (f instanceof Map) {
      return (Map<String, Object>) f;
    }
    return null;
  }

  private void persistCache(String rawBody, String etagValue, long nowSeconds) {
    if (rawBody == null) {
      return;
    }
    try {
      final Map<String, Object> body = MAPPER.readValue(rawBody, Map.class);
      final Map<String, Object> envelope = new LinkedHashMap<>(3);
      envelope.put("body", body);
      envelope.put("etag", etagValue == null ? "" : etagValue);
      envelope.put("fetched_at", (double) nowSeconds);
      cache.write(cacheKey, MAPPER.writeValueAsString(envelope));
    } catch (IOException ex) {
      logger.warning(
          "ConfeatureClient: failed to persist cache entry. sdkKey="
              + SdkKey.redact(sdkKey)
              + " reason="
              + ex.getMessage());
    }
  }

  @SuppressWarnings("unchecked")
  private boolean tryRestoreCacheEntry() {
    final String raw = cache.read(cacheKey);
    if (raw == null || raw.isEmpty()) {
      return false;
    }
    try {
      final Map<String, Object> envelope = MAPPER.readValue(raw, Map.class);
      final Object bodyAny = envelope.get("body");
      if (!(bodyAny instanceof Map)) {
        return false;
      }
      final Map<String, Object> body = (Map<String, Object>) bodyAny;
      final Object f = body.get("f");
      final String cachedEtag =
          envelope.get("etag") instanceof String ? (String) envelope.get("etag") : "";
      // The cache envelope stores `fetched_at` as a number of seconds (see
      // persistCache); convert to wall-clock millis for EvaluationDetails.
      final Object fetchedAtAny = envelope.get("fetched_at");
      final long cachedFetchTimeMillis;
      if (fetchedAtAny instanceof Number) {
        cachedFetchTimeMillis = (long) (((Number) fetchedAtAny).doubleValue() * 1000.0);
      } else {
        cachedFetchTimeMillis = 0L;
      }
      synchronized (stateGate) {
        if (f instanceof Map) {
          settings = (Map<String, Object>) f;
          configRoot = body;
        }
        etag = cachedEtag;
      }
      if (cachedFetchTimeMillis > 0L) {
        fetchTimeUnixMillis = cachedFetchTimeMillis;
      }
      return f instanceof Map;
    } catch (IOException ex) {
      logger.warning(
          "ConfeatureClient: failed to restore cache entry. sdkKey="
              + SdkKey.redact(sdkKey)
              + " reason="
              + ex.getMessage());
      hooks.invokeOnError("Failed to restore cache entry: " + ex.getClass().getSimpleName());
      return false;
    }
  }

  private static ConfigCache buildDefaultCache(
      String cacheDirectory, String sdkKey, Logger logger) {
    if (":memory:".equals(cacheDirectory)) {
      return new io.confeature.client.internal.InMemoryCache();
    }
    final String dir =
        (cacheDirectory == null || cacheDirectory.isEmpty())
            ? FilesystemCache.defaultCacheDir()
            : cacheDirectory;
    return new FilesystemCache(Paths.get(dir), sdkKey, logger);
  }

  /** Builder for {@link ConfeatureClient}. */
  public static final class Builder {
    private final String sdkKey;
    private PollingMode pollingMode;
    private FlagOverrides flagOverrides;
    private User defaultUser;
    private Logger logger;
    private ConfigCache cache;
    private String cacheDirectory;
    private String baseUrl;
    private Duration httpTimeout;

    private Builder(String sdkKey) {
      this.sdkKey = sdkKey;
    }

    public Builder pollingMode(PollingMode pollingMode) {
      this.pollingMode = pollingMode;
      return this;
    }

    public Builder flagOverrides(FlagOverrides flagOverrides) {
      this.flagOverrides = flagOverrides;
      return this;
    }

    public Builder defaultUser(User defaultUser) {
      this.defaultUser = defaultUser;
      return this;
    }

    public Builder logger(Logger logger) {
      this.logger = logger;
      return this;
    }

    public Builder cache(ConfigCache cache) {
      this.cache = cache;
      return this;
    }

    public Builder cacheDirectory(String cacheDirectory) {
      this.cacheDirectory = cacheDirectory;
      return this;
    }

    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    public Builder httpTimeout(Duration httpTimeout) {
      this.httpTimeout = httpTimeout;
      return this;
    }

    public ConfeatureClient build() {
      return new ConfeatureClient(this);
    }
  }
}
