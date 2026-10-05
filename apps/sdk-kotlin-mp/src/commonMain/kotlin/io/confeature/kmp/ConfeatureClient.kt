// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import io.confeature.kmp.internal.Evaluator
import io.confeature.kmp.internal.InMemoryCache
import io.confeature.kmp.internal.OverrideEval
import io.confeature.kmp.internal.SdkKey
import io.confeature.kmp.internal.platform.FilesystemCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.coroutines.cancellation.CancellationException

/**
 * Top-level entry point of the Confeature Kotlin Multiplatform SDK. Construct via [builder] or
 * [create].
 *
 * <p>Mirrors ConfigCat's KMP `ConfeatureClient` 1:1 at the API surface (constitution Principle II).
 * All `suspend` methods are safe to call concurrently; [close] is idempotent.
 *
 * <p>Override resolution runs BEFORE the cache-driven evaluator path (spec-036 correctness).
 */
@Suppress("TooManyFunctions")
public class ConfeatureClient private constructor(b: Builder) {

    private val sdkKey: String = b.sdkKey
    private val cacheKey: String
    private val logger: Logger = b.logger ?: Logger.default()
    private val flagOverrides: FlagOverrides? = b.flagOverrides
    private val defaultUser: User? = b.defaultUser
    private val fetcher: ConfigFetcher
    private val cache: ConfigCache
    private val pollingMode: PollingMode = b.pollingMode ?: PollingMode.autoPoll()

    // `closedFlag` is read on the hot path (every getValue). A plain
    // `Boolean` is safe enough in Kotlin Multiplatform: the only writer
    // is the close() path (which uses `closeMutex` to enforce idempotency),
    // and the only readers are best-effort short-circuit checks. Worst
    // case the AutoPoll coroutine iterates once more before the cancel
    // signal propagates — the Ktor client.close() in close() neutralises
    // that final fetch attempt.
    private var closedFlag: Boolean = false

    // Spec 093 / #267 — mirrors `com.configcat.ConfigService` offline flag. Plain `Boolean` matches
    // the `closedFlag` discipline: only the suspend setters write, the fetch-path readers do best-
    // effort short-circuit reads. KMP-safe (no JVM `@Volatile` — the multiplatform discipline).
    private var offlineFlag: Boolean = false

    // Spec 105 / #268 — mirrors `com.configcat.ConfigCatHooks`. The four hook points
    // (clientReady, configChanged, flagEvaluated, clientError) are wired below in
    // fetchAndApply / getValueDetails. Plain Boolean flag for clientReady matches the
    // `closedFlag` / `offlineFlag` discipline (best-effort single-fire short-circuit).
    private val hooks: ConfeatureHooks = ConfeatureHooks(logger)
    private var clientReadyFired: Boolean = false

    private val closeMutex = Mutex()
    private val stateMutex = Mutex()
    private val scope: CoroutineScope?

    /**
     * The AutoPoll coroutine; `null` outside AutoPoll. `internal` so tests can join it after
     * [close] — a real "the poll loop has finished" signal instead of a sleep.
     */
    internal val autopollJob: Job?

    // Mutable state — always read/written under stateMutex.
    private var settings: Map<String, JsonElement>? = null

    // The full parsed config root (`{p,f,s}`) the evaluator reads (salt + segments + settings). The
    // `settings` field above stays the `f` map alone for the public Snapshot.settings surface +
    // getAllKeys. Always read/written under stateMutex. Mirrors the Android twin (spec 128) so the
    // SHA-256-salted sensitive comparators + segment conditions receive the real `p.s` salt and `s`
    // segment list instead of fail-closed empties (spec-129 review).
    private var configRoot: Map<String, Any?>? = null
    private var etag: String = ""
    private var lastFetchEpochSeconds: Long = 0L

