// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests.Wire;

/// <summary>
/// Wire-protocol fixture suite (.NET consumer).
/// </summary>
/// <remarks>
/// <para>
/// Drives <see cref="ConfigFetcher"/> against each case in
/// <c>packages/test-fixtures-sdk-parity/fixtures/wire-cases.json</c>.
/// The corpus is the language-agnostic contract; this file is the .NET
/// consumer that maps the fetcher's typed <see cref="FetchStatus"/> +
/// stringly-typed <see cref="FetchResult.Error"/> onto the corpus's
/// normalised <c>{fetched, notModified, failed}</c> x
/// <c>{fetchFailed, timeout, parseFailed, invalidSdkKey}</c> vocabulary
/// — the language-agnostic contract the other six SDK families
/// already conform to (sdk-node / sdk-browser-js / sdk-bun / sdk-deno /
/// sdk-python / sdk-go / sdk-rust).
/// </para>
/// <para>
/// Layer choice: this drives the fetcher directly (NOT the public
/// <see cref="ConfeatureClient"/>), matching what sdk-node /
/// sdk-browser-js / sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-rust
/// already do — the wire-cases corpus by name tests wire behaviour,
/// and the fetcher is sdk-dotnet's wire layer. Driving the public
/// client would add poll-service + cache-write indirection that the
/// corpus does not assert.
/// </para>
/// <para>
/// See epic #146 (contract testing framework) + #148 slice 6 (this
/// suite) + spec 112.
/// </para>
/// </remarks>
public class WireCasesTests
{
    /// <summary>
    /// Synthetic SDK key. Shape mirrors the production envelope so
    /// <c>SdkKey.DeriveCacheKey</c> succeeds; the value is otherwise
    /// inert (no upstream traffic in this suite).
    /// </summary>
    private const string WireTestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    private const string WireTestBaseUrl = "https://cdn.test.confeature.io";

    /// <summary>xUnit <see cref="TheoryAttribute"/> row source — one row per case.</summary>
    public static IEnumerable<object[]> WireCases()
    {
        foreach (var caseElement in WireCaseAssertions.Cases)
        {
            var id = caseElement.GetProperty("id").GetString()
                ?? throw new InvalidOperationException("Case missing 'id'");
            yield return new object[] { id, caseElement.GetRawText() };
        }
    }

    /// <summary>
    /// One xUnit row per fixture case. The string-only signature keeps
    /// xUnit's serializer happy (it cannot serialize
    /// <see cref="JsonElement"/> across the [Theory] boundary).
    /// </summary>
    [Theory]
    [MemberData(nameof(WireCases))]
    public async Task Wire_case_conforms_to_corpus(string id, string caseJson)
    {
        // id is the xUnit display name; keep the var alive for clarity.
        _ = id;

        using var caseDoc = JsonDocument.Parse(caseJson);
        var root = caseDoc.RootElement;
        var given = root.GetProperty("given");
        var server = root.GetProperty("server");
        WireCaseAssertions.AssertCaseHasOnlyKnownFields(root);

        // The behaviour adapter (#490) maps server.behavior onto the mock
        // transport: "respond" (default/absent) delivers status+headers+body;
        // "timeout" hangs past the client timeout; "close-mid-response" drops
        // the connection mid-body. An unrecognised value FAILS the case
        // loudly (never falls through to respond).
        var behavior = WireCaseAssertions.ReadNullableString(server, "behavior") ?? "respond";

        // ---- Wire up the mock handler -----------------------------------
        var capturedRequest = new RequestCapture();
        var bodyBytes = ResolveBody(server);
        using var handler = new BehaviorHandler(
            capture: capturedRequest,
            behavior: behavior,
            status: (HttpStatusCode)server.GetProperty("status").GetInt32(),
            headers: ReadHeaderMap(server, "headers"),
            body: bodyBytes);

        // The timeout case needs a short deadline so the suite stays fast;
        // every other behaviour keeps the standard 1s budget. The test owns
        // the HttpClient, so the timeout lives here (the fetcher does NOT
        // mutate a customer-owned client's timeout).
        var requestTimeout = behavior == "timeout"
            ? TimeSpan.FromMilliseconds(100)
            : TimeSpan.FromSeconds(1);
        using var httpClient = new HttpClient(handler) { Timeout = requestTimeout };

        // ---- Drive the fetcher ------------------------------------------
        // FR-003: the case's key (always a valid sdk-key-shapes.json key)
        // and base URL, when pinned, configure the SDK.
        var sdkKey = WireCaseAssertions.SdkKeyFor(root, WireTestSdkKey);
        var baseUrl = WireCaseAssertions.ReadNullableString(given, "baseUrl") ?? WireTestBaseUrl;
        using var fetcher = new ConfigFetcher(
            httpClient: httpClient,
            baseUrl: baseUrl,
            sdkKey: sdkKey,
            version: "0.0.0-wire-test",
            timeout: requestTimeout,
            logger: new CapturingLogger());

        string? previousETag = WireCaseAssertions.ReadNullableString(given, "previousEtag");
        var result = await fetcher.FetchAsync(previousETag, CancellationToken.None);

        // ---- Judge it by the shared rules ------------------------------
        capturedRequest.Request.Should().NotBeNull(
            because: "fetcher MUST issue exactly one HTTP request");
        var sentRequest = capturedRequest.Request!;
        var sentUri = sentRequest.RequestUri!;
        var inmHeader = sentRequest.Headers.TryGetValues("If-None-Match", out var headerValues)
            ? string.Join(",", headerValues)
            : null;
        WireCaseAssertions.AssertWireCase(
            root,
            sdkKey,
            new SentRequest(sentUri.AbsolutePath, sentUri.PathAndQuery, inmHeader),
            result);
    }

