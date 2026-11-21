// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client;
using OpenFeature;
using OpenFeature.Constant;
using OpenFeature.Model;
using Xunit;

namespace Confeature.OpenFeature.Tests;

public sealed class ProviderIntegrationTests : IAsyncLifetime
{
    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        Api.Instance.SetContext(EvaluationContext.Empty);
        await Api.Instance.ShutdownAsync();
    }

    [Fact]
    public async Task Manual_poll_preserves_scalar_types_and_classifies_errors()
    {
        await using var fixture = new LoopbackConfig();
        using var native = fixture.CreateClient(PollingMode.ManualPoll());
        var open = await RegisterAsync(native);

        var cold = await open.GetBooleanDetailsAsync("enabled", false);
        AssertFailure(cold, false, ErrorType.ProviderNotReady);
        fixture.AssertTraffic(0);

        Assert.True((await native.ForceRefreshAsync(CancellationToken.None)).IsSuccess);
        var evaluated = 0;
        native.FlagEvaluated += (_, _) => Interlocked.Increment(ref evaluated);
        var enabled = await open.GetBooleanDetailsAsync("enabled", true);
        Assert.True(enabled.Value);
        Assert.Equal("on", enabled.Variant);
        Assert.Equal(ErrorType.None, enabled.ErrorType);
        Assert.Null(enabled.ErrorMessage);

        Assert.Equal("{\"show\":true}", await open.GetStringValueAsync("text", "fallback"));
        Assert.Equal(7, await open.GetIntegerValueAsync("integer", -1));
        Assert.Equal(1.5, await open.GetDoubleValueAsync("double", -1));
        AssertFailure(await open.GetDoubleDetailsAsync("integer", -2), -2, ErrorType.TypeMismatch);
        AssertFailure(await open.GetBooleanDetailsAsync("missing", true), true, ErrorType.FlagNotFound);
        AssertFailure(await open.GetBooleanDetailsAsync("malformed", false), false, ErrorType.ParseError);

        var fallback = new Value("caller-default");
        AssertFailure(await open.GetObjectDetailsAsync("text", fallback), fallback, ErrorType.TypeMismatch);
        Assert.Equal(7, Volatile.Read(ref evaluated));
        fixture.AssertTraffic(1);
    }

    [Fact]
    public async Task Merged_context_preserves_supported_attributes_and_uses_only_the_targeting_key_for_identity()
    {
        await using var fixture = new LoopbackConfig();
        using var native = fixture.CreateClient(PollingMode.ManualPoll());
        Assert.True((await native.ForceRefreshAsync(CancellationToken.None)).IsSuccess);
        Api.Instance.SetContext(EvaluationContext.Builder().Set("plan", "beta").Build());
        var open = await RegisterAsync(native);

        var anonymous = EvaluationContext.Builder().Set("Identifier", "spoofed").Build();
        var identified = EvaluationContext.Builder().SetTargetingKey("fixture-user").Build();
        var control = EvaluationContext.Builder().Set("plan", "control").Build();

        var targeted = await open.GetBooleanDetailsAsync("targeted", false, anonymous);
        Assert.True(targeted.Value);
        Assert.Equal(Reason.TargetingMatch, targeted.Reason);
        Assert.Equal("beta", targeted.Variant);
        Assert.False(await open.GetBooleanValueAsync("targeted", true, control));
        Assert.False(await open.GetBooleanValueAsync("rollout", true, anonymous));

        var split = await open.GetBooleanDetailsAsync("rollout", false, identified);
        Assert.True(split.Value);
        Assert.Equal(Reason.Split, split.Reason);
        Assert.Equal("split", split.Variant);

        var typed = EvaluationContext.Builder().Set("score", 12.5).Set("member", true)
            .Set("teams", new Value(new Value[] { new("red"), new("blue") }))
            .Set("joined", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)).Build();
        Assert.True(await open.GetBooleanValueAsync("typed", false, typed));
        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(index =>
            open.GetBooleanValueAsync("rollout", false, index % 2 == 0 ? identified : anonymous)));
        Assert.Equal(10, results.Count(value => value));
        fixture.AssertTraffic(1);
    }

    [Fact]
    public async Task A_missing_identifier_and_an_explicit_empty_identifier_stay_distinct()
    {
        await using var fixture = new LoopbackConfig();
        using var native = fixture.CreateClient(PollingMode.ManualPoll());
        Assert.True((await native.ForceRefreshAsync(CancellationToken.None)).IsSuccess);
        var open = await RegisterAsync(native);

        Assert.True(native.GetValue("rollout-all", false));
        var anonymous = await open.GetBooleanDetailsAsync("rollout-all", true);
        Assert.False(anonymous.Value);
        Assert.Equal("default", anonymous.Variant);
        var empty = EvaluationContext.Builder().SetTargetingKey(string.Empty).Build();
        var assigned = await open.GetBooleanDetailsAsync("rollout-all", false, empty);
        Assert.True(assigned.Value);
        Assert.Equal("split-all", assigned.Variant);

        var custom = EvaluationContext.Builder().Set("plan", "beta").Build();
        var explicitAttribute = await open.GetBooleanDetailsAsync("rollout-custom", false, custom);
        Assert.True(explicitAttribute.Value);
        Assert.Equal("split-custom", explicitAttribute.Variant);
        Assert.False(await open.GetBooleanValueAsync("rollout-custom", true));
        fixture.AssertTraffic(1);
    }

    [Fact]
    public async Task Auto_polling_is_owned_by_the_sdk_and_the_client_survives_provider_shutdown()
    {
        await using var fixture = new LoopbackConfig();
        using var native = fixture.CreateClient(PollingMode.AutoPoll(TimeSpan.FromMinutes(5)));
        Assert.Equal(0, CountSdkEventSubscribers(native));
        var open = await RegisterAsync(native);

        Assert.True(await open.GetBooleanValueAsync("enabled", false));
        native.SetOffline();
        Assert.True(await open.GetBooleanValueAsync("enabled", false));
        Assert.Equal(0, CountSdkEventSubscribers(native));
        await Api.Instance.ShutdownAsync();
        Assert.True((await native.GetValueDetailsAsync("enabled", false)).Value);
        Assert.Equal(0, CountSdkEventSubscribers(native));
        fixture.AssertTraffic(1);
    }

    [Fact]
    public async Task Lazy_load_uses_offline_cache_and_refreshes_the_expired_value_when_back_online()
    {
        await using var fixture = new LoopbackConfig(refreshedConfig: ProviderConfig.RefreshedJson);
        var expiry = TimeSpan.FromMilliseconds(40);
        using var native = fixture.CreateClient(PollingMode.LazyLoad(expiry));
        native.SetOffline();
        var open = await RegisterAsync(native);

        AssertFailure(await open.GetBooleanDetailsAsync("enabled", false), false, ErrorType.ProviderNotReady);
        fixture.AssertTraffic(0);
        native.SetOnline();
        Assert.True(await open.GetBooleanValueAsync("enabled", false));
        fixture.AssertTraffic(1);
        native.SetOffline();

        await Task.Delay(expiry + expiry);
        Assert.True(await open.GetBooleanValueAsync("enabled", false));
        fixture.AssertTraffic(1);
        native.SetOnline();
        var refreshed = await open.GetBooleanDetailsAsync("enabled", true);
        Assert.False(refreshed.Value);
        Assert.Equal("refreshed", refreshed.Variant);
        fixture.AssertTraffic(2);
    }

    [Fact]
    public async Task Cancellation_during_lazy_fetch_returns_the_fallback_without_notifying_native_hooks()
    {
        await using var fixture = new LoopbackConfig(delayResponse: true);
        using var native = fixture.CreateClient(PollingMode.LazyLoad());
        var open = await RegisterAsync(native);
        var evaluated = 0;
        native.FlagEvaluated += (_, _) => Interlocked.Increment(ref evaluated);
        using var token = new CancellationTokenSource();
        var requested = open.GetBooleanDetailsAsync("enabled", false, cancellationToken: token.Token);
        await fixture.FirstRequest;
        await token.CancelAsync();

        var cancelled = await requested.WaitAsync(TimeSpan.FromSeconds(5));
        AssertFailure(cancelled, false, ErrorType.General);
        Assert.Equal("The Confeature evaluation was cancelled.", cancelled.ErrorMessage);
        Assert.Equal(0, Volatile.Read(ref evaluated));
        fixture.AssertTraffic(1);
    }

    [Fact]
    public async Task Local_only_preserves_targeting_without_network_access()
    {
        await using var fixture = new LoopbackConfig();
        using var config = JsonDocument.Parse(ProviderConfig.Json);
        using var native = fixture.CreateClient(PollingMode.ManualPoll(), options =>
            options.FlagOverrides = FlagOverrides.LocalConfig(config.RootElement, OverrideBehaviour.LocalOnly));
        var open = await RegisterAsync(native);
        var context = EvaluationContext.Builder().Set("plan", "beta").Build();

        Assert.True(await open.GetBooleanValueAsync("targeted", false, context));
        Assert.False(await open.GetBooleanValueAsync("targeted", true));
        fixture.AssertTraffic(0);
    }

    [Fact]
    public async Task Opaque_sdk_exceptions_reach_the_official_error_hook_as_fixed_diagnostics()
    {
        await using var fixture = new LoopbackConfig();
        using var native = fixture.CreateClient(PollingMode.ManualPoll(), options =>
            options.FlagOverrides = new FlagOverrides(new ThrowingOverrides(), OverrideBehaviour.LocalOnly));
        var open = await RegisterAsync(native);
        var hook = new RecordingErrorHook();
        open.AddHooks(hook);

        var result = await open.GetBooleanDetailsAsync("enabled", true);

        AssertFailure(result, true, ErrorType.General);
        Assert.Equal("The Confeature evaluation failed.", result.ErrorMessage);
        Assert.Equal(result.ErrorMessage, Assert.Single(hook.Messages));
        fixture.AssertTraffic(0);
    }

    private static async Task<FeatureClient> RegisterAsync(ConfeatureClient native)
    {
        await Api.Instance.SetProviderAsync(new ConfeatureProvider(native));
        return Api.Instance.GetClient();
    }

    private static int CountSdkEventSubscribers(ConfeatureClient native)
    {
        var type = typeof(ConfeatureClient);
        var events = type.GetEvents();
        Assert.NotEmpty(events);
        var subscribers = 0;
        foreach (var eventInfo in events)
        {
            var field = type.GetField(eventInfo.Name, BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.NotNull(field);
            subscribers += (field.GetValue(native) as Delegate)?.GetInvocationList().Length ?? 0;
        }

        return subscribers;
    }

    private static void AssertFailure<T>(FlagEvaluationDetails<T> details, T fallback, ErrorType type)
    {
        Assert.Equal(fallback, details.Value);
        Assert.Equal(type, details.ErrorType);
        Assert.Equal(Reason.Error, details.Reason);
        Assert.True(string.IsNullOrEmpty(details.Variant));
        Assert.False(string.IsNullOrWhiteSpace(details.ErrorMessage));
    }

    private sealed class ThrowingOverrides : IOverrideDataSource
    {
        public IReadOnlyDictionary<string, SettingValue>? GetOverridesSync() =>
            throw new InvalidOperationException("Synthetic secret or SDK diagnostic.");

        public Task<IReadOnlyDictionary<string, SettingValue>> GetOverridesAsync(
            CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("Synthetic secret or SDK diagnostic.");
    }

    private sealed class RecordingErrorHook : Hook
    {
        public List<string> Messages { get; } = [];

        public override ValueTask ErrorAsync<T>(
            HookContext<T> context, Exception error, IReadOnlyDictionary<string, object>? hints = null,
            CancellationToken cancellationToken = default)
        {
            Messages.Add(error.Message);
            return ValueTask.CompletedTask;
        }
    }
}