    /**
     * Wall-clock epoch-millis of the active config's last successful fetch / cache restore.
     * Surfaced via [TypedEvaluationDetails.fetchTimeUnixMilliseconds] (spec 082 / #266 slice 4/12).
     * `0L` until a config has loaded. Lives under [stateMutex] alongside the other mutable
     * config-state fields — `@Volatile` is JVM-only and we keep the multiplatform discipline.
     */
    private var fetchTimeUnixMillis: Long = 0L

    init {
        require(sdkKey.isNotEmpty()) { "sdkKey must be non-empty" }

        if (!SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
            logger.warning(
                "INVALID_SDK_KEY format; continuing — runtime is lenient. sdkKey=" +
                    SdkKey.redact(sdkKey),
            )
        }

        cacheKey = SdkKey.deriveCacheKey(sdkKey)
        cache = b.cache ?: buildDefaultCache(b.cacheDirectory, sdkKey, logger)
        fetcher = ConfigFetcher(b.baseUrl, sdkKey, b.httpTimeoutMillis, logger)

        val localOnly =
            flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY
        if (pollingMode.kind == PollingMode.Kind.AUTO_POLL && !localOnly) {
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            autopollJob = scope.launch {
                val initialDelay = pollingMode.maxInitWaitTime?.inWholeMilliseconds ?: 0L
                val period = pollingMode.pollInterval?.inWholeMilliseconds ?: DEFAULT_POLL_PERIOD_MS
                if (initialDelay > 0) delay(initialDelay)
                while (isActive) {
                    if (!offlineFlag) {
                        try {
                            fetchAndApply()
                        } catch (ex: CancellationException) {
                            // close() cancelled the scope: stop polling, log nothing.
                            throw ex
                        } catch (ex: Exception) {
                            logger.error(
                                "ConfeatureClient: AutoPoll iteration raised. sdkKey=" +
                                    SdkKey.redact(sdkKey),
                                ex,
                            )
                        }
                    }
                    delay(period)
                }
            }
        } else {
            scope = null
            autopollJob = null
        }
    }

    /**
     * Resolves [key] against the cached config + any configured overrides.
     *
     * <p>Override resolution runs FIRST (spec-036 correctness). Falls through to the four-type
     * evaluator (boolean / string / int / double) against the last successfully fetched config.
     * Returns [defaultValue] on any failure path (key absent, unsupported type, type mismatch,
     * client closed, lazy-load fetch fails).
     */
    public suspend fun getValue(key: String, defaultValue: Any?, user: User? = null): Any? {
        if (closedFlag) {
            logger.warning(
                "getValue called after close. sdkKey=${SdkKey.redact(sdkKey)} key=$key",
            )
            return defaultValue
        }

        if (flagOverrides != null) {
            // Full-config override route (spec 135): a ConfigOverrideDataSource carries the FULL
            // {p,f,s} config root. Under LOCAL_ONLY, resolve the key through the real Evaluator with
            // salt (p.s) + segments (s) intact — NEVER just `f` (the spec-129 dropped-salt
            // regression). The flat-map path below stays byte-unchanged for every value-only source.
            if (flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
                val overrideConfigRoot = flagOverrides.dataSource.getConfigRootSync()
                if (overrideConfigRoot != null) {
                    val effectiveUser = user ?: defaultUser
                    return Evaluator.evaluate(overrideConfigRoot, key, defaultValue, effectiveUser)
                        .value
                }
            }

            val overrideResult = OverrideEval.evaluateSync(flagOverrides, key, defaultValue)
            if (overrideResult.found) return overrideResult.value
            if (flagOverrides.behaviour != OverrideBehaviour.LOCAL_ONLY) {
                logger.warning(
                    "Override behaviour not implemented; falling back to default. sdkKey=" +
                        "${SdkKey.redact(sdkKey)} behaviour=${flagOverrides.behaviour}",
                )
                return defaultValue
            }
        }

        maybeLazyFetch()

        val config = stateMutex.withLock { configRoot }
        val effectiveUser = user ?: defaultUser
        return Evaluator.evaluate(config, key, defaultValue, effectiveUser).value
    }

