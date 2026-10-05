// SPDX-License-Identifier: MIT

using System;
using System.Threading;
using Confeature.Client.Internal;

namespace Confeature.Client;

/// <summary>
/// Hook events surface for <see cref="ConfeatureClient"/>. Mirrors
/// <c>ConfigCat.Client.ConfigCatClient</c>'s five client-level events (Principle II, epic #268):
/// <c>ClientReady</c>, <c>ConfigChanged</c>, <c>ConfigFetched</c>, <c>FlagEvaluated</c>,
/// <c>Error</c>. Event handlers fire on the thread that produced the event (poll service
/// callback, evaluation caller). Handler exceptions are caught and logged — never escape to
/// the emitter.
/// </summary>
public sealed partial class ConfeatureClient
{
    private int _clientReadyFired;

    /// <summary>Fires once, on the first successful config load (cache hydration or fetch).</summary>
    public event EventHandler? ClientReady;

    /// <summary>Fires on every <c>Fetched</c> outcome with the new settings map.</summary>
    public event EventHandler<ConfigChangedEventArgs>? ConfigChanged;

    /// <summary>Fires on every fetch attempt with its success/failure outcome.</summary>
    public event EventHandler<ConfigFetchedEventArgs>? ConfigFetched;

    /// <summary>Fires on every <see cref="GetValueDetails{T}"/> call.</summary>
    public event EventHandler<FlagEvaluatedEventArgs>? FlagEvaluated;

    /// <summary>Fires on non-fatal SDK errors (HTTP failures, cache I/O, parse failures).</summary>
    public event EventHandler<ConfeatureClientErrorEventArgs>? Error;

    private void RaiseClientReadyOnce()
    {
        if (Interlocked.CompareExchange(ref _clientReadyFired, 1, 0) != 0)
        {
            return;
        }

        var handler = ClientReady;
        if (handler is null)
        {
            return;
        }

        foreach (var del in handler.GetInvocationList())
        {
            try
            {
                ((EventHandler)del)(this, EventArgs.Empty);
            }
            catch (Exception ex)
            {
                _logger.Error(
                    "ConfeatureClient.ClientReady handler raised. sdkKey=" + SdkKey.Redact(_sdkKey),
                    ex);
            }
        }
    }

    private void RaiseConfigChanged(object settings)
    {
        var handler = ConfigChanged;
        if (handler is null)
        {
            return;
        }

        var args = new ConfigChangedEventArgs(settings);
        foreach (var del in handler.GetInvocationList())
        {
            try
            {
                ((EventHandler<ConfigChangedEventArgs>)del)(this, args);
            }
            catch (Exception ex)
            {
                _logger.Error(
                    "ConfeatureClient.ConfigChanged handler raised. sdkKey=" + SdkKey.Redact(_sdkKey),
                    ex);
            }
        }
    }

    private void RaiseConfigFetched(bool isSuccess, string? errorMessage)
    {
        var handler = ConfigFetched;
        if (handler is null)
        {
            return;
        }

        var args = new ConfigFetchedEventArgs(isSuccess, errorMessage);
        foreach (var del in handler.GetInvocationList())
        {
            try
            {
                ((EventHandler<ConfigFetchedEventArgs>)del)(this, args);
            }
            catch (Exception ex)
            {
                _logger.Error(
                    "ConfeatureClient.ConfigFetched handler raised. sdkKey=" + SdkKey.Redact(_sdkKey),
                    ex);
            }
        }
    }

    private void RaiseFlagEvaluated(object evaluationDetails)
    {
        var handler = FlagEvaluated;
        if (handler is null)
        {
            return;
        }

        var args = new FlagEvaluatedEventArgs(evaluationDetails);
        foreach (var del in handler.GetInvocationList())
        {
            try
            {
                ((EventHandler<FlagEvaluatedEventArgs>)del)(this, args);
            }
            catch (Exception ex)
            {
                _logger.Error(
                    "ConfeatureClient.FlagEvaluated handler raised. sdkKey=" + SdkKey.Redact(_sdkKey),
                    ex);
            }
        }
    }

    private void RaiseError(string message, Exception? exception = null)
    {
        var handler = Error;
        if (handler is null)
        {
            return;
        }

        var args = new ConfeatureClientErrorEventArgs(message, exception);
        foreach (var del in handler.GetInvocationList())
        {
            try
            {
                ((EventHandler<ConfeatureClientErrorEventArgs>)del)(this, args);
            }
            catch (Exception ex)
            {
                _logger.Error(
                    "ConfeatureClient.Error handler raised. sdkKey=" + SdkKey.Redact(_sdkKey),
                    ex);
            }
        }
    }
}
