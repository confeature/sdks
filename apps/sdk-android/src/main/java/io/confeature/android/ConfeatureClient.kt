// SPDX-License-Identifier: MIT
package io.confeature.android

import android.content.Context
import io.confeature.android.internal.ConfigFetcher
import io.confeature.android.internal.Evaluator
import io.confeature.android.internal.FilesystemCache
import io.confeature.android.internal.InMemoryCache
import io.confeature.android.internal.JsonParser
import io.confeature.android.internal.OverrideEval
import io.confeature.android.internal.SdkKey
import java.io.File
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Top-level entry point of the Confeature Android SDK. Construct via [ConfeatureClient.get] or
 * [ConfeatureClient.builder].
 *
 * Mirrors ConfigCat's `com.configcat.ConfigCatClient` 1:1 at the API surface (constitution
 * Principle II). All members are safe for concurrent use; [close] is idempotent.
 *
 * Android-specific note: the Android factory takes an Android [Context] so the SDK can root its
 * default filesystem cache at `Context.getCacheDir() + "/confeature/"`. The Context is captured as
 * `applicationContext` to avoid retaining a short-lived [android.app.Activity].
 *
 * Override resolution runs BEFORE the cache-driven evaluator path (spec-036 correctness, inherited
 * from day one).
 */
public class ConfeatureClient private constructor(b: Builder) : AutoCloseable {
    private val sdkKey: String
    private val cacheKey: String
    private val logger: Logger
    private val flagOverrides: FlagOverrides?
    private val defaultUser: User?
    private val fetcher: ConfigFetcher
    private val cache: ConfigCache
    private val pollingMode: PollingMode
    private val scheduler: ScheduledExecutorService?
    private val closed = AtomicBoolean(false)

    // Spec 092 / #267 — mirrors com.configcat.ConfigService offline flag. Read by
    // fetchAndApply / maybeLazyFetch / forceRefresh / isOffline; mutated by setOnline / setOffline.
    private val offline = AtomicBoolean(false)

    // Spec 104 / #268 — mirrors com.configcat.ConfigCatHooks. The four hook points
    // (clientReady, configChanged, flagEvaluated, clientError) are wired below in
    // fetchAndApply / getValueDetails / tryRestoreCacheEntry.
    private val hooks: ConfeatureHooks
    private val clientReadyFired = AtomicBoolean(false)

    private val stateGate = Any()

    // Mutable state — always read/written under stateGate.
    private var settings: Map<String, Any?>? = null

    // The full parsed config root (`{p,f,s}`) the evaluator reads (salt + segments + settings). The
    // `settings` field above stays the `f` map alone for the public Snapshot.settings surface +
    // getAllKeys. Always read/written under stateGate.
    private var configRoot: Map<String, Any?>? = null
    private var etag: String = ""
    private var lastFetchEpochSeconds: Long = 0L

    /**
     * Wall-clock epoch-millis of the active config's last successful fetch / cache restore.
     * Surfaced via [EvaluationDetails.fetchTimeUnixMilliseconds] (spec 081 / #266 slice 3/12).
     * `0L` until a config has loaded.
     */
    @Volatile
    private var fetchTimeUnixMillis: Long = 0L