    /**
     * Typed convenience overload. Returns [defaultValue] on type mismatch.
     */
    public suspend inline fun <reified T> getValueTyped(
        key: String,
        defaultValue: T,
        user: User? = null,
    ): T {
        val raw = getValue(key, defaultValue, user) ?: return defaultValue
        @Suppress("UNCHECKED_CAST")
        return if (raw is T) raw else defaultValue
    }

    /** Returns an immutable snapshot of the current config + overrides. */
    public suspend fun snapshot(): Snapshot {
        val current: Map<String, Any?>?
        val currentRoot: Map<String, Any?>?
        val capturedFetchTime: Long
        stateMutex.withLock {
            current = settings?.let { decodeSettingsMap(it) }
            currentRoot = configRoot
            capturedFetchTime = fetchTimeUnixMillis
        }
        return Snapshot(current, currentRoot, flagOverrides, defaultUser, capturedFetchTime)
    }

    /**
     * Returns the union of cached-config + override keys, sorted ordinally.
     *
     * <p>Mirrors ConfigCat's KMP `ConfigCatClient#getAllKeys()` — a `suspend` function returning
     * `Collection<String>` (spec 077 / #269). Closed clients return an empty collection (matches
     * the closed-client read semantics of [getValue]). Delegates to [Snapshot.getAllKeys] so the
     * underlying read path is identical to the snapshot accessor.
     */
    public suspend fun getAllKeys(): Collection<String> {
        if (closedFlag) return emptyList()
        return snapshot().getAllKeys()
    }

    /**
     * Resolves [key] and wraps the outcome in a [TypedEvaluationDetails] envelope.
     *
     * <p>Mirrors upstream `com.configcat.ConfigCatClient#getValueDetails` (spec 082 / #266 slice
     * 4/12). `suspend` — upstream's KMP signature is suspend, and our [getValue] / [getAllKeys]
     * are already suspend, so the migrating consumer's coroutine call site is unchanged
     * (Principle II — drop-in compatibility).
     *
     * <p>Closed clients return [TypedEvaluationDetails] with `isDefaultValue=true` and
     * `error="CLIENT_CLOSED"` (matches the closed-client read semantics of [getValue]).
     */
    public suspend fun getValueDetails(
        key: String,
        defaultValue: Any?,
        user: User? = null,
    ): TypedEvaluationDetails<Any?> {
        if (closedFlag) {
            logger.warning(
                "getValueDetails called after close. sdkKey=${SdkKey.redact(sdkKey)} key=$key",
            )
            val effectiveUser = user ?: defaultUser
            return TypedEvaluationDetails(
                key = key,
                value = defaultValue,
                fetchTimeUnixMilliseconds = 0L,
                user = effectiveUser,
                isDefaultValue = true,
                error = "CLIENT_CLOSED",
            )
        }
        // LazyLoad's staleness-driven fetch hook (matches getValue's path).
        maybeLazyFetch()
        val details = snapshot().getValueDetails(key, defaultValue, user)
        hooks.invokeOnFlagEvaluated(details)
        return details
    }

    /**
     * Returns the resolved value of every known flag for [user].
     *
     * <p>Mirrors upstream `com.configcat.ConfigCatClient#getAllValues` return shape
     * (`Map<String, Any?>`). `suspend` — matches upstream's KMP signature. Iterates the union of
     * cached config flag keys + override keys (same set as [getAllKeys]); per-key value is
     * resolved via [getValue] with `null` as the default. Entries whose resolved value is `null`
     * are omitted, mirroring upstream's exclusion semantics. Closed clients return an empty map.
     */
    public suspend fun getAllValues(user: User? = null): Map<String, Any?> {
        if (closedFlag) return emptyMap()
        val keys = snapshot().getAllKeys()
        val result = LinkedHashMap<String, Any?>(keys.size)
        for (key in keys) {
            val value = getValue(key, null, user)
            if (value != null) result[key] = value
        }
        return result
    }

