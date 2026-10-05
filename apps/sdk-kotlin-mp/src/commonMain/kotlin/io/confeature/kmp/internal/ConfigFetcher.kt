// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.Logger
import io.confeature.kmp.Version
import io.confeature.kmp.internal.platform.createHttpClient
import io.confeature.kmp.internal.platform.isFatalError
import io.ktor.client.HttpClient
import io.ktor.client.network.sockets.ConnectTimeoutException
import io.ktor.client.network.sockets.SocketTimeoutException
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.SendCountExceedException
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.parseUrl
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException

/**
 * Ktor-based fetcher that pulls `config_v6.json` from the Confeature CDN.
 *
 * <p>Responsibilities:
 *
 * - User-Agent: `confeature-kmp-sdk/<Version>` (FR-012).
 * - `If-None-Match` support for 304 reuse (FR-011).
 * - Configurable request timeout (default 30s).
 * - SDK key redaction in EVERY log line (FR-013): the raw key is NEVER interpolated;
 *   [SdkKey.redact] is the only path.
 * - Key-free failures (#803 FR-002): the request URL carries the SDK key (ConfigCat's wire
 *   protocol), and Ktor quotes the URL in its exception messages (`HttpRequestTimeoutException`:
 *   "Request timeout has expired [url=…]"). No exception text is ever logged or returned — every
 *   transport / body failure is reduced to a fixed reason code by [classifyFetchError].
 * - A base URL that is not an absolute `http(s)://host` URL is refused up front with the fixed
 *   [INVALID_REQUEST] code — Ktor would otherwise resolve a scheme-less base against its default
 *   `http://localhost` and send the keyed request there.
 * - Cancellation is never swallowed: when the calling coroutine is cancelled, [fetch] rethrows its
 *   cancellation (structured concurrency) instead of reporting a failed fetch.
 *
 * <p>Behaviourally mirrors `apps/sdk-go/internal/configfetcher/fetcher.go`, the .NET fetcher, and
 * the Java fetcher: same URL scheme, same headers, same fail-closed result envelope. The path is
 * ConfigCat's: `com.configcat.fetch.ConfigFetcher` (configcat-kotlin-client 5.1.0) appends the
 * raw `options.sdkKey` — `$baseUrl/configuration-files/$sdkKey/config_v6.json`; see [configFileUrl].
 */
