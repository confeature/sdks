// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client;

/// <summary>
/// Customer-replaceable abstraction over logging. Default implementation
/// wraps <see cref="System.Diagnostics.Trace"/>.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors <c>ConfigCat.Client.IConfigCatLogger</c> 1:1 in shape; the name
/// is renamed for the Confeature brand per constitution Principle IV.
/// </para>
/// <para>
/// SECURITY (constitution security clause + FR-021): the SDK MUST NEVER
/// pass the raw SDK key to any logger method. The internal code path
/// always routes through <c>SdkKey.Redact(...)</c> before composing a
/// log message. Customer implementations of this interface receive
/// already-redacted strings.
/// </para>
/// </remarks>
public interface IConfeatureLogger
{
    /// <summary>The active severity threshold. Calls below it are skipped.</summary>
    LogLevel LogLevel { get; set; }

    /// <summary>Returns <c>true</c> when a call at <paramref name="level"/> would be emitted.</summary>
    bool IsEnabled(LogLevel level);

    /// <summary>Logs an error.</summary>
    void Error(string message, Exception? exception = null);

    /// <summary>Logs a warning.</summary>
    void Warning(string message);

    /// <summary>Logs an informational message.</summary>
    void Info(string message);

    /// <summary>Logs a debug-level diagnostic message.</summary>
    void Debug(string message);
}