    /// <summary>
    /// Proves the unknown-field guard fails closed (#803 FR-003): a real
    /// corpus case with one extra field in any section must FAIL, not pass
    /// with the field silently ignored. Mirrors sdk-go's
    /// <c>TestWireCorpus_UnknownFieldFails</c>.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("given")]
    [InlineData("server")]
    [InlineData("expected")]
    public async Task Wire_case_with_an_unknown_field_fails(string? section)
    {
        // A passing case: only the injected field can make it fail.
        var baseline = WireCaseAssertions.Cases
            .Single(c => c.GetProperty("id").GetString() == "fresh-fetch-200");
        var mutated = System.Text.Json.Nodes.JsonNode.Parse(baseline.GetRawText())!.AsObject();
        var target = section is null ? mutated : mutated[section]!.AsObject();
        target["unknownField803"] = true;

        Func<Task> act = () => Wire_case_conforms_to_corpus("unknown-field-probe", mutated.ToJsonString());

        await act.Should().ThrowAsync<Xunit.Sdk.XunitException>()
            .WithMessage("*unknownField803*");
    }

    /// <summary>Control for the probe above: the untouched baseline case passes.</summary>
    [Fact]
    public async Task Wire_case_probe_baseline_passes_untouched()
    {
        var baseline = WireCaseAssertions.Cases
            .Single(c => c.GetProperty("id").GetString() == "fresh-fetch-200");

        await Wire_case_conforms_to_corpus("baseline", baseline.GetRawText());
    }

