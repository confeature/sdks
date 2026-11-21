// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.ConfigFetcher
import io.confeature.kmp.internal.Evaluator
import io.confeature.kmp.internal.InMemoryCache
import io.confeature.kmp.internal.OverrideEval
import io.confeature.kmp.internal.ProviderResult
import io.confeature.kmp.internal.ProviderValueType
import io.confeature.kmp.internal.SdkKey
import io.confeature.kmp.internal.platform.FilesystemCache
import io.confeature.kmp.internal.platform.isFatalError
import io.confeature.kmp.internal.toProviderResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
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

    // One immutable view for the synchronous bridge and native reads. The root retains the
    // config salt and segments; settings keeps the original flag map for public snapshots.
    private data class CachedState(
        val settings: Map<String, JsonElement>? = null,
        val configRoot: Map<String, Any?>? = null,
        val fetchTimeMillis: Long = 0L,
        val closed: Boolean = false,
        val offline: Boolean = false,
    )

    private val state = MutableStateFlow(CachedState())
    private val closedFlag: Boolean get() = state.value.closed
    private val offlineFlag: Boolean get() = state.value.offline
    private val localOnly: Boolean = flagOverrides?.behaviour == OverrideBehaviour.LOCAL_ONLY

    private val hooks = ConfeatureHooks(logger)
    private var clientReadyFired = false
    private val closeMutex = Mutex()
    private val stateMutex = Mutex()
    private val providerRefreshMutex = Mutex()
    private val scope = lazy { CoroutineScope(SupervisorJob() + Dispatchers.Default) }

    /** The AutoPoll coroutine, exposed internally for tests to join after [close]. */
    internal val autopollJob: Job?

    // The ETag and config replacement are coordinated under stateMutex.
    private var etag: String = ""

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

        if (pollingMode.kind == PollingMode.Kind.AUTO_POLL && !localOnly) {
            autopollJob = scope.value.launch {
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

        val config = state.value.configRoot
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
        val cached = state.value
        val settings = cached.settings?.let { decodeSettingsMap(it) }
        return Snapshot(settings, cached.configRoot, flagOverrides, defaultUser, cached.fetchTimeMillis)
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
     * Synchronous details for the optional provider companion.
     *
     * A null user is anonymous. Cold or stale online LazyLoad can start a background refresh
     * under the SDK's existing expiry policy. This call resolves only the captured configuration.
     */
    public fun getValueDetailsForProvider(
        key: String,
        defaultValue: Any?,
        user: Evaluator.UserView?,
        type: ProviderValueType,
    ): ProviderResult {
        val cached = state.value
        if (cached.closed) {
            return ProviderResult(defaultValue, null, ProviderResult.Status.NOT_READY, null)
        }
        if (!localOnly) scheduleLazyRefresh(cached)
        val result = try {
            resolveCachedDetails(cached.configRoot, flagOverrides, key, defaultValue, user, type)
        } catch (failure: Throwable) {
            if (isFatalError(failure)) throw failure
            logger.reportProviderFailure("ConfeatureClient: provider evaluation failed.")
            val details = TypedEvaluationDetails(
                key = key,
                value = defaultValue,
                fetchTimeUnixMilliseconds = cached.fetchTimeMillis,
                isDefaultValue = true,
                error = "EVALUATION_ERROR",
            )
            hooks.invokeOnFlagEvaluated(details, sanitizeFailure = true)
            return ProviderResult(defaultValue, null, ProviderResult.Status.GENERAL, null)
        }
        hooks.invokeOnFlagEvaluated(result.toDetails(key, null, cached.fetchTimeMillis), sanitizeFailure = true)
        return result.toProviderResult()
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
        state.update { it.copy(offline = false) }
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
        state.update { it.copy(offline = true) }
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
        state.update { it.copy(closed = true) }
        closeMutex.unlock()
        try {
            if (scope.isInitialized()) scope.value.cancel()
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

    private fun shouldLazyFetch(cached: CachedState): Boolean {
        if (cached.closed || cached.offline || pollingMode.kind != PollingMode.Kind.LAZY_LOAD) return false
        val refreshSeconds = pollingMode.cacheRefreshInterval?.inWholeSeconds ?: return false
        return currentEpochSeconds() - cached.fetchTimeMillis / 1000L >= refreshSeconds
    }

    private suspend fun maybeLazyFetch() {
        if (shouldLazyFetch(state.value)) fetchAndApply()
    }

    private fun scheduleLazyRefresh(cached: CachedState) {
        if (!shouldLazyFetch(cached) || !providerRefreshMutex.tryLock()) return
        val clientScope = scope.value
        // close() may have run before the first provider call initialized the lazy scope.
        if (closedFlag) clientScope.cancel()
        clientScope.launch {
            try {
                if (shouldLazyFetch(state.value)) fetchAndApply(providerRefresh = true)
            } catch (failure: Throwable) {
                if (failure is CancellationException || isFatalError(failure)) throw failure
                logger.reportProviderFailure("ConfeatureClient: provider refresh failed.")
            }
        }.invokeOnCompletion { providerRefreshMutex.unlock() }
    }

    private suspend fun fetchAndApply(providerRefresh: Boolean = false): Boolean {
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
                    etag = result.etag
                    state.update {
                        it.copy(settings = parsedSettings, configRoot = parsedRoot, fetchTimeMillis = nowMillis)
                    }
                }
                persistCache(result.rawBody, result.etag, nowSeconds, providerRefresh)
                // Fire configChanged, then clientReady on the first successful fetch.
                hooks.invokeOnConfigChanged(
                    parsedSettings?.let { decodeSettingsMap(it) } ?: emptyMap(),
                    sanitizeFailure = providerRefresh,
                )
                fireClientReadyOnce(providerRefresh)
                true
            }
            ConfigFetcher.Status.NOT_MODIFIED -> {
                val nowMillis = currentEpochMillis()
                stateMutex.withLock {
                    if (result.etag.isNotEmpty()) etag = result.etag
                    state.update { it.copy(fetchTimeMillis = nowMillis) }
                }
                fireClientReadyOnce(providerRefresh)
                true
            }
            ConfigFetcher.Status.FAILED -> {
                // Hook bus (spec 105 / #268) — fire clientError on fetch failure.
                hooks.invokeOnError("Config fetch failed.", sanitizeFailure = providerRefresh)
                false
            }
        }
    }

    private fun fireClientReadyOnce(sanitizeFailure: Boolean) {
        if (!clientReadyFired) {
            clientReadyFired = true
            hooks.invokeOnClientReady(sanitizeFailure)
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

    private suspend fun persistCache(
        rawBody: String?,
        etagValue: String,
        nowSeconds: Long,
        providerRefresh: Boolean,
    ) {
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
            if (providerRefresh) {
                if (ex is CancellationException) throw ex
                logger.reportProviderFailure("ConfeatureClient: provider cache write failed.")
            } else {
                logger.warning(
                    "ConfeatureClient: failed to persist cache entry. sdkKey=" +
                        "${SdkKey.redact(sdkKey)} reason=${ex.message}",
                )
            }
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
