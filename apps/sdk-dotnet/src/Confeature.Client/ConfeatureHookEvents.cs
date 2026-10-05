// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client;

/// <summary>
/// Payload for the <see cref="ConfeatureClient.ConfigChanged"/> event.
/// </summary>
/// <remarks>
/// Mirrors upstream <c>ConfigCat.Client.ConfigChangedEventArgs</c> (Principle II, epic #268).
/// Fires after a successful <c>FetchStatus.Fetched</c> outcome that produced a new config.
/// </remarks>
public sealed class ConfigChangedEventArgs : EventArgs
{
    internal ConfigChangedEventArgs(object settings)
    {
        Settings = settings;
    }

    /// <summary>The freshly fetched settings map (boxed; upstream-aligned shape).</summary>
    public object Settings { get; }
}

/// <summary>
/// Payload for the <see cref="ConfeatureClient.ConfigFetched"/> event.
/// </summary>
/// <remarks>
/// Mirrors upstream <c>ConfigCat.Client.ConfigFetchedEventArgs</c>. Fires on every fetch
/// outcome (success or failure), regardless of whether the config actually changed.
/// </remarks>
public sealed class ConfigFetchedEventArgs : EventArgs
{
    internal ConfigFetchedEventArgs(bool isSuccess, string? errorMessage)
    {
        IsSuccess = isSuccess;
        ErrorMessage = errorMessage;
    }

    /// <summary>True when the fetch resolved to <c>Fetched</c> or <c>NotModified</c>.</summary>
    public bool IsSuccess { get; }

    /// <summary>Non-null on failure outcomes.</summary>
    public string? ErrorMessage { get; }
}

/// <summary>
/// Payload for the <see cref="ConfeatureClient.FlagEvaluated"/> event.
/// </summary>
/// <remarks>
/// Mirrors upstream <c>ConfigCat.Client.FlagEvaluatedEventArgs</c>. Fires on every
/// <c>GetValueDetails</c> call, carrying the produced <see cref="EvaluationDetails{T}"/>.
/// </remarks>
public sealed class FlagEvaluatedEventArgs : EventArgs
{
    internal FlagEvaluatedEventArgs(object evaluationDetails)
    {
        EvaluationDetails = evaluationDetails;
    }

    /// <summary>The produced <see cref="EvaluationDetails{T}"/> (boxed as <see cref="object"/>).</summary>
    public object EvaluationDetails { get; }
}

/// <summary>
/// Payload for the <see cref="ConfeatureClient.Error"/> event.
/// </summary>
/// <remarks>
/// Mirrors upstream <c>ConfigCat.Client.ConfigCatClientErrorEventArgs</c>. Fires on non-fatal
/// SDK errors (HTTP failures, cache I/O, parse failures).
/// </remarks>
public sealed class ConfeatureClientErrorEventArgs : EventArgs
{
    internal ConfeatureClientErrorEventArgs(string message, Exception? exception)
    {
        Message = message;
        Exception = exception;
    }

    /// <summary>Human-readable error description.</summary>
    public string Message { get; }

    /// <summary>The underlying exception, if any.</summary>
    public Exception? Exception { get; }
}
