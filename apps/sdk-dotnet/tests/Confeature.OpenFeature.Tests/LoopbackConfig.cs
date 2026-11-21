// SPDX-License-Identifier: MIT

using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client;
using Xunit;

namespace Confeature.OpenFeature.Tests;

internal sealed class LoopbackConfig : IAsyncDisposable
{
    private const string Key =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(10);
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly TaskCompletionSource _firstRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _allowResponse = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly OriginGuard _guard;
    private readonly HttpClient _transport;
    private readonly Uri _expected;
    private readonly Task _server;
    private int _requests;

    public LoopbackConfig(bool delayResponse = false)
    {
        _listener.Start();
        var port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _expected = new Uri(FormattableString.Invariant(
            $"http://127.0.0.1:{port}/configuration-files/{Key}/config_v6.json"));
        _guard = new OriginGuard(_expected);
        _transport = new HttpClient(_guard) { Timeout = Deadline };
        if (!delayResponse)
        {
            _allowResponse.SetResult();
        }

        _server = ServeAsync(_shutdown.Token);
    }

    public Task FirstRequest => _firstRequest.Task.WaitAsync(Deadline);

    public ConfeatureClient CreateClient(PollingMode mode, Action<ConfeatureClientOptions>? configure = null) =>
        new(Key, options =>
    {
        options.BaseUrl = _expected.GetLeftPart(UriPartial.Authority);
        options.HttpClient = _transport;
        options.PollingMode = mode;
        options.CacheDirectory = ":memory:";
        options.DefaultUser = new User("native-default");
        configure?.Invoke(options);
    });

    public void AssertTraffic(int requests)
    {
        Assert.Equal(requests, Volatile.Read(ref _requests));
        Assert.Equal(0, _guard.BlockedRequests);
    }

    public async ValueTask DisposeAsync()
    {
        await _shutdown.CancelAsync();
        try
        {
            await _server;
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            // The fixture can be stopped while accepting a connection or holding a response.
        }
        finally
        {
            _listener.Stop();
            _transport.Dispose();
            _shutdown.Dispose();
        }
    }

    private async Task ServeAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            using var connection = await _listener.AcceptTcpClientAsync(cancellationToken);
            await using var stream = connection.GetStream();
            await ReceiveRequestAsync(stream, cancellationToken);
            await _allowResponse.Task.WaitAsync(cancellationToken);
            await WriteResponseAsync(stream, cancellationToken);
        }
    }

    private async Task ReceiveRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
        var request = await reader.ReadLineAsync(cancellationToken);
        Assert.Equal($"GET {_expected.PathAndQuery} HTTP/1.1", request);
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(cancellationToken)))
        {
        }

        Interlocked.Increment(ref _requests);
        _firstRequest.TrySetResult();
    }

    private static async Task WriteResponseAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        var body = Encoding.UTF8.GetBytes(ProviderConfig.Json);
        var size = body.Length.ToString(CultureInfo.InvariantCulture);
        var headers = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(headers, cancellationToken);
        await stream.WriteAsync(body, cancellationToken);
    }

    private sealed class OriginGuard(Uri expected) : DelegatingHandler(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
    })
    {
        private int _blocked;

        public int BlockedRequests => Volatile.Read(ref _blocked);

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method != HttpMethod.Get || request.RequestUri != expected)
            {
                Interlocked.Increment(ref _blocked);
                throw new InvalidOperationException("The provider fixture can reach only its loopback config URL.");
            }

            return base.SendAsync(request, cancellationToken);
        }
    }
}
