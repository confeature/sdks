// SPDX-License-Identifier: MIT

using System;
using System.Globalization;
using System.Text;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Confeature.Client.Internal;

/// <summary>
/// HTTP fetcher for <c>config_v6.json</c>. Mirrors
/// <c>apps/sdk-go/internal/configfetcher/fetcher.go</c> +
/// <c>apps/sdk-python/.../config_fetcher.py</c> 1:1.
/// </summary>
/// <remarks>
/// <para>Responsibilities:</para>
/// <list type="bullet">
///   <item><description>User-Agent: <c>confeature-dotnet-sdk/{Version}</c>.</description></item>
///   <item><description>If-None-Match: previous ETag for 304 reuse.</description></item>
///   <item><description>Configurable request timeout (default 30s).</description></item>
///   <item><description>Cancellation propagation via <see cref="CancellationToken"/>.</description></item>
///   <item><description>SDK key redacted in EVERY log line + error message (FR-021).</description></item>
/// </list>
/// <para>
/// SECURITY (#803 FR-002): the request URL carries the SDK key, exactly as
/// ConfigCat's wire protocol does (ConfigCat.Client 9.5.0
/// <c>ConfigCatClientOptions.GetConfigUri</c>). A transport exception's
/// message may quote that URL — a customer-supplied <see cref="HttpClient"/>
/// can carry any handler — so no exception message is EVER logged or
/// returned: every failure is reduced to a fixed reason code by
/// <see cref="ClassifyError"/>.
/// </para>
/// </remarks>
internal sealed class ConfigFetcher : IDisposable
{
    /// <summary>Production CDN base URL.</summary>
    public const string DefaultBaseUrl = "https://cdn-global.confeature.io";

    /// <summary>Default per-request timeout (30 seconds).</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly string _sdkKey;
    private readonly string _userAgent;
    private readonly Uri? _url;
    private readonly IConfeatureLogger _logger;

    /// <summary>Initialises a new <see cref="ConfigFetcher"/>.</summary>
    /// <param name="httpClient">
    /// The HTTP client. When non-null, the customer owns lifecycle and
    /// the fetcher MUST NOT dispose it. When null, the fetcher creates
    /// and owns a fresh client.
    /// </param>
    /// <param name="baseUrl">CDN base URL. Empty/null → <see cref="DefaultBaseUrl"/>.</param>
    /// <param name="sdkKey">Required SDK key. Travels in the request path (see <see cref="BuildConfigUrl"/>).</param>
    /// <param name="version">SDK version (stamped into User-Agent).</param>
    /// <param name="timeout">Per-request timeout. Non-positive → <see cref="DefaultTimeout"/>.</param>
    /// <param name="logger">Logger. Required.</param>
    public ConfigFetcher(
        HttpClient? httpClient,
        string? baseUrl,
        string sdkKey,
        string version,
        TimeSpan timeout,
        IConfeatureLogger logger)
    {
        if (sdkKey is null)
        {
            throw new ArgumentNullException(nameof(sdkKey));
        }

        if (version is null)
        {
            throw new ArgumentNullException(nameof(version));
        }

        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _sdkKey = sdkKey;

        var resolvedBase = string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl!;
        _url = BuildConfigUrl(resolvedBase, sdkKey);

        _userAgent = "confeature-dotnet-sdk/" + version;

        var resolvedTimeout = timeout <= TimeSpan.Zero ? DefaultTimeout : timeout;

        if (httpClient is null)
        {
            _httpClient = new HttpClient { Timeout = resolvedTimeout };
            _ownsHttpClient = true;
        }
        else
        {
            _httpClient = httpClient;
            _ownsHttpClient = false;
            // The fetcher cannot mutate a customer-owned HttpClient.Timeout
            // after first use (HttpClient throws). We honour the customer's
            // setting in that case.
        }
    }

    /// <summary>
    /// The full CDN URL the fetcher targets, or <c>null</c> when the key
    /// cannot travel in a path segment and the fetcher refuses to fetch.
    /// </summary>
    public Uri? Url => _url;

