// SPDX-License-Identifier: MIT

using System;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client;
using Confeature.Client.Internal;
using OpenFeature;
using OpenFeature.Constant;
using OpenFeature.Model;

namespace Confeature.OpenFeature;

/// <summary>Adapts a caller-owned Confeature client to the OpenFeature provider API.</summary>
public sealed class ConfeatureProvider : FeatureProvider
{
    private static readonly Metadata ProviderMetadata = new("Confeature");
    private readonly ConfeatureClient _client;

    /// <summary>Creates a provider using the supplied client's polling and cache settings.</summary>
    /// <param name="client">The caller-owned client. The caller remains responsible for disposing it.</param>
    public ConfeatureProvider(ConfeatureClient client) =>
        _client = client ?? throw new ArgumentNullException(nameof(client));

    /// <inheritdoc />
    public override Metadata GetMetadata() => ProviderMetadata;

    /// <inheritdoc />
    public override Task<ResolutionDetails<bool>> ResolveBooleanValueAsync(
        string flagKey, bool defaultValue, EvaluationContext? context = null,
        CancellationToken cancellationToken = default) =>
        ResolveAsync(flagKey, defaultValue, context, cancellationToken);

    /// <inheritdoc />
    public override Task<ResolutionDetails<string>> ResolveStringValueAsync(
        string flagKey, string defaultValue, EvaluationContext? context = null,
        CancellationToken cancellationToken = default) =>
        ResolveAsync(flagKey, defaultValue, context, cancellationToken);

    /// <inheritdoc />
    public override Task<ResolutionDetails<int>> ResolveIntegerValueAsync(
        string flagKey, int defaultValue, EvaluationContext? context = null,
        CancellationToken cancellationToken = default) =>
        ResolveAsync(flagKey, defaultValue, context, cancellationToken);

    /// <inheritdoc />
    public override Task<ResolutionDetails<double>> ResolveDoubleValueAsync(
        string flagKey, double defaultValue, EvaluationContext? context = null,
        CancellationToken cancellationToken = default) =>
        ResolveAsync(flagKey, defaultValue, context, cancellationToken);

    /// <inheritdoc />
    public override Task<ResolutionDetails<Value>> ResolveStructureValueAsync(
        string flagKey, Value defaultValue, EvaluationContext? context = null,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(Failure(flagKey, defaultValue, EvaluationError.TypeMismatch));

    private async Task<ResolutionDetails<T>> ResolveAsync<T>(
        string flagKey, T fallback, EvaluationContext? context, CancellationToken cancellationToken)
    {
        try
        {
            var user = context is null || context.Count == 0 ? null : new OpenFeatureUser(context);
            var (details, error) = await _client.GetProviderValueDetailsAsync(
                flagKey, fallback, user, cancellationToken).ConfigureAwait(false);
            return error == EvaluationError.None && !details.IsDefaultValue
                ? Success(flagKey, details)
                : Failure(flagKey, fallback, error);
        }
        catch (Exception)
        {
            // Application-supplied SDK components can throw with sensitive values in their messages.
            return Failure(flagKey, fallback, EvaluationError.EvalException);
        }
    }

    private static ResolutionDetails<T> Success<T>(string flagKey, EvaluationDetails<T> details)
    {
        var reason = (details.MatchedPercentageOption, details.MatchedTargetingRule) switch
        {
            (not null, _) => Reason.Split,
            (_, not null) => Reason.TargetingMatch,
            _ => null,
        };
        return new ResolutionDetails<T>(flagKey, details.Value, reason: reason, variant: details.VariationId);
    }

    private static ResolutionDetails<T> Failure<T>(string flagKey, T fallback, EvaluationError error)
    {
        var (type, message) = error switch
        {
            EvaluationError.NoConfig or EvaluationError.ClientClosed =>
                (ErrorType.ProviderNotReady, "The Confeature provider is not ready."),
            EvaluationError.KeyNotFound =>
                (ErrorType.FlagNotFound, "The Confeature flag was not found."),
            EvaluationError.UnsupportedType or EvaluationError.TypeMismatch =>
                (ErrorType.TypeMismatch, "The Confeature flag type does not match."),
            EvaluationError.MalformedValue =>
                (ErrorType.ParseError, "The Confeature configuration could not be evaluated."),
            EvaluationError.Cancelled =>
                (ErrorType.General, "The Confeature evaluation was cancelled."),
            _ => (ErrorType.General, "The Confeature evaluation failed."),
        };
        return new ResolutionDetails<T>(flagKey, fallback, type, Reason.Error, errorMessage: message);
    }
}