public class ConfigFetcher(
    baseUrl: String?,
    private val sdkKey: String,
    timeoutMillis: Long?,
    private val logger: Logger,
    private val httpClientFactory: () -> HttpClient = {
        createHttpClient {
            install(HttpTimeout) {
                val effective =
                    (timeoutMillis ?: DEFAULT_TIMEOUT_MS).takeIf { it > 0 } ?: DEFAULT_TIMEOUT_MS
                requestTimeoutMillis = effective
                connectTimeoutMillis = effective
                socketTimeoutMillis = effective
            }
        }
    },
) {
    /** Discrete outcomes of one [fetch] call. */
    public enum class Status { FETCHED, NOT_MODIFIED, FAILED }

    /** Outcome envelope of [fetch]. */
    public class FetchResult internal constructor(
        public val status: Status,
        public val body: JsonObject?,
        public val rawBody: String?,
        public val etag: String,
        public val error: String,
    ) {
        public companion object {
            public fun fetched(body: JsonObject, rawBody: String, etag: String): FetchResult =
                FetchResult(Status.FETCHED, body, rawBody, etag, "")

            public fun notModified(etag: String): FetchResult =
                FetchResult(Status.NOT_MODIFIED, null, null, etag, "")

            public fun failed(error: String): FetchResult =
                FetchResult(Status.FAILED, null, null, "", error)
        }
    }

    public companion object {
        /** Production CDN base URL. */
        public const val DEFAULT_BASE_URL: String = "https://cdn-global.confeature.io"
        public const val DEFAULT_TIMEOUT_MS: Long = 30_000L

        /** Fixed reason: the key cannot be a URL path segment ("", ".", ".."); nothing was sent. */
        public const val INVALID_SDK_KEY: String = "INVALID_SDK_KEY"

        /**
         * Fixed reason: the base URL is not an absolute `http`/`https` URL with a host (or the
         * built URL does not parse); nothing was sent.
         */
        public const val INVALID_REQUEST: String = "invalid_request"

        /** Fixed reason: a 200 whose body is not JSON or not a `{p, f, s}` config envelope. */
        public const val MALFORMED_JSON: String = "MALFORMED_JSON"

        /** Fixed reason: the request (connect / socket / whole-request deadline) timed out. */
        public const val TIMEOUT: String = "timeout"

        /** Fixed reason: the redirect chain exceeded Ktor's send limit. */
        public const val TOO_MANY_REDIRECTS: String = "too_many_redirects"

        /** Fixed reason: any other transport failure before a response arrived. */
        public const val NETWORK_ERROR: String = "network_error"

        /** Fixed reason: the 200 body could not be read to the end (e.g. a mid-body reset). */
        public const val BODY_READ_FAILED: String = "body_read_failed"

        private val JSON = Json { ignoreUnknownKeys = true }
    }

    /**
     * Why [fetch] refuses to send anything, or `null` when the request can go out: [INVALID_REQUEST]
     * for an unusable base URL, [INVALID_SDK_KEY] for a key that cannot be a path segment. Computed
     * here without throwing — a constructor never raises an error that could quote the key.
     */
    private val refusal: String?

    /**
     * The config URL, built once by [configFileUrl]; `null` when the base URL is unusable or the key
     * cannot be a path segment (empty, `.` or `..`) — [fetch] then refuses to send anything.
     * `private`: it carries the SDK key (#803). Kotlin `internal` would compile to a PUBLIC JVM getter
     * (`getUrl$<module>`) that hands the keyed URL to Java callers and reflection; tests read the URL
     * the transport actually received instead.
     */
    private val url: String?

    init {
        val base = baseUrl?.takeIf { it.isNotEmpty() } ?: DEFAULT_BASE_URL
        val usable = isUsableBaseUrl(base)
        val built = if (usable) configFileUrl(base, sdkKey) else null
        refusal = when {
            !usable -> INVALID_REQUEST
            built == null -> INVALID_SDK_KEY
            parseUrlOrNull(built) == null -> INVALID_REQUEST
            else -> null
        }
        url = if (refusal == null) built else null
    }

    private val userAgent: String = "confeature-kmp-sdk/${Version.SDK_VERSION}"
    private val client: HttpClient by lazy(httpClientFactory)

    /**
     * Issues a single GET. Never throws a failure — failures land in [Status.FAILED] with a fixed,
     * key-free reason code. It lets through only the calling coroutine's own cancellation and the
     * runtime's fatal errors ([isFatalError]: `OutOfMemoryError`, `StackOverflowError`, … on the
     * JVM), which propagate unchanged.
     */
    public suspend fun fetch(previousEtag: String?): FetchResult {
        val target = url
        if (target == null) {
            val reason = refusal ?: INVALID_REQUEST
            val why = if (reason == INVALID_SDK_KEY) {
                "the key cannot be a URL path segment"
            } else {
                "the base URL is not an absolute http(s) URL with a host"
            }
            logger.error(
                "ConfigFetcher: $reason — $why; not fetching. sdkKey=" + SdkKey.redact(sdkKey),
            )
            return FetchResult.failed(reason)
        }
        return fetchFrom(target, previousEtag)
    }

    // Throwable, not Exception: Ktor's JS engine surfaces a failed `fetch` as a `kotlin.Error`.
    // [failFrom] rethrows the VM's fatal errors (OutOfMemoryError, …) — those are not fetch failures.
    private suspend fun fetchFrom(target: String, previousEtag: String?): FetchResult = try {
        request(target, previousEtag)
    } catch (ex: Throwable) {
        // Ktor wraps every network/IO error in a thrown exception whose message may quote the
        // request URL — and the URL carries the SDK key. Only the exception's type picks a code.
        failFrom(ex, NETWORK_ERROR)
    }

    private suspend fun request(target: String, previousEtag: String?): FetchResult {
        val resp = client.get(target) {
            header(HttpHeaders.UserAgent, userAgent)
            header(HttpHeaders.Accept, "application/json")
            if (!previousEtag.isNullOrEmpty()) {
                header(HttpHeaders.IfNoneMatch, previousEtag)
            }
        }
        val etag = resp.headers[HttpHeaders.ETag].orEmpty()
        return when (resp.status) {
            HttpStatusCode.NotModified -> FetchResult.notModified(etag)
            HttpStatusCode.OK -> {
                // Read the body FIRST so a mid-body reset classifies as a fetch failure, not a
                // parse failure (wire-cases `network-reset`, #490).
                val raw = try {
                    resp.bodyAsText()
                } catch (ex: Throwable) {
                    return failFrom(ex, BODY_READ_FAILED)
                }
                try {
                    val parsed = JSON.parseToJsonElement(raw)
                    // Wire-cases `wrong-shape-200`: a 200 carrying valid JSON of the
                    // wrong top-level shape ({foo: 'bar'} instead of {p, f, s}) MUST
                    // surface as parseFailed, same class as malformed JSON. sdk-node
                    // / sdk-python / sdk-go / sdk-rust / sdk-java / sdk-android ship
                    // the equivalent guard (epic #146 / issue #148). Probing the `f`
                    // key alone is sufficient — it is the only mandatory top-level
                    // key in the schema; we collapse the "not-an-object" and
                    // "missing-f" failures into one branch so the wire-cases corpus
                    // exercises every line.
                    if (parsed is JsonObject && parsed.containsKey("f")) {
                        FetchResult.fetched(parsed, raw, etag)
                    } else {
                        logger.error(
                            "ConfigFetcher: 200 response not a valid config envelope. " +
                                "sdkKey=" + SdkKey.redact(sdkKey),
                        )
                        FetchResult.failed(MALFORMED_JSON)
                    }
                } catch (ex: Exception) {
                    // The parser's message is never passed on — only the fixed code (FR-002).
                    fail(classifyFetchError(ex, MALFORMED_JSON))
                }
            }
            else -> {
                val reason = "HTTP ${resp.status.value}"
                logger.error(
                    "ConfigFetcher: fetch failed. sdkKey=" +
                        "${SdkKey.redact(sdkKey)} reason=$reason",
                )
                FetchResult.failed(reason)
            }
        }
    }

    /**
     * Turns a caught [error] into a failed result — unless it must propagate:
     *
     * - a fatal runtime error ([isFatalError]: `OutOfMemoryError`, `StackOverflowError`,
     *   `LinkageError`, … on the JVM) is rethrown as-is — the catch is `Throwable` only for the JS
     *   engine's recoverable `kotlin.Error`;
     * - when the CALLING coroutine was cancelled, [ensureActive] rethrows its cancellation, so a
     *   cancelled poll stops instead of logging a failure (structured concurrency). A
     *   [CancellationException] raised while this coroutine is still active (Ktor's own
     *   request-timeout cancellation) is a transport failure like any other.
     */
    private suspend fun failFrom(error: Throwable, fallback: String): FetchResult {
        if (isFatalError(error)) throw error
        if (error is CancellationException) currentCoroutineContext().ensureActive()
        return fail(classifyFetchError(error, fallback))
    }

    /** Logs a fixed reason code (never exception text) and returns it as a failed result. */
    private fun fail(reason: String): FetchResult {
        logger.error("ConfigFetcher: fetch raised. sdkKey=${SdkKey.redact(sdkKey)} reason=$reason")
        return FetchResult.failed(reason)
    }

    /** Releases the underlying Ktor client. Idempotent; safe to call repeatedly. */
    public fun close() {
        client.close()
    }
}