    /// <summary>
    /// Builds <c>&lt;baseUrl&gt;/configuration-files/&lt;sdkKey&gt;/config_v6.json</c>
    /// — the ONE place the config URL is built (#803 FR-001).
    /// </summary>
    /// <remarks>
    /// <list type="bullet">
    /// <item><description>A key matching the shared shape
    /// (<see cref="SdkKey.IsValidConfeatureKeyFormat"/>, tested against
    /// <c>sdk-key-shapes.json</c>) travels RAW: split on <c>/</c>, each part
    /// path-segment-escaped (a no-op for a valid key). These are ConfigCat's
    /// exact bytes — ConfigCat.Client 9.5.0 <c>GetConfigUri</c> concatenates
    /// <c>"configuration-files/" + sdkKey + "/config_v6.json"</c>.</description></item>
    /// <item><description>Any other key is escaped into ONE path segment,
    /// byte-identical to Go's <c>url.PathEscape</c>.</description></item>
    /// <item><description>An empty key, <c>.</c> or <c>..</c> would become a
    /// dot-segment no escaper keeps in place: returns <c>null</c>, and
    /// <see cref="FetchAsync"/> refuses to fetch (<c>INVALID_SDK_KEY</c>).</description></item>
    /// </list>
    /// </remarks>
    /// <param name="baseUrl">CDN base URL; trailing slashes are trimmed.</param>
    /// <param name="sdkKey">The SDK key.</param>
    /// <returns>The config URL, or <c>null</c> when the key cannot be fetched.</returns>
    internal static Uri? BuildConfigUrl(string baseUrl, string sdkKey)
    {
        if (sdkKey.Length == 0 || sdkKey == "." || sdkKey == "..")
        {
            return null;
        }

        string keyPath;
        if (SdkKey.IsValidConfeatureKeyFormat(sdkKey))
        {
            var parts = sdkKey.Split('/');
            for (var i = 0; i < parts.Length; i++)
            {
                parts[i] = PathEscape(parts[i]);
            }

            keyPath = string.Join("/", parts);
        }
        else
        {
            keyPath = PathEscape(sdkKey);
        }

        return new Uri(
            baseUrl.TrimEnd('/') + "/configuration-files/" + keyPath + "/config_v6.json",
            UriKind.Absolute);
    }