    /**
     * Returns the [ConfeatureHooks] bus for this client. Mirrors
     * `com.configcat.ConfigCatClient.getHooks()` (Principle II, epic #268).
     */
    public fun getHooks(): ConfeatureHooks = hooks

    /** Triggers an immediate fetch. Returns true on 200 / 304 success. */
    public suspend fun forceRefresh(): Boolean {
        if (closedFlag) return false
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            // LocalOnly overrides never fetch; treat refresh as a no-op success.
            return true
        }
        if (offlineFlag) {
            // Offline — no HTTP; mirrors upstream's RefreshResult.failure("OFFLINE_MODE").
            return false
        }
        return fetchAndApply()
    }

    /**
     * Re-enables HTTP polling. Idempotent.
     *
     * Mirrors `com.configcat.ConfigCatClient.setOnline()` (spec 093 / #267). Closed clients log a
     * warning and return without mutating state. LocalOnly clients log a warning and return
     * without mutating state (LocalOnly never polls — the flag has no effect).
     */
    public fun setOnline() {
        if (closedFlag) {
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
        offlineFlag = false
    }

    /**
     * Suspends HTTP polling; serves from the cached config. Idempotent.
     *
     * Mirrors `com.configcat.ConfigCatClient.setOffline()` (spec 093 / #267). Closed clients log a
     * warning and return without mutating state. LocalOnly clients are a silent no-op (mirrors
     * upstream — LocalOnly never polls, so suspending polling is meaningless but not surprising).
     */
    public fun setOffline() {
        if (closedFlag) {
            logger.warning("setOffline called after close. sdkKey=${SdkKey.redact(sdkKey)}")
            return
        }
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            return
        }
        offlineFlag = true
    }

    /**
     * Returns `true` when HTTP polling is suspended.
     *
     * Mirrors `com.configcat.ConfigCatClient.isOffline()` (spec 093 / #267). Closed clients return
     * `true`. LocalOnly clients return `true` (mirrors upstream — LocalOnly never polls, so the
     * client is always "offline" with respect to remote config).
     */
    public fun isOffline(): Boolean {
        if (closedFlag) return true
        if (flagOverrides != null && flagOverrides.behaviour == OverrideBehaviour.LOCAL_ONLY) {
            return true
        }
        return offlineFlag
    }

    /** Closes the client. Idempotent; halts the AutoPoll coroutine + closes the Ktor client. */
    public fun close() {
        // `tryLock` is non-suspending and is exactly the "fast unique
        // winner" pattern we want: the first caller to close() acquires
        // the mutex, flips the flag, and tears down. Subsequent callers
        // observe an already-locked mutex and return immediately.
        if (!closeMutex.tryLock()) return
        if (closedFlag) {
            closeMutex.unlock()
            return
        }
        closedFlag = true
        closeMutex.unlock()
        try {
            scope?.cancel()
        } catch (ex: Exception) {
            logger.warning(
                "ConfeatureClient: scope cancel raised. sdkKey=" +
                    "${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
        try {
            fetcher.close()
        } catch (ex: Exception) {
            logger.warning(
                "ConfeatureClient: fetcher close raised. sdkKey=" +
                    "${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    // --- internals ---

    private suspend fun maybeLazyFetch() {
        if (pollingMode.kind != PollingMode.Kind.LAZY_LOAD) return
        if (offlineFlag) return
        val refreshSeconds = pollingMode.cacheRefreshInterval?.inWholeSeconds ?: return
        val nowSeconds = currentEpochSeconds()
        val stale = stateMutex.withLock { nowSeconds - lastFetchEpochSeconds >= refreshSeconds }
        if (stale) fetchAndApply()
    }

    private suspend fun fetchAndApply(): Boolean {
        if (offlineFlag) return false
        val previousEtag = stateMutex.withLock { etag }
        val result = fetcher.fetch(previousEtag)
        return when (result.status) {
            ConfigFetcher.Status.FETCHED -> {
                val parsedSettings = extractSettings(result.body)
                val parsedRoot = decodeConfigRoot(result.body)
                val nowMillis = currentEpochMillis()
                val nowSeconds = nowMillis / 1000L
                stateMutex.withLock {
                    settings = parsedSettings
                    configRoot = parsedRoot
                    etag = result.etag
                    lastFetchEpochSeconds = nowSeconds
                    // Stamp wall-clock millis for TypedEvaluationDetails (spec 082 / #266).
                    fetchTimeUnixMillis = nowMillis
                }
                persistCache(result.rawBody, result.etag, nowSeconds)
                // Hook bus (spec 105 / #268) — fire configChanged with the new settings,
                // then clientReady on the first successful fetch.
                hooks.invokeOnConfigChanged(parsedSettings?.let { decodeSettingsMap(it) } ?: emptyMap())
                fireClientReadyOnce()
                true
            }
            ConfigFetcher.Status.NOT_MODIFIED -> {
                val nowMillis = currentEpochMillis()
                val nowSeconds = nowMillis / 1000L
                stateMutex.withLock {
                    if (result.etag.isNotEmpty()) etag = result.etag
                    lastFetchEpochSeconds = nowSeconds
                    // `not_modified` still confirms freshness — update the stamp.
                    fetchTimeUnixMillis = nowMillis
                }
                fireClientReadyOnce()
                true
            }
            ConfigFetcher.Status.FAILED -> {
                // Hook bus (spec 105 / #268) — fire clientError on fetch failure.
                hooks.invokeOnError("Config fetch failed.")
                false
            }
        }
    }

    private fun fireClientReadyOnce() {
        if (!clientReadyFired) {
            clientReadyFired = true
            hooks.invokeOnClientReady()
        }
    }

    private fun extractSettings(body: JsonObject?): Map<String, JsonElement>? {
        val f = body?.get("f") ?: return null
        return if (f is JsonObject) f.toMap() else null
    }

    /**
     * Decodes the full wire config root (`{p,f,s}`) into the loosely-typed map the [Evaluator]
     * reads — preserving the config salt (`p.s`) and segments (`s`) the SHA-256-salted sensitive
     * comparators + segment conditions depend on. Returns `null` when the body is absent, matching
     * the fail-closed `extractSettings` contract (spec-129 review; mirrors Android spec 128).
     */
    private fun decodeConfigRoot(body: JsonObject?): Map<String, Any?>? {
        if (body == null) return null
        return body.mapValues { decodeJsonElement(it.value) }
    }

    private suspend fun persistCache(rawBody: String?, etagValue: String, nowSeconds: Long) {
        if (rawBody == null) return
        try {
            val envelope = JsonObject(
                mapOf(
                    "body" to Json.parseToJsonElement(rawBody),
                    "etag" to kotlinx.serialization.json.JsonPrimitive(etagValue),
                    "fetched_at" to kotlinx.serialization.json.JsonPrimitive(nowSeconds),
                ),
            )
            cache.write(cacheKey, envelope.toString())
        } catch (ex: Exception) {
            logger.warning(
                "ConfeatureClient: failed to persist cache entry. sdkKey=" +
                    "${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    /** Decodes the JsonElement-valued setting map into the loosely-typed map the evaluator wants. */
    private fun decodeSettingsMap(input: Map<String, JsonElement>): Map<String, Any?> {
        val out = HashMap<String, Any?>(input.size)
        for ((k, v) in input) out[k] = decodeJsonElement(v)
        return out
    }

    private fun decodeJsonElement(el: JsonElement): Any? = when (el) {
        is JsonObject -> el.mapValues { decodeJsonElement(it.value) }
        is kotlinx.serialization.json.JsonArray -> el.map { decodeJsonElement(it) }
        is kotlinx.serialization.json.JsonPrimitive -> decodePrimitive(el)
    }

    private fun decodePrimitive(p: kotlinx.serialization.json.JsonPrimitive): Any? {
        if (p is kotlinx.serialization.json.JsonNull) return null
        p.booleanOrNull?.let { return it }
        p.longOrNull?.let { return if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else it }
        p.intOrNull?.let { return it }
        p.doubleOrNull?.let { return it }
        return p.contentOrNull
    }

    @Suppress("unused") // Reserved for future stable wire shapes.
    private fun jsonBooleanOrNull(el: JsonElement?): Boolean? =
        try { el?.jsonPrimitive?.boolean } catch (_: Exception) { null }

    public companion object {
        private const val DEFAULT_POLL_PERIOD_MS: Long = 60_000L

        /** Constructs a client with default options. */
        public fun create(sdkKey: String): ConfeatureClient = builder(sdkKey).build()

        /** Returns a fresh builder. */
        public fun builder(sdkKey: String): Builder = Builder(sdkKey)

        private fun buildDefaultCache(
            cacheDirectory: String?,
            sdkKey: String,
            logger: Logger,
        ): ConfigCache {
            if (cacheDirectory == ":memory:") return InMemoryCache()
            val dir = cacheDirectory?.takeIf { it.isNotEmpty() } ?: FilesystemCache.defaultCacheDir()
            return FilesystemCache(dir, sdkKey, logger)
        }
    }

    /** Builder for [ConfeatureClient]. */
    public class Builder internal constructor(internal val sdkKey: String) {
        internal var pollingMode: PollingMode? = null
        internal var flagOverrides: FlagOverrides? = null
        internal var defaultUser: User? = null
        internal var logger: Logger? = null
        internal var cache: ConfigCache? = null
        internal var cacheDirectory: String? = null
        internal var baseUrl: String? = null
        internal var httpTimeoutMillis: Long? = null

        public fun pollingMode(value: PollingMode): Builder = apply { pollingMode = value }
        public fun flagOverrides(value: FlagOverrides): Builder = apply { flagOverrides = value }
        public fun defaultUser(value: User): Builder = apply { defaultUser = value }
        public fun logger(value: Logger): Builder = apply { logger = value }
        public fun cache(value: ConfigCache): Builder = apply { cache = value }
        public fun cacheDirectory(value: String): Builder = apply { cacheDirectory = value }
        public fun baseUrl(value: String): Builder = apply { baseUrl = value }
        public fun httpTimeoutMillis(value: Long): Builder = apply { httpTimeoutMillis = value }

        public fun build(): ConfeatureClient = ConfeatureClient(this)
    }
}

/** Multiplatform epoch-seconds helper. JVM/JS/Native all expose `Clock.System` via kotlinx-datetime
 * — but to avoid pulling that whole dep, we use `kotlin.time.TimeSource` semantics indirectly via
 * the actual filesystem cache; the client only needs monotonic-ish seconds for the lazy-load
 * staleness check, where `currentTimeMillis()` equivalents are sufficient. Each platform has a
 * built-in helper:
 * - JVM: `System.currentTimeMillis()`.
 * - iOS: `NSDate().timeIntervalSince1970`.
 * - JS: `Date.now()`.
 *
 * We funnel through a tiny `expect` helper to keep the common code clean. */
internal expect fun currentEpochSeconds(): Long

/** Multiplatform wall-clock epoch-millis. Surfaces via
 * [TypedEvaluationDetails.fetchTimeUnixMilliseconds] on every successful fetch (spec 082 /
 * #266 slice 4/12). Each platform's `actual` mirrors the existing [currentEpochSeconds] backing
 * source so the two helpers can never disagree on what "now" means. */
internal expect fun currentEpochMillis(): Long
