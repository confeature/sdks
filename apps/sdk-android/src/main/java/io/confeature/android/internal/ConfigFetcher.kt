// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import io.confeature.android.Logger
import io.confeature.android.Version
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.time.Duration
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * OkHttp-based fetcher that pulls `config_v6.json` from the Confeature CDN.
 *
 * Responsibilities:
 * - User-Agent: `"confeature-android-sdk/<Version>"` (FR-012).
 * - `If-None-Match` support for 304 reuse (FR-011).
 * - Configurable request timeout (default 30s).
 * - SDK key redaction in EVERY log line + error (FR-013): the raw key is NEVER interpolated;
 *   [SdkKey.redact] is the only path.
 * - Key-free failures (#803 FR-002): every transport or body error is reduced to a FIXED reason
 *   code before it reaches a log line or [FetchResult.error]. The request URL carries the SDK key
 *   (ConfigCat's wire protocol), so no library exception message is ever passed on — only the
 *   exception's type picks the code.
 *
 * The request path is ConfigCat's `<base>/configuration-files/<sdkKey>/config_v6.json`, built in
 * [buildUrl] only — exactly what `com.configcat.ConfigFetcher#getRequest` (configcat-android-client
 * 10.4.3) sends: `url + "/configuration-files/" + sdkKey + "/" + Constants.CONFIG_FILE_NAME`, the
 * key raw.
 *
 * Behaviourally mirrors `apps/sdk-go/internal/configfetcher/fetcher.go` and the .NET / Java
 * fetchers: same URL scheme, same headers, same fixed reason codes, same fail-closed result
 * envelope.
 */
public class ConfigFetcher internal constructor(
    baseUrl: String?,
    sdkKey: String,
    timeout: Duration?,
    private val logger: Logger,
    callFactory: Call.Factory?,
) : AutoCloseable {
    /** The production constructor: requests go through the fetcher's own OkHttp client. */
    public constructor(baseUrl: String?, sdkKey: String, timeout: Duration?, logger: Logger) :
        this(baseUrl, sdkKey, timeout, logger, null)

    public companion object {
        /** Production CDN base URL. */
        public const val DEFAULT_BASE_URL: String = "https://cdn-global.confeature.io"

        private fun trimRightSlash(s: String): String {
            var end = s.length
            while (end > 0 && s[end - 1] == '/') end--
            return if (end == s.length) s else s.substring(0, end)
        }

        private val HEX: CharArray = "0123456789ABCDEF".toCharArray()

        /**
         * Builds the config URL — the ONE place the SDK builds it (#803 FR-001),
         * `<base>/configuration-files/<key path>/config_v6.json`, or `null` when the key cannot be
         * a path segment at all.
         *
         * - A key of either shared shape ([SdkKey.isValidConfeatureKeyFormat]) travels RAW, as
         *   every ConfigCat SDK sends it: split on `/`, each part path-segment-escaped — a no-op for
         *   a valid key, so `configcat-sdk-1/<22>/<22>` stays three segments.
         * - Any other key is escaped into ONE segment, so a `/`, `?` or `#` in it cannot leave its
         *   segment.
         * - `""`, `"."` and `".."` cannot be one segment — no escaper keeps them in place — so the
         *   result is `null` and [fetch] requests nothing.
         *
         * The cache-key tail is a local cache id only; it never goes on the wire.
         */
        @JvmStatic
        internal fun buildUrl(base: String, sdkKey: String): String? {
            val keyPath = if (SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
                sdkKey.split('/').joinToString("/") { escapePathSegment(it) }
            } else {
                if (sdkKey.isEmpty() || sdkKey == "." || sdkKey == "..") return null
                escapePathSegment(sdkKey)
            }
            return "$base/configuration-files/$keyPath/config_v6.json"
        }

        /** The bytes Go's `url.PathEscape` keeps besides `A-Z a-z 0-9`. */
        private const val PATH_SEGMENT_KEEP: String = "-_.~$&+:=@"

        /**
         * Percent-encodes [segment] as ONE URL path segment, byte for byte what Go's
         * `url.PathEscape` produces (#803 FR-001, the federation's canonical escaper): it keeps
         * `A-Z a-z 0-9`, the unreserved marks `- _ . ~` and the sub-delims `$ & + : = @`; every
         * other byte of the UTF-8 form — `/ ; , ? # %`, space, `! ' ( ) *`, non-ASCII — becomes
         * `%XX` with uppercase hex. NOT RFC 3986's unreserved-only set (which escapes
         * `$ & + : = @`), NOT [java.net.URLEncoder] (form encoding: a space becomes `+`).
         */
        @JvmStatic
        internal fun escapePathSegment(segment: String): String {
            val out = StringBuilder(segment.length)
            for (b in segment.toByteArray(StandardCharsets.UTF_8)) {
                val c = b.toInt() and 0xFF
                if (c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code ||
                    PATH_SEGMENT_KEEP.indexOf(c.toChar()) >= 0
                ) {
                    out.append(c.toChar())
                } else {
                    out.append('%').append(HEX[c shr 4]).append(HEX[c and 0x0F])
                }
            }
            return out.toString()
        }

        /**
         * Reduces a transport or body-read error to a FIXED, key-free reason code (#803 FR-002),
         * the Go fetcher's `classifyError`; [fallback] names the stage that failed.
         *
         * SECURITY: the request URL carries the SDK key, and OkHttp may quote URLs in its
         * messages. No exception text is ever passed on — the type picks the code. The one message
         * read is OkHttp's fixed redirect-limit wording, matched only to pick `too_many_redirects`.
         */
        @JvmStatic
        internal fun classifyError(e: IOException, fallback: String): String {
            // OkHttp's call timeout is an InterruptedIOException("timeout"); a connect/read
            // timeout a SocketTimeoutException (a subclass).
            if (e is SocketTimeoutException || e is InterruptedIOException) return "timeout"
            if (e is ProtocolException && e.message?.startsWith("Too many follow-up requests") == true) {
                return "too_many_redirects"
            }
            return fallback
        }
    }

    /** Discrete outcomes of one [fetch] call. */
    public enum class Status { FETCHED, NOT_MODIFIED, FAILED }

    /** Outcome envelope of [fetch]. */
    public data class FetchResult(
        val status: Status,
        val body: Map<String, Any?>?,
        val rawBody: String?,
        val etag: String,
        val error: String,
    ) {
        public companion object {
            @JvmStatic
            public fun fetched(body: Map<String, Any?>, rawBody: String, etag: String): FetchResult =
                FetchResult(Status.FETCHED, body, rawBody, etag, "")

            @JvmStatic
            public fun notModified(etag: String): FetchResult =
                FetchResult(Status.NOT_MODIFIED, null, null, etag, "")

            @JvmStatic
            public fun failed(error: String): FetchResult =
                FetchResult(Status.FAILED, null, null, "", error)
        }
    }

    private val sdkKey: String = sdkKey
    private val httpClient: OkHttpClient

    /**
     * What [fetch] creates its call with — [httpClient] in production. Fixed at construction: a
     * test hands its own through the `internal` constructor (to reach the unchecked-error path no
     * JVM transport raises on its own), and nothing can swap it afterwards — a Kotlin `internal`
     * `var` would compile to a PUBLIC JVM setter (#803).
     */
    private val callFactory: Call.Factory

    /**
     * The config URL ([buildUrl]); `null` when the key cannot be a path segment. PRIVATE, not
     * `internal`: it carries the SDK key, and a Kotlin `internal` getter is still a public JVM
     * method (`getUrl$<module>`), callable from Java (#803).
     */
    private val url: String?
    private val userAgent: String

    init {
        val resolvedTimeout = timeout
            ?.takeIf { !it.isZero && !it.isNegative }
            ?: Duration.ofSeconds(30)
        httpClient = OkHttpClient.Builder()
            .connectTimeout(resolvedTimeout)
            .readTimeout(resolvedTimeout)
            .callTimeout(resolvedTimeout)
            .build()
        this.callFactory = callFactory ?: httpClient
        val resolvedBase = if (baseUrl.isNullOrEmpty()) DEFAULT_BASE_URL else trimRightSlash(baseUrl)
        url = buildUrl(resolvedBase, sdkKey)
        userAgent = "confeature-android-sdk/${Version.SDK_VERSION}"
    }

    /**
     * Issues a single GET. Never throws — failures land in [Status.FAILED] with a fixed, key-free
     * reason code.
     */
    public fun fetch(prevETag: String?): FetchResult {
        val target = url
        if (target == null) {
            logger.error(
                "ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path segment; not fetching." +
                    " sdkKey=${SdkKey.redact(sdkKey)}",
                null,
            )
            return FetchResult.failed("INVALID_SDK_KEY")
        }
        val builder = try {
            Request.Builder().url(target).get()
                .header("User-Agent", userAgent)
                .header("Accept", "application/json")
        } catch (e: IllegalArgumentException) {
            // A malformed base URL: OkHttp's message may quote the URL, key included. It is
            // never passed on, and fetch never throws.
            return fail("invalid_request")
        }
        if (!prevETag.isNullOrEmpty()) {
            try {
                builder.header("If-None-Match", prevETag)
            } catch (e: IllegalArgumentException) {
                // OkHttp refuses the stored ETag as a header value (e.g. non-ASCII bytes a server
                // sent — OkHttp reads response headers leniently). Failing here would fail every
                // later fetch, the bad ETag being stored and persisted; instead the conditional
                // header is dropped, the full config is fetched, and its ETag replaces the stored
                // one. OkHttp checks before it sets, so the builder is unchanged. The message,
                // which quotes the value, is not passed on.
                logger.warning(
                    "ConfigFetcher: the stored ETag is not a valid header value; fetching without" +
                        " If-None-Match. sdkKey=${SdkKey.redact(sdkKey)}",
                )
            }
        }
        val req = builder.build()
        return try {
            callFactory.newCall(req).execute().use { resp ->
                val code = resp.code
                val etag = resp.header("ETag") ?: ""
                when {
                    code == 304 -> FetchResult.notModified(etag)
                    code == 200 -> {
                        val body = resp.body
                        if (body == null) {
                            logger.error(
                                "ConfigFetcher: 200 response with empty body. sdkKey=${SdkKey.redact(sdkKey)}",
                                null,
                            )
                            FetchResult.failed("EMPTY_BODY")
                        } else {
                            // Read the body FIRST, then parse — a deliberate split (#590).
                            // A transport/body-read failure (e.g. the connection dropping
                            // mid-response) must classify as a fetch failure, NOT a parse
                            // failure: a truncated body is a network error, not a JSON-shape
                            // error. The body read raises IOException, which propagates to the
                            // outer catch → "fetchFailed"; the parse step below raises only
                            // IllegalArgumentException → "parseFailed". This mirrors sdk-go's
                            // read-then-parse split (apps/sdk-go/internal/configfetcher/
                            // fetcher.go) and the JS shared fetcher (response.text() catch →
                            // fetchFailed; JSON.parse catch → parseFailed). The wire-cases
                            // `network-reset` case (#490) pins this. The read failure reports
                            // the fixed `body_read_failed` / `timeout` code (#803 FR-002).
                            val raw = try {
                                body.string()
                            } catch (readError: IOException) {
                                return fail(classifyError(readError, "body_read_failed"))
                            }
                            try {
                                val parsed = JsonParser.parseObject(raw)
                                // Shape validation: a valid config_v6.json carries the
                                // {p, f, s} top-level shape. sdk-node + sdk-python +
                                // sdk-go + sdk-rust + sdk-java tightened the same
                                // check so the corpus-wide
                                // `wire-cases.json::wrong-shape-200` case surfaces
                                // the same `parseFailed` everywhere (epic #146 /
                                // issue #148). A 200 with a body that doesn't match
                                // the contract is a stronger signal of CDN drift
                                // than a 5xx and deserves its own typed error class.
                                // Probing the `f` key alone is sufficient — it is
                                // the only mandatory top-level key in the schema.
                                if (!parsed.containsKey("f")) {
                                    logger.error(
                                        "ConfigFetcher: 200 response missing required 'f' key. " +
                                            "sdkKey=${SdkKey.redact(sdkKey)}",
                                        null,
                                    )
                                    FetchResult.failed("MALFORMED_JSON")
                                } else {
                                    FetchResult.fetched(parsed, raw, etag)
                                }
                            } catch (parseError: IllegalArgumentException) {
                                // The parser's message quotes the body; never passed on.
                                logger.error(
                                    "ConfigFetcher: malformed JSON body. sdkKey=${SdkKey.redact(sdkKey)}" +
                                        " reason=MALFORMED_JSON",
                                    null,
                                )
                                FetchResult.failed("MALFORMED_JSON")
                            }
                        }
                    }
                    else -> {
                        val reason = "HTTP $code"
                        logger.error(
                            "ConfigFetcher: fetch failed. sdkKey=${SdkKey.redact(sdkKey)} reason=$reason",
                            null,
                        )
                        FetchResult.failed(reason)
                    }
                }
            }
        } catch (e: IOException) {
            fail(classifyError(e, "network_error"))
        } catch (e: RuntimeException) {
            // fetch never throws: an unchecked library error (e.g. a SecurityException when the
            // app lacks the INTERNET permission) ends as the same fixed code. Only its class's
            // simple name is logged, to tell the cases apart — a class name carries no key; its
            // message, which could quote the request URL, is never passed on.
            fail("network_error", e.javaClass.simpleName.ifEmpty { "RuntimeException" })
        }
    }

    /**
     * Logs a fixed reason code — plus, for an unchecked error, the exception's simple class name
     * ([exceptionType], never its message) — and returns the code as a failed [FetchResult].
     */
    private fun fail(reason: String, exceptionType: String? = null): FetchResult {
        val type = if (exceptionType == null) "" else " exception=$exceptionType"
        logger.error("ConfigFetcher: fetch raised. sdkKey=${SdkKey.redact(sdkKey)} reason=$reason$type", null)
        return FetchResult.failed(reason)
    }

    /** Releases idle connections. Best-effort; safe to call repeatedly. */
    override fun close() {
        httpClient.connectionPool.evictAll()
        httpClient.dispatcher.executorService.shutdown()
    }
}
