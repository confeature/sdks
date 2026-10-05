// SPDX-License-Identifier: MIT

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using FluentAssertions;
using RichardSzalay.MockHttp;
using Xunit;

namespace Confeature.Client.Tests.Internal;

/// <summary>
/// Unit tests for <see cref="ConfigFetcher"/>. Verifies the HTTP
/// fetcher's status-code routing, ETag round-trip, timeout + network
/// error handling, and SDK key redaction in every error message.
/// </summary>
public class ConfigFetcherTests
{
    private const string TestSdkKey = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private const string TestBaseUrl = "https://cdn.test.confeature.io";

    [Fact]
    public async Task FetchAsync_returns_Fetched_on_200_with_valid_JSON()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*")
            .Respond("application/json", "{\"f\":{}}");
        using var httpClient = new HttpClient(mockHttp);

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromSeconds(10), new CapturingLogger());

        var result = await fetcher.FetchAsync(previousETag: null, CancellationToken.None);

        result.Status.Should().Be(FetchStatus.Fetched);
        result.RawBody.Should().Be("{\"f\":{}}");
    }

    [Fact]
    public async Task FetchAsync_returns_NotModified_on_304()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*")
            .WithHeaders("If-None-Match", "\"abc\"")
            .Respond(HttpStatusCode.NotModified);
        using var httpClient = new HttpClient(mockHttp);

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromSeconds(10), new CapturingLogger());

        var result = await fetcher.FetchAsync("\"abc\"", CancellationToken.None);

        result.Status.Should().Be(FetchStatus.NotModified);
    }

    [Fact]
    public async Task FetchAsync_returns_Failed_on_500_with_redacted_log()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond(HttpStatusCode.InternalServerError);
        using var httpClient = new HttpClient(mockHttp);
        var logger = new CapturingLogger();

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromSeconds(10), logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().Contain("500");
        logger.AllMessages.Should().NotBeEmpty();
        foreach (var msg in logger.AllRendered)
        {
            msg.Should().NotContain(TestSdkKey, because: "SDK key MUST never appear in logs (FR-021)");
        }
    }

    [Fact]
    public async Task FetchAsync_returns_Failed_on_malformed_JSON_with_redacted_log()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Respond("application/json", "<not-json>");
        using var httpClient = new HttpClient(mockHttp);
        var logger = new CapturingLogger();

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromSeconds(10), logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().Be("MALFORMED_JSON");
        foreach (var msg in logger.AllRendered)
        {
            msg.Should().NotContain(TestSdkKey);
        }
    }

    [Fact]
    public async Task FetchAsync_returns_Failed_on_network_error_with_redacted_log()
    {
        var mockHttp = new MockHttpMessageHandler();
        mockHttp.When("*").Throw(new HttpRequestException("connection refused"));
        using var httpClient = new HttpClient(mockHttp);
        var logger = new CapturingLogger();

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromSeconds(10), logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().Be("NETWORK_ERROR");
        foreach (var msg in logger.AllRendered)
        {
            msg.Should().NotContain(TestSdkKey);
        }
    }

    [Fact]
    public async Task FetchAsync_returns_Failed_with_CANCELLED_on_token_cancellation()
    {
        var mockHttp = new MockHttpMessageHandler();
        // Hang the response so cancellation can win the race.
        mockHttp.When("*").Respond(async () =>
        {
            await Task.Delay(TimeSpan.FromMinutes(1));
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        using var httpClient = new HttpClient(mockHttp);

        using var fetcher = new ConfigFetcher(
            httpClient, TestBaseUrl, TestSdkKey, "0.1.0",
            TimeSpan.FromMinutes(1), new CapturingLogger());

        using var cts = new CancellationTokenSource();
        var fetchTask = fetcher.FetchAsync(null, cts.Token);
        cts.Cancel();

        var result = await fetchTask;
        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().Be("CANCELLED");
    }

    private const string ConfigCatShapedKey = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d";

    private static ConfigFetcher NewFetcher(string sdkKey, HttpClient? httpClient = null, CapturingLogger? logger = null)
        => new(
            httpClient: httpClient,
            baseUrl: TestBaseUrl,
            sdkKey: sdkKey,
            version: "0.1.0",
            timeout: TimeSpan.FromSeconds(10),
            logger: logger ?? new CapturingLogger());

    [Fact]
    public void Url_for_legacy_key_carries_the_raw_key()
    {
        // #803 FR-001: ConfigCat's path, the key's exact bytes — the CDN
        // has no /v2/ route and never sees a hash of the key.
        using var fetcher = NewFetcher(TestSdkKey);

        fetcher.Url.Should().NotBeNull();
        fetcher.Url!.Host.Should().Be("cdn.test.confeature.io");
        fetcher.Url.AbsolutePath.Should().Be("/configuration-files/" + TestSdkKey + "/config_v6.json");
    }

    [Fact]
    public void Url_for_configcat_shaped_key_carries_the_raw_key_across_three_segments()
    {
        // ConfigCat.Client 9.5.0 GetConfigUri: "configuration-files/" + sdkKey
        // + "/config_v6.json" — the key's `/` travels raw, as three segments.
        using var fetcher = NewFetcher(ConfigCatShapedKey);

        fetcher.Url.Should().NotBeNull();
        fetcher.Url!.AbsolutePath.Should().Be(
            "/configuration-files/configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json");
        fetcher.Url.Segments.Should().HaveCount(6, because: "/, configuration-files/, 3 key parts, config_v6.json");
    }

    [Theory]
    [InlineData("not a/valid?key#x", "not%20a%2Fvalid%3Fkey%23x")]
    [InlineData("configcat-sdk-1/FAKEfixtureKeyNotRe05/FAKEfixtureKeyNotRea06", "configcat-sdk-1%2FFAKEfixtureKeyNotRe05%2FFAKEfixtureKeyNotRea06")]
    [InlineData("a/../b", "a%2F..%2Fb")]
    [InlineData("100%;,$&+:=@~", "100%25%3B%2C$&+:=@~")]
    [InlineData("...", "...")]
    public void Url_for_malformed_key_is_one_escaped_segment(string sdkKey, string expectedSegment)
    {
        // FR-001: a key failing the shape check is escaped into ONE segment,
        // byte-identical to Go's url.PathEscape.
        using var fetcher = NewFetcher(sdkKey);

        fetcher.Url.Should().NotBeNull();
        fetcher.Url!.AbsolutePath.Should().Be("/configuration-files/" + expectedSegment + "/config_v6.json");
        fetcher.Url.Segments.Should().HaveCount(4, because: "the malformed key stays in one segment");
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    public async Task FetchAsync_refuses_a_key_with_no_path_segment(string sdkKey)
    {
        // FR-001: "", "." and ".." would become a dot-segment the URL parser
        // collapses — the fetcher refuses rather than request another resource.
        var mockHttp = new MockHttpMessageHandler();
        var request = mockHttp.When("*").Respond("application/json", "{\"f\":{}}");
        using var httpClient = new HttpClient(mockHttp);
        var logger = new CapturingLogger();
        using var fetcher = NewFetcher(sdkKey, httpClient, logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        fetcher.Url.Should().BeNull();
        mockHttp.GetMatchCount(request).Should().Be(0, because: "no request may be issued");
        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().Be("INVALID_SDK_KEY");
        logger.MessagesAt(LogLevel.Error).Should().ContainSingle(m => m.Contains("INVALID_SDK_KEY"));
    }

    /// <summary>
    /// FR-002 / FR-004: the key now travels in the URL, and a transport
    /// exception's message may quote that URL (a customer-supplied
    /// HttpClient can carry any handler). Every scenario here quotes the
    /// request URL in its exception message on purpose; the key — and
    /// each 22-character part — must still reach no log line and not the
    /// fetch result's error.
    /// </summary>
    [Theory]
    [InlineData("timeout")]
    [InlineData("timeout-quoting-url")]
    [InlineData("mid-body-reset")]
    [InlineData("redirect-loop-quoting-url")]
    [InlineData("unexpected-exception-quoting-url")]
    public async Task Forced_failures_never_leak_the_key(string scenario)
    {
        var logger = new CapturingLogger();
        using var handler = new UrlQuotingFailureHandler(scenario);
        using var httpClient = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(100) };
        using var fetcher = NewFetcher(ConfigCatShapedKey, httpClient, logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        handler.RequestedPath.Should().Be(
            "/configuration-files/" + ConfigCatShapedKey + "/config_v6.json",
            because: "the scenario must actually carry the key in the URL");
        result.Status.Should().Be(FetchStatus.Failed);
        result.Error.Should().BeOneOf("TIMEOUT", "NETWORK_ERROR");
        AssertKeyFree(ConfigCatShapedKey, logger, result.Error);
    }

    [Fact]
    public async Task Real_redirect_loop_never_leaks_the_key()
    {
        // A real loopback server answering every request with a 302 back to
        // itself, behind the default SocketsHttpHandler (which follows up to
        // 50 redirects, then hands back the last 3xx). The Location header
        // carries the key; nothing of it may surface.
        using var server = new RedirectLoopServer();
        var logger = new CapturingLogger();
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var fetcher = new ConfigFetcher(
            httpClient, server.BaseUrl, ConfigCatShapedKey, "0.1.0", TimeSpan.FromSeconds(10), logger);

        var result = await fetcher.FetchAsync(null, CancellationToken.None);

        server.RequestCount.Should().BeGreaterThan(1, because: "the client must have followed the loop");
        server.FirstRequestPath.Should().Be("/configuration-files/" + ConfigCatShapedKey + "/config_v6.json");
        result.Status.Should().Be(FetchStatus.Failed);
        AssertKeyFree(ConfigCatShapedKey, logger, result.Error);
    }

    [Fact]
    public void CapturingLogger_renders_the_whole_exception_chain()
    {
        // The key-free assertion is only as strong as what the test logger
        // renders: a real logger prints the exception and its causes.
        var logger = new CapturingLogger();
        var deepest = new IOException("deepest-cause");
        var aggregate = new AggregateException("aggregate", new TimeoutException("aggregated-cause"), deepest);
        logger.Error("msg", new HttpRequestException("outer", new InvalidOperationException("middle", aggregate)));

        var rendered = string.Join("\n", logger.AllRendered);
        foreach (var marker in new[] { "msg", "outer", "middle", "aggregated-cause", "deepest-cause" })
        {
            rendered.Should().Contain(marker);
        }
    }

    private static void AssertKeyFree(string sdkKey, CapturingLogger logger, string error)
    {
        var secrets = new[] { sdkKey, Uri.EscapeDataString(sdkKey) }
            .Concat(sdkKey.Split('/').Where(part => part.Length == 22))
            .ToList();
        secrets.Should().HaveCount(4, because: "the full key, its escaped form and both 22-character parts");

        logger.AllMessages.Should().NotBeEmpty();

        // Everything a real logger would print: the messages AND every
        // logged exception's Message + ToString() over its whole cause
        // chain. A handler exception here always quotes the URL, so
        // `_logger.Error(msg, ex)` must fail this assertion.
        var rendered = logger.AllRendered;
        foreach (var secret in secrets)
        {
            error.Should().NotContain(secret, because: "FetchResult.Error must be key-free (FR-002)");
            foreach (var text in rendered)
            {
                text.Should().NotContain(secret, because: "nothing a logger prints may carry the key (FR-021)");
            }
        }
    }

    /// <summary>
    /// Handler whose every failure quotes the request URL — the worst a
    /// customer-supplied handler may do.
    /// </summary>
    private sealed class UrlQuotingFailureHandler : HttpMessageHandler
    {
        private readonly string _scenario;

        public UrlQuotingFailureHandler(string scenario) => _scenario = scenario;

        public string? RequestedPath { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            RequestedPath = uri.AbsolutePath;
            var quoted = "GET " + uri.OriginalString + " (" + Uri.UnescapeDataString(uri.AbsoluteUri) + ")";
            switch (_scenario)
            {
                case "timeout":
                    // Hang until HttpClient.Timeout cancels the linked token.
                    await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
                    throw new InvalidOperationException("unreachable");
                case "timeout-quoting-url":
                    throw new TaskCanceledException("timed out: " + quoted, new TimeoutException(quoted));
                case "mid-body-reset":
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StreamContent(new ResettingStream(quoted)),
                    };
                case "redirect-loop-quoting-url":
                    throw new HttpRequestException("too many redirects: " + quoted);
                case "unexpected-exception-quoting-url":
                    throw new InvalidOperationException("handler bug: " + quoted);
                default:
                    throw new InvalidOperationException("unknown scenario " + _scenario);
            }
        }
    }

    /// <summary>A body stream that yields a partial body, then resets quoting the URL.</summary>
    private sealed class ResettingStream : Stream
    {
        private readonly string _quoted;
        private readonly byte[] _prefix = Encoding.UTF8.GetBytes("{\"f\":{");
        private int _position;

        public ResettingStream(string quoted) => _quoted = quoted;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            if (_position < _prefix.Length)
            {
                var n = Math.Min(buffer.Length, _prefix.Length - _position);
                _prefix.AsSpan(_position, n).CopyTo(buffer);
                _position += n;
                return n;
            }

            // Not an IOException: HttpContent wraps those in a generic
            // message, which would hide a leak. A handler-level exception
            // propagates unwrapped, message and all.
            throw new HttpRequestException("connection reset reading " + _quoted, new IOException(_quoted));
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => new(Read(buffer.Span));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => Task.FromResult(Read(buffer.AsSpan(offset, count)));

        public override void Flush() => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>
    /// Minimal HTTP/1.1 loopback server: every request gets a 302 whose
    /// Location is the request's own path, then the connection closes.
    /// </summary>
    private sealed class RedirectLoopServer : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _cts = new();
        private int _requestCount;
        private string? _firstRequestPath;

        public RedirectLoopServer()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            var port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            BaseUrl = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
            _ = Task.Run(AcceptLoopAsync);
        }

        public string BaseUrl { get; }

        public int RequestCount => Volatile.Read(ref _requestCount);

        public string? FirstRequestPath => Volatile.Read(ref _firstRequestPath);

        public void Dispose()
        {
            _cts.Cancel();
            _listener.Stop();
            _cts.Dispose();
        }

        private async Task AcceptLoopAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(_cts.Token).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException)
                {
                    return;
                }

                _ = Task.Run(() => ServeAsync(client));
            }
        }

        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
                var requestLine = await reader.ReadLineAsync().ConfigureAwait(false);
                if (string.IsNullOrEmpty(requestLine))
                {
                    return;
                }

                string? header;
                do
                {
                    header = await reader.ReadLineAsync().ConfigureAwait(false);
                }
                while (!string.IsNullOrEmpty(header));

                var path = requestLine.Split(' ')[1];
                Interlocked.CompareExchange(ref _firstRequestPath, path, null);
                Interlocked.Increment(ref _requestCount);

                var response = "HTTP/1.1 302 Found\r\nLocation: " + path
                    + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                var bytes = Encoding.ASCII.GetBytes(response);
                await stream.WriteAsync(bytes).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
            }
        }
    }

    [Fact]
    public void Owns_HttpClient_when_constructed_without_one()
    {
        using var fetcher = new ConfigFetcher(
            httpClient: null,
            baseUrl: TestBaseUrl,
            sdkKey: TestSdkKey,
            version: "0.1.0",
            timeout: TimeSpan.FromSeconds(10),
            logger: new CapturingLogger());

        fetcher.OwnsHttpClient.Should().BeTrue();
    }

    [Fact]
    public void Does_not_own_customer_supplied_HttpClient()
    {
        using var httpClient = new HttpClient();
        using var fetcher = new ConfigFetcher(
            httpClient: httpClient,
            baseUrl: TestBaseUrl,
            sdkKey: TestSdkKey,
            version: "0.1.0",
            timeout: TimeSpan.FromSeconds(10),
            logger: new CapturingLogger());

        fetcher.OwnsHttpClient.Should().BeFalse();
    }
}