    init {
        require(!b.sdkKey.isNullOrEmpty()) { "sdkKey must be non-empty" }

        sdkKey = b.sdkKey!!
        logger = b.logger ?: Logger.defaultLogger()
        hooks = ConfeatureHooks(logger)
        flagOverrides = b.flagOverrides
        defaultUser = b.defaultUser
        pollingMode = b.pollingMode ?: PollingMode.autoPoll()

        if (!SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
            logger.warning("INVALID_SDK_KEY format; continuing — runtime is lenient. sdkKey=${SdkKey.redact(sdkKey)}")
        }

        cacheKey = SdkKey.deriveCacheKey(sdkKey)
        cache = b.cache ?: buildDefaultCache(b.cacheDirectory, sdkKey, logger)
        fetcher = ConfigFetcher(b.baseUrl, sdkKey, b.httpTimeout, logger)

        // Hydrate from cache (if any) BEFORE wiring the scheduler.
        if (tryRestoreCacheEntry()) {
            // Cache hit — the client is immediately ready; mirrors upstream's
            // ConfigService behaviour where a non-empty cache fires onClientReady
            // synchronously during construction.
            fireClientReadyOnce()
        }

        val localOnly = flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY
        scheduler = if (pollingMode.kind == PollingMode.Kind.AUTO_POLL && !localOnly) {
            Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "confeature-android-sdk-autopoll").apply { isDaemon = true }
            }.also { schedulePoll(it) }
        } else {
            null
        }
    }

    /**
     * Resolves [key] against the cached config + any configured overrides.
     *
     * Override resolution runs FIRST (spec-036 correctness). Falls through to the four-type
     * evaluator (boolean / string / int / double) against the last successfully fetched config.
     * Returns [defaultValue] on any failure path (key absent, unsupported type, type mismatch,
     * client closed, lazy-load fetch fails).
     *
     * @param key flag key; must be non-null.
     * @param defaultValue caller's fallback (also the TYPE_MISMATCH discriminator).
     * @param user targeting context; may be null.
     */
    public fun getValue(key: String, defaultValue: Any?, user: User?): Any? {
        if (closed.get()) {
            logger.warning("getValue called after close. sdkKey=${SdkKey.redact(sdkKey)} key=$key")
            return defaultValue
        }

        val effectiveUser = user ?: defaultUser

        // Override path FIRST — spec-036 correctness. Route through the
        // full-config-aware router (spec 135 / #440): a rule-bearing
        // ConfigOverrideDataSource resolves targeting rules through the real
        // evaluator (user threaded); the flat-map source keeps the
        // byte-identical value-only path.
        if (flagOverrides != null) {
            val overrideResult = OverrideEval.evaluate(flagOverrides, key, defaultValue, effectiveUser)
            if (overrideResult.found) return overrideResult.value
            if (flagOverrides.behaviour != OverrideBehaviour.LOCAL_ONLY) {
                logger.warning(
                    "Override behaviour not implemented; falling back to default. sdkKey=${SdkKey.redact(sdkKey)}" +
                        " behaviour=${flagOverrides.behaviour}",
                )
                return defaultValue
            }
        }

        // LazyLoad's staleness-driven fetch hook (synchronous customer contract).
        maybeLazyFetch()

        val currentConfig = synchronized(stateGate) { configRoot }
        return Evaluator.evaluate(currentConfig, key, defaultValue, effectiveUser).value
    }

    /** Convenience overload — typed default. The TYPE_MISMATCH branch fires on a type mismatch. */
    @Suppress("UNCHECKED_CAST")
    public fun <T : Any> getValue(key: String, defaultValue: T, user: User?, type: Class<T>): T {
        val raw = getValue(key, defaultValue as Any?, user) ?: return defaultValue
        return if (type.isInstance(raw)) raw as T else defaultValue
    }

    /** Returns an immutable snapshot of the current config + overrides. */
    public fun snapshot(): Snapshot {
        val current: Map<String, Any?>?
        val currentRoot: Map<String, Any?>?
        synchronized(stateGate) {
            current = settings?.let { LinkedHashMap(it) }
            currentRoot = configRoot?.let { LinkedHashMap(it) }
        }
        return Snapshot(current, currentRoot, flagOverrides, defaultUser, fetchTimeUnixMillis)
    }

    /**
     * Returns the union of cached-config + override keys, sorted ordinally.
     *
     * Mirrors ConfigCat's `com.configcat.ConfigCatClient#getAllKeys()` return shape
     * (`Collection<String>`). Closed clients return an empty collection (matches the
     * closed-client read semantics of [getValue]). Delegates to [Snapshot.getAllKeys] so the
     * underlying read path is identical to the snapshot accessor.
     */
    public fun getAllKeys(): Collection<String> {
        if (closed.get()) return emptyList()
        return snapshot().getAllKeys()
    }

    /**
     * Resolves [key] and wraps the outcome in an [EvaluationDetails] envelope.
     *
     * Mirrors ConfigCat's `com.configcat.ConfigCatClient#getValueDetails` (spec 081 / #266 slice
     * 3/12). Closed clients return [EvaluationDetails] with `isDefaultValue=true` and
     * `error="CLIENT_CLOSED"` (matches the closed-client read semantics of [getValue]).
     */
    public fun getValueDetails(key: String, defaultValue: Any?, user: User?): EvaluationDetails<Any?> {
        if (closed.get()) {
            logger.warning("getValueDetails called after close. sdkKey=${SdkKey.redact(sdkKey)} key=$key")
            val effectiveUser = user ?: defaultUser
            return EvaluationDetails(
                key = key,
                value = defaultValue,
                fetchTimeUnixMilliseconds = fetchTimeUnixMillis,
                user = effectiveUser,
                isDefaultValue = true,
                error = "CLIENT_CLOSED",
            )
        }
        // LazyLoad's staleness-driven fetch hook (synchronous customer contract).
        maybeLazyFetch()
        val details = snapshot().getValueDetails(key, defaultValue, user)
        hooks.invokeOnFlagEvaluated(details)
        return details
    }

    /**
     * Returns the [ConfeatureHooks] bus for this client. Mirrors
     * `com.configcat.ConfigCatClient#getHooks()` (Principle II, epic #268).
     */
    public fun getHooks(): ConfeatureHooks = hooks

    /**
     * Returns the resolved value of every known flag for [user].
     *
     * Mirrors ConfigCat's `com.configcat.ConfigCatClient#getAllValues` return shape
     * (`Map<String, Any?>`). Iterates the union of cached config flag keys + override keys
     * (same set as [getAllKeys]); per-key value is resolved via [getValue] with `null` as the
     * default. Entries whose resolved value is `null` are omitted, mirroring upstream's exclusion
     * semantics. Closed clients return an empty map.
     */
    public fun getAllValues(user: User?): Map<String, Any?> {
        if (closed.get()) return emptyMap()
        val keys = snapshot().getAllKeys()
        val result = LinkedHashMap<String, Any?>(keys.size)
        for (key in keys) {
            val value = getValue(key, null, user)
            if (value != null) result[key] = value
        }
        return result
    }

    /** Triggers an immediate fetch. Returns `true` on 200 / 304 success. */
    public fun forceRefresh(): Boolean {
        if (closed.get()) return false
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            // LocalOnly overrides never fetch; treat refresh as a no-op success.
            return true
        }
        if (offline.get()) {
            // Offline mode — no HTTP; mirrors upstream's RefreshResult.failure("OFFLINE_MODE").
            return false
        }
        return fetchAndApply()
    }

    /**
     * Re-enables HTTP polling. Idempotent.
     *
     * Mirrors `com.configcat.ConfigCatClient#setOnline()` (spec 092 / #267). Closed clients log a
     * warning and return without mutating state. LocalOnly clients log a warning and return
     * without mutating state (LocalOnly never polls — the flag has no effect).
     */
    public fun setOnline() {
        if (closed.get()) {
            logger.warning("setOnline called after close. sdkKey=${SdkKey.redact(sdkKey)}")
            return
        }
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            logger.warning(
                "Client is configured to use the LOCAL_ONLY override behaviour, thus setOnline has" +
                    " no effect. sdkKey=${SdkKey.redact(sdkKey)}",
            )
            return
        }
        offline.set(false)
    }

    /**
     * Suspends HTTP polling; serves from the cached config. Idempotent.
     *
     * Mirrors `com.configcat.ConfigCatClient#setOffline()` (spec 092 / #267). Closed clients log a
     * warning and return without mutating state. LocalOnly clients are a silent no-op (mirrors
     * upstream — LocalOnly never polls, so suspending polling is meaningless but not surprising).
     */
    public fun setOffline() {
        if (closed.get()) {
            logger.warning("setOffline called after close. sdkKey=${SdkKey.redact(sdkKey)}")
            return
        }
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            return
        }
        offline.set(true)
    }

    /**
     * Returns `true` when HTTP polling is suspended.
     *
     * Mirrors `com.configcat.ConfigCatClient#isOffline()` (spec 092 / #267). Closed clients return
     * `true`. LocalOnly clients return `true` (mirrors upstream — LocalOnly never polls, so the
     * client is always "offline" with respect to remote config).
     */
    public fun isOffline(): Boolean {
        if (closed.get()) return true
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            return true
        }
        return offline.get()
    }

    /** Closes the client. Idempotent; shuts down the AutoPoll scheduler + fetcher. */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            scheduler?.let { exec ->
                exec.shutdownNow()
                // 50ms is the documented graceful-stop budget (FR-007 in spec
                // 037, mirrored across SDKs).
                if (!exec.awaitTermination(50, TimeUnit.MILLISECONDS)) {
                    logger.warning(
                        "ConfeatureClient: AutoPoll scheduler did not terminate within 50ms." +
                            " sdkKey=${SdkKey.redact(sdkKey)}",
                    )
                }
            }
        } catch (ex: InterruptedException) {
            Thread.currentThread().interrupt()
            logger.warning("ConfeatureClient: interrupted while closing scheduler. sdkKey=${SdkKey.redact(sdkKey)}")
        }
        try {
            fetcher.close()
        } catch (ex: RuntimeException) {
            logger.warning(
                "ConfeatureClient: fetcher close raised. sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    // --- internals ---

    private fun schedulePoll(exec: ScheduledExecutorService) {
        val initialDelayMs = pollingMode.maxInitWaitTime!!.toMillis()
        val periodMs = pollingMode.pollInterval!!.toMillis()
        exec.scheduleAtFixedRate(::fetchAndApplyIgnoringResult, initialDelayMs, periodMs, TimeUnit.MILLISECONDS)
    }

    private fun fetchAndApplyIgnoringResult() {
        try {
            fetchAndApply()
        } catch (ex: RuntimeException) {
            // The scheduler swallows uncaught exceptions silently; log them
            // here so an AutoPoll outage is observable.
            logger.error("ConfeatureClient: AutoPoll iteration raised. sdkKey=${SdkKey.redact(sdkKey)}", ex)
        }
    }

    private fun maybeLazyFetch() {
        if (pollingMode.kind != PollingMode.Kind.LAZY_LOAD) return
        if (offline.get()) {
            // Offline — serve from the cached settings map; no staleness-driven fetch.
            return
        }
        val refreshInterval = pollingMode.cacheRefreshInterval!!
        val nowSeconds = System.currentTimeMillis() / 1000L
        val stale = synchronized(stateGate) {
            (nowSeconds - lastFetchEpochSeconds) >= refreshInterval.seconds
        }
        if (stale) fetchAndApply()
    }

    private fun fetchAndApply(): Boolean {
        if (offline.get()) {
            // Offline — the AutoPoll scheduler still wakes on its cadence, but we short-circuit
            // before any HTTP traffic. Mirrors upstream configservice.refresh() guard.
            return false
        }
        val previousEtag = synchronized(stateGate) { etag }
        val result = fetcher.fetch(previousEtag)
        return when (result.status) {
            ConfigFetcher.Status.FETCHED -> {
                val parsed = extractSettingsMap(result.body)
                val nowMillis = System.currentTimeMillis()
                val nowSeconds = nowMillis / 1000L
                synchronized(stateGate) {
                    settings = parsed
                    configRoot = result.body
                    etag = result.etag
                    lastFetchEpochSeconds = nowSeconds
                }
                // Stamp wall-clock millis for EvaluationDetails (spec 081 / #266).
                fetchTimeUnixMillis = nowMillis
                persistCache(result.rawBody, result.etag, nowSeconds)
                // Hook bus (spec 104 / #268) — fire configChanged with the new settings,
                // then clientReady on the first successful fetch.
                hooks.invokeOnConfigChanged(parsed ?: emptyMap())
                fireClientReadyOnce()
                true
            }

            ConfigFetcher.Status.NOT_MODIFIED -> {
                val nowMillis = System.currentTimeMillis()
                val nowSeconds = nowMillis / 1000L
                synchronized(stateGate) {
                    if (result.etag.isNotEmpty()) etag = result.etag
                    lastFetchEpochSeconds = nowSeconds
                }
                // `not_modified` still confirms freshness — update the stamp.
                fetchTimeUnixMillis = nowMillis
                fireClientReadyOnce()
                true
            }

            ConfigFetcher.Status.FAILED -> {
                // Hook bus (spec 104 / #268) — fire clientError on fetch failure.
                hooks.invokeOnError("Config fetch failed.")
                false
            }
        }
    }

    private fun fireClientReadyOnce() {
        if (clientReadyFired.compareAndSet(false, true)) {
            hooks.invokeOnClientReady()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun extractSettingsMap(body: Map<String, Any?>?): Map<String, Any?>? {
        val f = body?.get("f") ?: return null
        return if (f is Map<*, *>) f as Map<String, Any?> else null
    }

    private fun persistCache(rawBody: String?, etagValue: String, nowSeconds: Long) {
        if (rawBody == null) return
        try {
            val body = JsonParser.parseObject(rawBody)
            val envelope = LinkedHashMap<String, Any?>(3).apply {
                put("body", body)
                put("etag", etagValue)
                put("fetched_at", nowSeconds.toDouble())
            }
            cache.write(cacheKey, JsonParser.stringifyObject(envelope))
        } catch (ex: IllegalArgumentException) {
            logger.warning(
                "ConfeatureClient: failed to persist cache entry. sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun tryRestoreCacheEntry(): Boolean {
        val raw = cache.read(cacheKey)
        if (raw.isNullOrEmpty()) return false
        try {
            val envelope = JsonParser.parseObject(raw)
            val bodyAny = envelope["body"]
            if (bodyAny !is Map<*, *>) return false
            val body = bodyAny as Map<String, Any?>
            val f = body["f"]
            val cachedEtag = (envelope["etag"] as? String) ?: ""
            // The cache envelope stores `fetched_at` as a number of seconds (see
            // persistCache); convert to wall-clock millis for EvaluationDetails.
            val fetchedAtAny = envelope["fetched_at"]
            val cachedFetchTimeMillis = if (fetchedAtAny is Number) {
                (fetchedAtAny.toDouble() * 1000.0).toLong()
            } else {
                0L
            }
            synchronized(stateGate) {
                if (f is Map<*, *>) settings = f as Map<String, Any?>
                configRoot = body
                etag = cachedEtag
            }
            if (cachedFetchTimeMillis > 0L) {
                fetchTimeUnixMillis = cachedFetchTimeMillis
            }
            return f is Map<*, *>
        } catch (ex: IllegalArgumentException) {
            logger.warning(
                "ConfeatureClient: failed to restore cache entry. sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
            hooks.invokeOnError("Failed to restore cache entry: ${ex.javaClass.simpleName}")
            return false
        }
    }

    public companion object {
        /**
         * Android-specific factory. Routes through [Builder] with the default cache directory set
         * to `context.applicationContext.cacheDir + "/confeature/"`.
         */
        @JvmStatic
        public fun get(context: Context, sdkKey: String): ConfeatureClient =
            builder(sdkKey).cacheDirectory(defaultCacheDirFor(context)).build()

        /** Constructs a client without an Android [Context] — useful for tests / pure-JVM repros. */
        @JvmStatic
        public fun get(sdkKey: String): ConfeatureClient = builder(sdkKey).build()

        /** Returns a fresh builder. */
        @JvmStatic
        public fun builder(sdkKey: String): Builder = Builder(sdkKey)

        /** Resolves the canonical cache directory for an Android [Context]. */
        @JvmStatic
        public fun defaultCacheDirFor(context: Context): String =
            File(context.applicationContext.cacheDir, "confeature").absolutePath

        private fun buildDefaultCache(cacheDirectory: String?, sdkKey: String, logger: Logger): ConfigCache {
            if (cacheDirectory == ":memory:") return InMemoryCache()
            val dir = if (cacheDirectory.isNullOrEmpty()) FilesystemCache.defaultCacheDir() else cacheDirectory
            return FilesystemCache(File(dir), sdkKey, logger)
        }
    }

    /** Builder for [ConfeatureClient]. */
    public class Builder internal constructor(internal val sdkKey: String?) {
        internal var pollingMode: PollingMode? = null
        internal var flagOverrides: FlagOverrides? = null
        internal var defaultUser: User? = null
        internal var logger: Logger? = null
        internal var cache: ConfigCache? = null
        internal var cacheDirectory: String? = null
        internal var baseUrl: String? = null
        internal var httpTimeout: Duration? = null

        public fun pollingMode(pollingMode: PollingMode): Builder = apply { this.pollingMode = pollingMode }

        public fun flagOverrides(flagOverrides: FlagOverrides): Builder = apply { this.flagOverrides = flagOverrides }

        public fun defaultUser(defaultUser: User): Builder = apply { this.defaultUser = defaultUser }

        public fun logger(logger: Logger): Builder = apply { this.logger = logger }

        public fun cache(cache: ConfigCache): Builder = apply { this.cache = cache }

        public fun cacheDirectory(cacheDirectory: String): Builder = apply { this.cacheDirectory = cacheDirectory }

        public fun baseUrl(baseUrl: String): Builder = apply { this.baseUrl = baseUrl }

        public fun httpTimeout(httpTimeout: Duration): Builder = apply { this.httpTimeout = httpTimeout }

        public fun build(): ConfeatureClient = ConfeatureClient(this)
    }
}