/**
 * Builds the config URL — the ONE place the SDK's request path is made (#803 FR-001), as
 * ConfigCat's `com.configcat.fetch.ConfigFetcher` does: `<base>/configuration-files/<key>/config_v6.json`.
 *
 * - A key matching a Confeature shape ([SdkKey.isValidConfeatureKeyFormat]) travels RAW: split on
 *   `/`, each part path-segment-escaped (a no-op for a valid key), so `configcat-sdk-1/<22>/<22>`
 *   stays three segments — a stock ConfigCat SDK's exact bytes.
 * - Any other key is escaped into ONE segment (Go's `url.PathEscape`); `""`, `.` and `..` cannot be
 *   a segment at all, so the result is `null` and the fetcher refuses to send a request.
 *
 * No version prefix and no cache-key tail: the hashed tail is a local cache id only.
 */
internal fun configFileUrl(baseUrl: String, sdkKey: String): String? {
    val keyPath = if (SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
        sdkKey.split('/').joinToString("/") { escapePathSegment(it) }
    } else {
        if (sdkKey.isEmpty() || sdkKey == "." || sdkKey == "..") return null
        escapePathSegment(sdkKey)
    }
    return "${baseUrl.trimEnd('/')}/configuration-files/$keyPath/config_v6.json"
}