    /// <summary>
    /// Escapes <paramref name="value"/> into a single path segment, byte for
    /// byte like Go's <c>url.PathEscape</c>: ALPHA / DIGIT / <c>-_.~</c> and
    /// <c>$&amp;+:=@</c> stay; every other UTF-8 byte (including <c>/</c>,
    /// <c>;</c>, <c>,</c>, <c>?</c>, <c>%</c>) becomes <c>%XX</c>.
    /// </summary>
    internal static string PathEscape(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var sb = new StringBuilder(bytes.Length);
        foreach (var b in bytes)
        {
            var c = (char)b;
            var keep = (c >= 'a' && c <= 'z')
                || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c is '-' or '_' or '.' or '~' or '$' or '&' or '+' or ':' or '=' or '@';
            if (keep)
            {
                sb.Append(c);
            }
            else
            {
                sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Reduces a transport/body exception to a fixed, key-free reason code
    /// (#803 FR-002, Go's <c>classifyError</c> pattern). The exception's
    /// message is NEVER read: it may quote the request URL, which carries
    /// the SDK key.
    /// </summary>
    /// <param name="exception">The caught exception.</param>
    /// <param name="cancellationToken">The caller's token (distinguishes cancel from timeout).</param>
    /// <returns><c>CANCELLED</c>, <c>TIMEOUT</c> or <c>NETWORK_ERROR</c>.</returns>
    internal static string ClassifyError(Exception exception, CancellationToken cancellationToken)
    {
        if (exception is OperationCanceledException)
        {
            // HttpClient surfaces its own request timeout as a
            // TaskCanceledException on every TFM; only the caller's token
            // means a customer-initiated cancellation.
            return cancellationToken.IsCancellationRequested ? "CANCELLED" : "TIMEOUT";
        }

        return "NETWORK_ERROR";
    }

    /// <summary>
    /// Issues a single GET. Never throws. Failures land in
    /// <see cref="FetchResult.Status"/> = <see cref="FetchStatus.Failed"/>
    /// with a redacted <see cref="FetchResult.Error"/>.
    /// </summary>
    /// <param name="previousETag">
    /// Previous response's ETag. Empty/null skips the If-None-Match header.
    /// </param>
    /// <param name="cancellationToken">Per-call cancellation.</param>
    public async Task<FetchResult> FetchAsync(string? previousETag, CancellationToken cancellationToken = default)
    {
        if (_url is null)
        {
            // FR-001: an empty, "." or ".." key has no path segment to
            // travel in — refuse rather than request a different resource.
            _logger.Error(
                "ConfigFetcher: INVALID_SDK_KEY, refusing to fetch. sdkKey="
                + SdkKey.Redact(_sdkKey));
            return new FetchResult { Status = FetchStatus.Failed, Error = "INVALID_SDK_KEY" };
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, _url);
            request.Headers.UserAgent.ParseAdd(_userAgent);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (!string.IsNullOrEmpty(previousETag))
            {
                // EntityTagHeaderValue requires quoted form; use TryAddWithoutValidation
                // since some CDNs emit weak or unquoted etags.
                request.Headers.TryAddWithoutValidation("If-None-Match", previousETag);
            }

            using var response = await _httpClient.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken)
                .ConfigureAwait(false);

            var etag = response.Headers.ETag?.Tag ?? string.Empty;

            switch (response.StatusCode)
            {
                case HttpStatusCode.NotModified:
                    return new FetchResult
                    {
                        Status = FetchStatus.NotModified,
                        ETag = etag,
                    };
                case HttpStatusCode.OK:
                    {
                        // Read the body FIRST so a transport/body-read failure
                        // (e.g. a connection reset mid-response) classifies as a
                        // fetch failure, NOT a parse failure — a truncated body is
                        // a network error, not a JSON-shape error. Mirrors the
                        // JS shared fetcher's read-then-parse split (response.text()
                        // catch → fetchFailed; JSON.parse catch → parseFailed) and
                        // sdk-go's io.ReadAll-then-json.Unmarshal split. The
                        // wire-cases `network-reset` case (#490) pins this.
                        string body;
                        try
                        {
#if NETSTANDARD2_0 || NETSTANDARD2_1
                            body = await response.Content
                                .ReadAsStringAsync()
                                .ConfigureAwait(false);
#else
                            body = await response.Content
                                .ReadAsStringAsync(cancellationToken)
                                .ConfigureAwait(false);
#endif
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            // Body-read/transport failure (reset, truncated stream,
                            // mid-response abort). Mirrors sdk-go's
                            // io.ReadAll error → fetchFailed: ANY read error here is
                            // a transport failure, NOT a parse error. Cancellation /
                            // timeouts surface as OperationCanceledException and are
                            // intentionally excluded so they fall through to the
                            // outer handlers and classify as CANCELLED / TIMEOUT.
                            var reason = ClassifyError(ex, cancellationToken);
                            _logger.Error(
                                "ConfigFetcher: fetch body read failed. sdkKey="
                                + SdkKey.Redact(_sdkKey) + " reason=" + reason);
                            return new FetchResult
                            {
                                Status = FetchStatus.Failed,
                                Error = reason,
                            };
                        }

                        try
                        {
                            var parsed = JsonSerializer.Deserialize<JsonElement>(body, JsonOptions);

                            // Shape validation: a valid config_v6.json carries the
                            // {p, f, s} top-level shape. sdk-node / sdk-python /
                            // sdk-go / sdk-rust tightened the same check so the
                            // corpus-wide `wire-cases.json::wrong-shape-200` case
                            // surfaces the same `parseFailed` everywhere
                            // (epic #146 / issue #148 / spec 112). A 200 with a
                            // body that doesn't match the contract is a stronger
                            // signal of CDN drift than a 5xx and deserves its own
                            // typed error class. Probing the `f` key alone is
                            // sufficient — it is the only mandatory top-level key
                            // in the schema.
                            if (parsed.ValueKind != JsonValueKind.Object
                                || !parsed.TryGetProperty("f", out _))
                            {
                                _logger.Error(
                                    "ConfigFetcher: fetch returned JSON without 'f' key. sdkKey="
                                    + SdkKey.Redact(_sdkKey));
                                return new FetchResult
                                {
                                    Status = FetchStatus.Failed,
                                    Error = "MALFORMED_JSON",
                                };
                            }

                            return new FetchResult
                            {
                                Status = FetchStatus.Fetched,
                                Body = parsed,
                                RawBody = body,
                                ETag = etag,
                            };
                        }
                        catch (JsonException)
                        {
                            _logger.Error(
                                "ConfigFetcher: fetch returned non-JSON body. sdkKey="
                                + SdkKey.Redact(_sdkKey) + " reason=MALFORMED_JSON");
                            return new FetchResult
                            {
                                Status = FetchStatus.Failed,
                                Error = "MALFORMED_JSON",
                            };
                        }
                    }

                default:
                    {
                        var reason = string.Format(
                            CultureInfo.InvariantCulture,
                            "HTTP {0}",
                            (int)response.StatusCode);
                        _logger.Error(
                            "ConfigFetcher: fetch failed. sdkKey="
                            + SdkKey.Redact(_sdkKey) + " reason=" + reason);
                        return new FetchResult
                        {
                            Status = FetchStatus.Failed,
                            Error = reason,
                        };
                    }
            }
        }
        catch (Exception ex)
        {
            // Never throws: ANY failure — including whatever a
            // customer-supplied handler raises — becomes a fixed reason.
            var reason = ClassifyError(ex, cancellationToken);
            if (reason != "CANCELLED")
            {
                // Customer-initiated cancellation is not an error; the poll
                // loop decides whether to retry.
                _logger.Error(
                    "ConfigFetcher: fetch failed. sdkKey="
                    + SdkKey.Redact(_sdkKey) + " reason=" + reason);
            }

            return new FetchResult { Status = FetchStatus.Failed, Error = reason };
        }
    }

    /// <summary>
    /// Releases the underlying <see cref="HttpClient"/> iff the fetcher
    /// constructed it. Customer-owned clients are NEVER disposed.
    /// </summary>
    public void Dispose()
    {
        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }

    /// <summary>
    /// Returns <c>true</c> when the fetcher owns the underlying
    /// <see cref="HttpClient"/>. Used by tests + the client wiring layer
    /// to assert ownership semantics.
    /// </summary>
    internal bool OwnsHttpClient => _ownsHttpClient;
}

/// <summary>Outcome status of a single <see cref="ConfigFetcher.FetchAsync"/> call.</summary>
internal enum FetchStatus
{
    /// <summary>200 OK with a valid JSON body.</summary>
    Fetched = 0,

    /// <summary>304 Not Modified — caller reuses the cached body.</summary>
    NotModified = 1,

    /// <summary>Any failure: HTTP error, network error, timeout, parse error, or cancellation.</summary>
    Failed = 2,
}

/// <summary>Single <see cref="ConfigFetcher.FetchAsync"/> result.</summary>
internal sealed class FetchResult
{
    /// <summary>Outcome status.</summary>
    public FetchStatus Status { get; init; }

    /// <summary>Parsed JSON body. Populated only when <see cref="Status"/> = <see cref="FetchStatus.Fetched"/>.</summary>
    public JsonElement Body { get; init; }

    /// <summary>Raw body string. Populated only when <see cref="Status"/> = <see cref="FetchStatus.Fetched"/>.</summary>
    public string? RawBody { get; init; }

    /// <summary>Response ETag. Populated on Fetched + NotModified.</summary>
    public string ETag { get; init; } = string.Empty;

    /// <summary>Short, key-free error reason. Populated only when <see cref="Status"/> = <see cref="FetchStatus.Failed"/>.</summary>
    public string Error { get; init; } = string.Empty;
}
