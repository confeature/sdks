// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.confeature.client.Logger;
import io.confeature.client.Version;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import okhttp3.Interceptor;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * OkHttp-based fetcher that pulls {@code config_v6.json} from the Confeature CDN.
 *
 * <p>Responsibilities:
 *
 * <ul>
 *   <li>User-Agent: {@code "confeature-java-sdk/<Version>"} (FR-012).
 *   <li>{@code If-None-Match} support for 304 reuse (FR-011).
 *   <li>Configurable request timeout (default 30s).
 *   <li>SDK key redaction in EVERY log line + error (FR-013): the raw key is NEVER interpolated;
 *       {@link SdkKey#redact(String)} is the only path.
 *   <li>Key-free failures (#803 FR-002): every transport or body error is reduced to a FIXED reason
 *       code before it reaches a log line or {@link FetchResult#getError()}. The request URL
 *       carries the SDK key (ConfigCat's wire protocol), so no library exception message is ever
 *       passed on — only the exception's type picks the code.
 * </ul>
 *
 * <p>The request path is ConfigCat's {@code <base>/configuration-files/<sdkKey>/config_v6.json},
 * built in {@code getUrl()} only — exactly what {@code com.configcat.ConfigFetcher#getRequest}
 * (configcat-java-client 10.0.0) sends: {@code url + "/configuration-files/" + sdkKey +
 * "/config_v6.json"}, the key raw.
 *
 * <p>Behaviourally mirrors {@code apps/sdk-go/internal/configfetcher/fetcher.go}: same URL scheme,
 * same headers, same fixed reason codes, same fail-closed result envelope.
 */
public final class ConfigFetcher implements AutoCloseable {

  /** Production CDN base URL. */
  public static final String DEFAULT_BASE_URL = "https://cdn-global.confeature.io";

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private static final char[] HEX = "0123456789ABCDEF".toCharArray();

  /** Discrete outcomes of one {@link #fetch(String)} call. */
  public enum Status {
    FETCHED,
    NOT_MODIFIED,
    FAILED
  }

  /** Outcome envelope of {@link #fetch(String)}. */
  public static final class FetchResult {
    private final Status status;
    private final Map<String, Object> body;
    private final String rawBody;
    private final String etag;
    private final String error;

    private FetchResult(
        Status status, Map<String, Object> body, String rawBody, String etag, String error) {
      this.status = status;
      this.body = body;
      this.rawBody = rawBody;
      this.etag = etag;
      this.error = error;
    }

    public static FetchResult fetched(Map<String, Object> body, String rawBody, String etag) {
      return new FetchResult(Status.FETCHED, body, rawBody, etag, "");
    }

    public static FetchResult notModified(String etag) {
      return new FetchResult(Status.NOT_MODIFIED, null, null, etag, "");
    }

    public static FetchResult failed(String error) {
      return new FetchResult(Status.FAILED, null, null, "", error == null ? "" : error);
    }

    public Status getStatus() {
      return status;
    }

    public Map<String, Object> getBody() {
      return body;
    }

    public String getRawBody() {
      return rawBody;
    }

    public String getEtag() {
      return etag;
    }

    public String getError() {
      return error;
    }
  }

  private final OkHttpClient httpClient;
  private final String sdkKey;
  private final String baseUrl;
  private final String userAgent;
  private final Logger logger;

  /**
   * Constructs a fetcher.
   *
   * @param baseUrl customer-supplied CDN URL; empty / null → {@link #DEFAULT_BASE_URL}.
   * @param sdkKey required (non-empty checked by caller).
   * @param timeout per-request timeout; {@code null} or non-positive → 30 seconds.
   * @param logger never null.
   */
  public ConfigFetcher(String baseUrl, String sdkKey, Duration timeout, Logger logger) {
    this(baseUrl, sdkKey, timeout, logger, null);
  }

  /**
   * Test seam — package-private, never public API: {@code interceptor}, when non-null, is added to
   * the OkHttp client as an application interceptor, so a test can make the transport raise an
   * unchecked exception and reach {@link #fetch(String)}'s last-resort catch.
   */
  ConfigFetcher(
      String baseUrl, String sdkKey, Duration timeout, Logger logger, Interceptor interceptor) {
    Objects.requireNonNull(sdkKey, "sdkKey");
    this.sdkKey = sdkKey;
    this.logger = Objects.requireNonNull(logger, "logger");

    final Duration resolvedTimeout =
        (timeout == null || timeout.isZero() || timeout.isNegative())
            ? Duration.ofSeconds(30)
            : timeout;
    final OkHttpClient.Builder clientBuilder =
        new OkHttpClient.Builder()
            .connectTimeout(resolvedTimeout)
            .readTimeout(resolvedTimeout)
            .callTimeout(resolvedTimeout);
    if (interceptor != null) {
      clientBuilder.addInterceptor(interceptor);
    }
    this.httpClient = clientBuilder.build();

    this.baseUrl =
        (baseUrl == null || baseUrl.isEmpty()) ? DEFAULT_BASE_URL : trimRightSlash(baseUrl);
    this.userAgent = "confeature-java-sdk/" + Version.SDK_VERSION;
  }

  /**
   * Returns the config URL — the ONE place the SDK builds it (#803 FR-001), {@code
   * <base>/configuration-files/<key path>/config_v6.json}, or {@code null} when the key cannot be a
   * path segment at all.
   *
   * <ul>
   *   <li>A key of either shared shape ({@link SdkKey#isValidConfeatureKeyFormat(String)}) travels
   *       RAW, as every ConfigCat SDK sends it: split on {@code /}, each part path-segment-escaped
   *       — a no-op for a valid key, so {@code configcat-sdk-1/<22>/<22>} stays three segments.
   *   <li>Any other key is escaped into ONE segment, so a {@code /}, {@code ?} or {@code #} in it
   *       cannot leave its segment.
   *   <li>{@code ""}, {@code "."} and {@code ".."} cannot be one segment — no escaper keeps them in
   *       place — so the result is {@code null} and {@link #fetch(String)} requests nothing.
   * </ul>
   *
   * <p>The cache-key tail is a local cache id only; it never goes on the wire.
   *
   * <p>Package-private on purpose: the URL carries the SDK key (ConfigCat's wire protocol), so no
   * public member may hand it out — only {@link #fetch(String)} and same-package tests read it.
   */
  String getUrl() {
    final String keyPath;
    if (SdkKey.isValidConfeatureKeyFormat(sdkKey)) {
      final String[] parts = sdkKey.split("/", -1);
      final StringBuilder joined = new StringBuilder(sdkKey.length());
      for (int i = 0; i < parts.length; i++) {
        if (i > 0) {
          joined.append('/');
        }
        joined.append(escapePathSegment(parts[i]));
      }
      keyPath = joined.toString();
    } else {
      if (sdkKey.isEmpty() || sdkKey.equals(".") || sdkKey.equals("..")) {
        return null;
      }
      keyPath = escapePathSegment(sdkKey);
    }
    return baseUrl + "/configuration-files/" + keyPath + "/config_v6.json";
  }

  /**
   * Issues a single GET. Never throws — failures land in {@link Status#FAILED} with a fixed,
   * key-free reason code.
   */
  public FetchResult fetch(String prevETag) {
    final String url = getUrl();
    if (url == null) {
      logger.error(
          "ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path segment; not fetching."
              + " sdkKey="
              + SdkKey.redact(sdkKey),
          null);
      return FetchResult.failed("INVALID_SDK_KEY");
    }
    final Request req;
    try {
      final Request.Builder builder =
          new Request.Builder()
              .url(url)
              .get()
              .header("User-Agent", userAgent)
              .header("Accept", "application/json");
      if (prevETag != null && !prevETag.isEmpty()) {
        try {
          builder.header("If-None-Match", prevETag);
        } catch (IllegalArgumentException refused) {
          // A stored ETag OkHttp refuses as a header value (a byte outside
          // HTAB / SP / VCHAR — OkHttp reads a response header leniently, so a
          // non-ASCII ETag can reach the cache). Sending it would throw on
          // every fetch; dropping it makes this fetch unconditional, and its
          // 200 replaces the ETag, so the next fetch heals. OkHttp's message
          // quotes the value; it is never passed on.
          logger.warning(
              "ConfigFetcher: dropped a stored ETag that is not a valid header value; fetching"
                  + " without If-None-Match. sdkKey="
                  + SdkKey.redact(sdkKey));
        }
      }
      req = builder.build();
    } catch (IllegalArgumentException e) {
      // Only a malformed base URL gets here; OkHttp's message quotes the
      // whole URL, key included, so it is never passed on.
      return fail("invalid_request");
    }

    try (Response resp = httpClient.newCall(req).execute()) {
      final int code = resp.code();
      final String etag = nullToEmpty(resp.header("ETag"));
      if (code == 304) {
        return FetchResult.notModified(etag);
      }
      if (code == 200) {
        final ResponseBody body = resp.body();
        if (body == null) {
          logger.error(
              "ConfigFetcher: 200 response with empty body. sdkKey=" + SdkKey.redact(sdkKey), null);
          return FetchResult.failed("EMPTY_BODY");
        }
        final String raw;
        try {
          raw = body.string();
        } catch (IOException readError) {
          return fail(classifyError(readError, "body_read_failed"));
        }
        try {
          @SuppressWarnings("unchecked")
          final Map<String, Object> parsed = MAPPER.readValue(raw, Map.class);
          // Shape validation: a valid config_v6.json carries the
          // {p, f, s} top-level shape. sdk-node + sdk-python + sdk-go +
          // sdk-rust tightened the same check so the corpus-wide
          // `wire-cases.json::wrong-shape-200` case surfaces the same
          // `parseFailed` everywhere (epic #146 / issue #148). A 200
          // with a body that doesn't match the contract is a stronger
          // signal of CDN drift than a 5xx and deserves its own typed
          // error class. Probing the `f` key alone is sufficient — it
          // is the only mandatory top-level key in the schema.
          // A JSON `null` body parses to a null map — the same shape failure
          // (Go's nil map has no "f" either), never an NPE out of fetch().
          if (parsed == null || !parsed.containsKey("f")) {
            logger.error(
                "ConfigFetcher: 200 response missing required 'f' key. sdkKey="
                    + SdkKey.redact(sdkKey),
                null);
            return FetchResult.failed("MALFORMED_JSON");
          }
          return FetchResult.fetched(parsed, raw, etag);
        } catch (IOException parseError) {
          // The parser's message quotes the body; never passed on.
          logger.error(
              "ConfigFetcher: malformed JSON body. sdkKey="
                  + SdkKey.redact(sdkKey)
                  + " reason=MALFORMED_JSON",
              null);
          return FetchResult.failed("MALFORMED_JSON");
        }
      }
      final String reason = "HTTP " + code;
      logger.error(
          "ConfigFetcher: fetch failed. sdkKey=" + SdkKey.redact(sdkKey) + " reason=" + reason,
          null);
      return FetchResult.failed(reason);
    } catch (IOException e) {
      return fail(classifyError(e, "network_error"));
    } catch (RuntimeException e) {
      // fetch() never throws: an unchecked error from the transport may
      // quote the request URL (and so the key); only a fixed code goes on,
      // with the exception's simple class name — never its message. An
      // anonymous class has no simple name: "RuntimeException", as
      // sdk-android logs it.
      final String simpleName = e.getClass().getSimpleName();
      return fail("network_error", simpleName.isEmpty() ? "RuntimeException" : simpleName);
    }
  }

  /** Logs a fixed reason code and returns it as a failed {@link FetchResult}. */
  private FetchResult fail(String reason) {
    return fail(reason, null);
  }

  /**
   * Logs a fixed reason code — plus, for an unchecked error, the exception's simple class name
   * ({@code exceptionType}, never its message) — and returns the code as a failed {@link
   * FetchResult}. The one log line every fetch failure shares, byte for byte sdk-android's {@code
   * ConfigFetcher.fail}: {@code ConfigFetcher: fetch raised. sdkKey=<redacted> reason=<code>[
   * exception=<SimpleName>]}.
   */
  private FetchResult fail(String reason, String exceptionType) {
    final String type = exceptionType == null ? "" : " exception=" + exceptionType;
    logger.error(
        "ConfigFetcher: fetch raised. sdkKey=" + SdkKey.redact(sdkKey) + " reason=" + reason + type,
        null);
    return FetchResult.failed(reason);
  }

  /**
   * Reduces a transport or body-read error to a FIXED, key-free reason code (#803 FR-002), the Go
   * fetcher's {@code classifyError}; {@code fallback} names the stage that failed.
   *
   * <p>SECURITY: the request URL carries the SDK key, and OkHttp may quote URLs in its messages. No
   * exception text is ever passed on — the type picks the code. The one message read is OkHttp's
   * fixed redirect-limit wording, matched only to pick {@code too_many_redirects}.
   */
  static String classifyError(IOException e, String fallback) {
    // OkHttp's call timeout is an InterruptedIOException("timeout"); a
    // connect/read timeout a SocketTimeoutException (a subclass).
    if (e instanceof SocketTimeoutException || e instanceof InterruptedIOException) {
      return "timeout";
    }
    if (e instanceof ProtocolException
        && e.getMessage() != null
        && e.getMessage().startsWith("Too many follow-up requests")) {
      return "too_many_redirects";
    }
    return fallback;
  }

  /**
   * Percent-encodes {@code segment} as ONE URL path segment, byte for byte Go's {@code
   * url.PathEscape} (#803 FR-001): RFC 3986's unreserved set ({@code A-Z a-z 0-9 - . _ ~}) and
   * {@code $ & + : = @} stay as they are; every other byte of the UTF-8 form becomes an uppercase
   * {@code %XX}. NOT {@link java.net.URLEncoder}, which is form encoding (a space becomes {@code
   * +}).
   */
  static String escapePathSegment(String segment) {
    final StringBuilder out = new StringBuilder(segment.length());
    for (byte b : segment.getBytes(StandardCharsets.UTF_8)) {
      final int c = b & 0xFF;
      if ((c >= 'A' && c <= 'Z')
          || (c >= 'a' && c <= 'z')
          || (c >= '0' && c <= '9')
          || c == '-'
          || c == '.'
          || c == '_'
          || c == '~'
          || c == '$'
          || c == '&'
          || c == '+'
          || c == ':'
          || c == '='
          || c == '@') {
        out.append((char) c);
      } else {
        out.append('%').append(HEX[c >> 4]).append(HEX[c & 0x0F]);
      }
    }
    return out.toString();
  }

  /** Releases idle connections. Best-effort; safe to call repeatedly. */
  @Override
  public void close() {
    httpClient.connectionPool().evictAll();
    httpClient.dispatcher().executorService().shutdown();
  }

  private static String trimRightSlash(String s) {
    int end = s.length();
    while (end > 0 && s.charAt(end - 1) == '/') {
      end--;
    }
    return end == s.length() ? s : s.substring(0, end);
  }

  private static String nullToEmpty(String s) {
    return s == null ? "" : s;
  }
}