/**
 * True when [baseUrl] is an absolute `http://` or `https://` URL with a non-empty host and no query
 * or fragment (the config path is appended to it, so either would swallow the path). Ktor resolves
 * a scheme-less string against `http://localhost`, so the scheme is read from the raw text, never
 * from the parsed URL's default.
 */
internal fun isUsableBaseUrl(baseUrl: String): Boolean {
    val schemeEnd = baseUrl.indexOf(SCHEME_SEPARATOR)
    if (schemeEnd <= 0) return false
    val scheme = baseUrl.substring(0, schemeEnd).lowercase()
    if (scheme != "http" && scheme != "https") return false
    if ('?' in baseUrl || '#' in baseUrl) return false
    val authority = baseUrl.substring(schemeEnd + SCHEME_SEPARATOR.length).substringBefore('/')
    val host = authority.substringAfterLast('@').let { hostPort ->
        if (hostPort.startsWith("[")) hostPort.substringBefore(']').drop(1) else hostPort.substringBefore(':')
    }
    if (host.isBlank()) return false
    val parsed = parseUrlOrNull(baseUrl) ?: return false
    return parsed.protocol.name == scheme && parsed.host.isNotEmpty()
}

/** Ktor's [parseUrl], with any parser error (whose message quotes the URL) reduced to `null`. */
private fun parseUrlOrNull(url: String): Url? = try {
    parseUrl(url)
} catch (_: Exception) {
    null
}

private const val SCHEME_SEPARATOR = "://"
private const val HEX_DIGITS = "0123456789ABCDEF"
private const val SEGMENT_SAFE = "-_.~\$&+=:@"

/**
 * Percent-encodes [segment] as ONE path segment, byte-for-byte like Go's `url.PathEscape`: ASCII
 * letters, digits and `-_.~$&+=:@` are kept, every other UTF-8 byte (incl. `/`, `%`, `?`, `#`)
 * becomes `%XX`. Hand-rolled because Ktor's `encodeURLPath` keeps existing `%XX` sequences, which
 * would let a malformed key smuggle a `/` into the path.
 */
internal fun escapePathSegment(segment: String): String {
    val out = StringBuilder(segment.length)
    for (byte in segment.encodeToByteArray()) {
        val c = (byte.toInt() and 0xFF).toChar()
        if (isAsciiLetterOrDigit(c) || c in SEGMENT_SAFE) {
            out.append(c)
        } else {
            val b = byte.toInt() and 0xFF
            out.append('%').append(HEX_DIGITS[b shr 4]).append(HEX_DIGITS[b and 0x0F])
        }
    }
    return out.toString()
}

private fun isAsciiLetterOrDigit(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9'

/**
 * Reduces a transport or body error to a FIXED, key-free reason code (#803 FR-002) — sdk-go's
 * `classifyError` pattern. [fallback] names the stage that failed.
 *
 * <p>SECURITY: the request URL carries the SDK key, and Ktor quotes it in its messages
 * (`HttpRequestTimeoutException`: "Request timeout has expired [url=…]"). No exception text is
 * ever passed on: only the exception's type (or a cause's) picks the code.
 */
internal fun classifyFetchError(error: Throwable, fallback: String): String {
    var current: Throwable? = error
    var depth = 0
    while (current != null && depth < MAX_CAUSE_DEPTH) {
        when (current) {
            is HttpRequestTimeoutException,
            is ConnectTimeoutException,
            is SocketTimeoutException,
            is TimeoutCancellationException,
            -> return ConfigFetcher.TIMEOUT
            is SendCountExceedException -> return ConfigFetcher.TOO_MANY_REDIRECTS
            else -> Unit
        }
        current = current.cause
        depth++
    }
    return fallback
}

private const val MAX_CAUSE_DEPTH = 8

/** Returns the parsed `f` settings map of a config envelope, or null when missing/malformed. */
internal fun extractSettingsMap(body: JsonObject?): Map<String, JsonElement>? {
    if (body == null) return null
    val f = body["f"]
    return if (f is JsonObject) f.toMap() else null
}
