// SPDX-License-Identifier: MIT

using System;
using System.Threading;
using System.Threading.Tasks;
using Confeature.Client.Internal;

namespace Confeature.Client;

public sealed partial class ConfeatureClient
{
    /// <summary>
    /// Resolves <paramref name="key"/> and wraps the outcome in an
    /// <see cref="EvaluationDetails{T}"/> envelope (spec 083 / #266).
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetValueDetails&lt;T&gt;</c>
    /// 1:1 — same name, arity, generic constraint, and closed-client semantics.
    /// Synchronous wrapper around <see cref="GetValueDetailsAsync{T}(string, T, User?, CancellationToken)"/>.
    /// Closed clients return <c>IsDefaultValue=true</c> + <c>ErrorMessage="CLIENT_CLOSED"</c>.
    /// </remarks>
    public EvaluationDetails<T> GetValueDetails<T>(string key, T defaultValue, User? user = null) =>
        GetValueDetailsAsync(key, defaultValue, user, CancellationToken.None).GetAwaiter().GetResult();

    /// <summary>
    /// Async variant of <see cref="GetValueDetails{T}(string, T, User?)"/>.
    /// </summary>
    /// <remarks>
    /// Mirrors upstream <c>ConfigCat.Client.ConfigCatClient.GetValueDetailsAsync&lt;T&gt;</c>
    /// 1:1. Triggers the LazyLoad staleness-driven fetch hook before delegating
    /// to a fresh snapshot.
    /// </remarks>
    public Task<EvaluationDetails<T>> GetValueDetailsAsync<T>(
        string key,
        T defaultValue,
        User? user = null,
        CancellationToken cancellationToken = default) =>
        GetValueDetailsCoreAsync<T, EvaluationDetails<T>>(
            key, defaultValue, user, null, false, static result => result.Details, cancellationToken);

    internal Task<(EvaluationDetails<T> Details, EvaluationError Error)> GetProviderValueDetailsAsync<T>(
        string key,
        T defaultValue,
        IEvalUser? user,
        CancellationToken cancellationToken = default) =>
        GetValueDetailsCoreAsync<T, (EvaluationDetails<T>, EvaluationError)>(
            key, defaultValue, null, user, true, static result => result, cancellationToken);

    private async Task<TResult> GetValueDetailsCoreAsync<T, TResult>(
        string key,
        T defaultValue,
        User? nativeUser,
        IEvalUser? providerUser,
        bool useProviderContext,
        Func<(EvaluationDetails<T> Details, EvaluationError Error), TResult> selectOutcome,
        CancellationToken cancellationToken)
    {
        if (useProviderContext && cancellationToken.IsCancellationRequested)
        {
            return selectOutcome(CancelledDetails(key, defaultValue));
        }

        if (Volatile.Read(ref _disposed) == 1)
        {
            var user = useProviderContext ? null : nativeUser ?? _defaultUser;
            return selectOutcome((
                DefaultDetails(key, defaultValue, user, "CLIENT_CLOSED"), EvaluationError.ClientClosed));
        }

        try
        {
            await _pollService.MaybeFetchForGetValueAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Native callers can still read the cache after a canceled refresh.
        }

        if (useProviderContext && cancellationToken.IsCancellationRequested)
        {
            return selectOutcome(CancelledDetails(key, defaultValue));
        }

        return selectOutcome(ReadAndNotifyDetails(
            key, defaultValue, nativeUser, providerUser, useProviderContext, cancellationToken));
    }

    private (EvaluationDetails<T> Details, EvaluationError Error) ReadAndNotifyDetails<T>(
        string key,
        T defaultValue,
        User? nativeUser,
        IEvalUser? providerUser,
        bool useProviderContext,
        CancellationToken cancellationToken)
    {
        var snapshot = Snapshot();
        var result = useProviderContext
            ? snapshot.GetProviderValueDetails(key, defaultValue, providerUser)
            : snapshot.GetNativeValueDetails(key, defaultValue, nativeUser);

        if (useProviderContext && cancellationToken.IsCancellationRequested)
        {
            return CancelledDetails(key, defaultValue);
        }

        RaiseFlagEvaluated(result.Details, sanitizeDiagnostics: useProviderContext);
        return result;
    }

    private static (EvaluationDetails<T> Details, EvaluationError Error) CancelledDetails<T>(
        string key,
        T defaultValue) =>
        (DefaultDetails(key, defaultValue, null, "CANCELLED"), EvaluationError.Cancelled);

    private static EvaluationDetails<T> DefaultDetails<T>(
        string key,
        T defaultValue,
        User? user,
        string diagnostic) =>
        new()
        {
            Key = key,
            Value = defaultValue,
            User = user,
            IsDefaultValue = true,
            ErrorMessage = diagnostic,
        };
}
