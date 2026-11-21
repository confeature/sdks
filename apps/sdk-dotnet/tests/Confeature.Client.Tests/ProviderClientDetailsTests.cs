// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;
using FluentAssertions;
using Xunit;

namespace Confeature.Client.Tests;

public class ProviderClientDetailsTests
{
    private const string TestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public async Task Provider_client_hooks_omit_user_and_keep_sibling_handlers_after_a_failure()
    {
        using var client = CreateLocalClient(new RejectingLogger());
        var evaluations = new List<EvaluationDetails<bool>>();
        client.FlagEvaluated += (_, _) => throw new InvalidOperationException("synthetic hook failure");
        client.FlagEvaluated += (_, args) => evaluations.Add((EvaluationDetails<bool>)args.EvaluationDetails);

        var (details, status) = await client.GetProviderValueDetailsAsync("flag", false, null);

        status.Should().Be(EvaluationError.None);
        details.Value.Should().BeTrue();
        evaluations.Should().ContainSingle().Which.User.Should().BeNull();
    }

    [Fact]
    public async Task Provider_client_reports_cancellation_and_closure_without_evaluating()
    {
        using var client = CreateLocalClient();
        var evaluations = 0;
        client.FlagEvaluated += (_, _) => evaluations++;
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();

        var result = await client.GetProviderValueDetailsAsync("flag", false, null, canceled.Token);
        result.Error.Should().Be(EvaluationError.Cancelled);
        result.Details.Value.Should().BeFalse();
        evaluations.Should().Be(0);

        var native = await client.GetValueDetailsAsync("flag", false, cancellationToken: canceled.Token);
        native.Value.Should().BeTrue();
        native.User!.Identifier.Should().Be("configured");
        evaluations.Should().Be(1);

        client.Dispose();
        var closed = await client.GetProviderValueDetailsAsync("flag", false, null);
        closed.Error.Should().Be(EvaluationError.ClientClosed);
        closed.Details.IsDefaultValue.Should().BeTrue();
        evaluations.Should().Be(1);
    }

    [Fact]
    public async Task Provider_client_forwards_cancellation_during_lazy_refresh()
    {
        using var handler = new PendingResponseHandler();
        using var http = new HttpClient(handler);
        using var client = new ConfeatureClient(TestSdkKey, options =>
        {
            options.HttpClient = http;
            options.BaseUrl = "http://127.0.0.1:9";
            options.PollingMode = PollingMode.LazyLoad();
            options.CacheDirectory = ":memory:";
        });
        var evaluations = 0;
        client.FlagEvaluated += (_, _) => evaluations++;
        using var caller = new CancellationTokenSource();

        var pending = client.GetProviderValueDetailsAsync("flag", false, null, caller.Token);
        var bound = TimeSpan.FromSeconds(5);
        await handler.Started.Task.WaitAsync(bound);
        caller.Cancel();
        var result = await pending.WaitAsync(bound);

        handler.ReceivedToken.IsCancellationRequested.Should().BeTrue();
        result.Error.Should().Be(EvaluationError.Cancelled);
        result.Details.Value.Should().BeFalse();
        evaluations.Should().Be(0);
    }

    private static ConfeatureClient CreateLocalClient(IConfeatureLogger? logger = null) =>
        new(TestSdkKey, options =>
        {
            options.FlagOverrides = new FlagOverrides(
                new MapOverrideDataSource(new Dictionary<string, object> { ["flag"] = true }),
                OverrideBehaviour.LocalOnly);
            options.PollingMode = PollingMode.ManualPoll();
            options.CacheDirectory = ":memory:";
            options.DefaultUser = new User("configured");
            options.Logger = logger;
        });

    private sealed class RejectingLogger : IConfeatureLogger
    {
        public LogLevel LogLevel { get; set; }

        public bool IsEnabled(LogLevel level) => true;

        public void Error(string message, Exception? exception = null) => throw new InvalidOperationException(message);

        public void Warning(string message) { }

        public void Info(string message) { }

        public void Debug(string message) { }
    }

    private sealed class PendingResponseHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<HttpResponseMessage> _response =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public CancellationToken ReceivedToken { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            ReceivedToken = cancellationToken;
            Started.SetResult();
            return _response.Task.WaitAsync(cancellationToken);
        }
    }
}