    /// <summary>
    /// The error-class mapping fails closed: a missing or unknown reason maps
    /// to no corpus class, so it can never pass a <c>fetchFailed</c> case
    /// (the old fold to <c>fetchFailed</c> did).
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("SOME_NEW_REASON")]
    public void Error_mapping_fails_closed_on_an_unknown_reason(string? raw)
    {
        WireCaseAssertions.MapDotnetErrorToClass(raw).Should().StartWith("unmapped:");
    }

    /// <summary>Every fixed reason the fetcher emits has its corpus class.</summary>
    [Theory]
    [InlineData("MALFORMED_JSON", "parseFailed")]
    [InlineData("HTTP 403", "invalidSdkKey")]
    [InlineData("HTTP 404", "invalidSdkKey")]
    [InlineData("INVALID_SDK_KEY", "invalidSdkKey")]
    [InlineData("HTTP 500", "fetchFailed")]
    [InlineData("TIMEOUT", "timeout")]
    [InlineData("NETWORK_ERROR", "fetchFailed")]
    [InlineData("CANCELLED", "fetchFailed")]
    public void Error_mapping_maps_every_fixed_reason(string raw, string wanted)
    {
        WireCaseAssertions.MapDotnetErrorToClass(raw).Should().Be(wanted);
    }

    /// <summary>
    /// Resolves the response body for a case. <c>bodyRef</c> points to
    /// a sibling fixture JSON under
    /// <c>packages/test-fixtures-sdk-parity/fixtures</c>; <c>body</c>
    /// is a raw string (used for malformed-payload cases). Either may
    /// be absent (e.g. 304 has no body).
    /// </summary>
    private static byte[]? ResolveBody(JsonElement server)
    {
        if (server.TryGetProperty("bodyRef", out var bodyRef)
            && bodyRef.ValueKind == JsonValueKind.String)
        {
            var refPath = Path.Combine(
                WireCaseAssertions.WireFixturesDir(),
                bodyRef.GetString()!);
            return File.ReadAllBytes(refPath);
        }

        if (server.TryGetProperty("body", out var bodyEl)
            && bodyEl.ValueKind == JsonValueKind.String)
        {
            return Encoding.UTF8.GetBytes(bodyEl.GetString()!);
        }

        return null;
    }

    private static Dictionary<string, string> ReadHeaderMap(JsonElement parent, string key)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (parent.TryGetProperty(key, out var hdrs) && hdrs.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in hdrs.EnumerateObject())
            {
                if (prop.Value.ValueKind == JsonValueKind.String)
                {
                    result[prop.Name] = prop.Value.GetString()!;
                }
            }
        }

        return result;
    }

    /// <summary>Inbound-request capture sink (set once per fetch).</summary>
    private sealed class RequestCapture
    {
        public HttpRequestMessage? Request { get; set; }
    }

    /// <summary>
    /// <see cref="HttpMessageHandler"/> stub that captures the inbound
    /// request and emits a response driven by the corpus
    /// <c>server.behavior</c> discriminator (#490). stdlib-only — no
    /// MockHttp dependency in this consumer so the wire test reads
    /// top-to-bottom in pure <c>System.Net.Http</c> terms.
    /// </summary>
    /// <remarks>
    /// Mirrors sdk-go's <c>httptest</c> behaviour adapter
    /// (apps/sdk-go/wire_cases_test.go):
    /// <list type="bullet">
    ///   <item><description><c>respond</c> (default/absent): deliver
    ///     status+headers+body.</description></item>
    ///   <item><description><c>timeout</c>: hang on the linked token until
    ///     <see cref="HttpClient.Timeout"/> cancels it → the fetcher's
    ///     timeout path → <c>timeout</c> class.</description></item>
    ///   <item><description><c>close-mid-response</c>: return 200 whose
    ///     content stream throws <see cref="IOException"/> partway through
    ///     reading → the fetcher's body-read failure → <c>fetchFailed</c>
    ///     (NOT <c>parseFailed</c>: a truncated body is a transport error,
    ///     not a JSON-shape error).</description></item>
    ///   <item><description>any other value: FAIL the case loudly, never
    ///     fall through to <c>respond</c>.</description></item>
    /// </list>
    /// </remarks>
    private sealed class BehaviorHandler : HttpMessageHandler
    {
        private readonly RequestCapture _capture;
        private readonly string _behavior;
        private readonly HttpStatusCode _status;
        private readonly IReadOnlyDictionary<string, string> _headers;
        private readonly byte[]? _body;

        public BehaviorHandler(
            RequestCapture capture,
            string behavior,
            HttpStatusCode status,
            IReadOnlyDictionary<string, string> headers,
            byte[]? body)
        {
            _capture = capture;
            _behavior = behavior;
            _status = status;
            _headers = headers;
            _body = body;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            // Clone the request envelope before the using/dispose chain
            // unwinds. We only need the URL + headers downstream, so a
            // shallow snapshot is sufficient.
            var snapshot = new HttpRequestMessage(request.Method, request.RequestUri);
            foreach (var h in request.Headers)
            {
                snapshot.Headers.TryAddWithoutValidation(h.Key, h.Value);
            }

            _capture.Request = snapshot;

            switch (_behavior)
            {
                case "respond":
                    return BuildResponse(new ByteArrayContent(_body ?? Array.Empty<byte>()));

                case "timeout":
                    // Hang until the client's timeout cancels the linked
                    // token: HttpClient.Timeout fires → OperationCanceledException
                    // → the fetcher's TaskCanceledException path → timeout class.
                    // The nominal status/headers/body are never delivered.
                    await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
                    throw new InvalidOperationException("unreachable: timeout token must fire");

                case "close-mid-response":
                    // Drop the connection mid-body: hand back a 200 whose
                    // content stream yields a few bytes then throws. The
                    // fetcher's body read sees a transport failure → fetchFailed
                    // (a truncated body is NOT a JSON-shape error).
                    return BuildResponse(new StreamContent(
                        new ThrowingStream(_body ?? Array.Empty<byte>())));

                default:
                    // Unrecognised behaviour — FAIL loudly, never fall through
                    // to the respond path (FR-008 guard, mirrors sdk-go).
                    Assert.Fail(
                        $"wire-cases: unsupported server.behavior '{_behavior}' — no adapter");
                    throw new InvalidOperationException("unreachable");
            }
        }

        private HttpResponseMessage BuildResponse(HttpContent? content)
        {
            var response = new HttpResponseMessage(_status);

            // 304 forbids a body per RFC 7232 — keep Content null so
            // .NET's HttpClient does not surface an EOF stream the fetcher
            // would treat as a 0-byte read.
            if (content is not null && _status != HttpStatusCode.NotModified)
            {
                response.Content = content;
            }
            else
            {
                content?.Dispose();
            }

            // Header routing: Content-Type goes on Content; everything else
            // (ETag, ...) on the response. HttpClient is strict about which
            // headers live where.
            foreach (var kv in _headers)
            {
                if (string.Equals(kv.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
                {
                    response.Content?.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                }
                else
                {
                    response.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                }
            }

            return response;
        }
    }

    /// <summary>
    /// A read-only <see cref="Stream"/> that yields a short prefix of the
    /// supplied bytes, then throws <see cref="IOException"/> to simulate a
    /// connection dropped mid-response. Drives the fetcher's body-read
    /// failure path (close-mid-response behaviour, #490).
    /// </summary>
    private sealed class ThrowingStream : Stream
    {
        private readonly byte[] _prefix;
        private int _position;

        public ThrowingStream(byte[] source)
        {
            // Emit at most a handful of bytes (a partial body) before the
            // socket "drops". Mirrors sdk-go promising 4096 bytes then
            // writing a partial `{"p":{"s":"partial` fragment.
            var take = Math.Min(source.Length, 8);
            _prefix = new byte[take];
            Array.Copy(source, _prefix, take);
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_position < _prefix.Length)
            {
                var n = Math.Min(count, _prefix.Length - _position);
                Array.Copy(_prefix, _position, buffer, offset, n);
                _position += n;
                return n;
            }

            // Prefix exhausted — simulate the socket dropping mid-body.
            throw new IOException("connection reset by peer (simulated mid-response close)");
        }

        // Override the memory-based ReadAsync (CA1844) — this is the overload
        // HttpClient's body read actually invokes; the base array-based
        // ReadAsync delegates here.
        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            if (_position < _prefix.Length)
            {
                var n = Math.Min(buffer.Length, _prefix.Length - _position);
                _prefix.AsSpan(_position, n).CopyTo(buffer.Span);
                _position += n;
                return new ValueTask<int>(n);
            }

            // Prefix exhausted — simulate the socket dropping mid-body.
            throw new IOException("connection reset by peer (simulated mid-response close)");
        }

        public override void Flush() => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();
    }
}
