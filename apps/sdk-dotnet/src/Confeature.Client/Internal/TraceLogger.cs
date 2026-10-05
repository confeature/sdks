// SPDX-License-Identifier: MIT

using System;
using System.Diagnostics;
using System.Globalization;

namespace Confeature.Client.Internal;

/// <summary>
/// Default <see cref="IConfeatureLogger"/> implementation backed by
/// <see cref="Trace"/>.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors ConfigCat's <c>DefaultLogger</c> semantics: writes severity-prefixed
/// lines to <see cref="Trace"/>. <see cref="Trace"/> is preferred over
/// <see cref="Console"/> because customer hosts (ASP.NET Core, Windows
/// services, Unity) usually wire Trace into their existing log pipeline,
/// whereas Console output is environment-specific.
/// </para>
/// <para>
/// All callers MUST redact the SDK key before composing the message
/// (FR-021). This implementation makes no attempt to scrub its input —
/// the redaction contract sits at the call site, not at the sink.
/// </para>
/// </remarks>
internal sealed class TraceLogger : IConfeatureLogger
{
    /// <inheritdoc />
    public LogLevel LogLevel { get; set; } = LogLevel.Warning;

    /// <inheritdoc />
    /// <remarks>
    /// LogLevel runs Off=0 (least verbose) → Debug=4 (most verbose). A call
    /// at <paramref name="level"/> fires when its numerical severity is
    /// &gt; Off AND &lt;= the configured threshold (more verbose configured
    /// levels include all less-verbose calls).
    /// </remarks>
    public bool IsEnabled(LogLevel level)
    {
        if (level == LogLevel.Off)
        {
            return false;
        }

        return (int)level <= (int)LogLevel;
    }

    /// <inheritdoc />
    public void Error(string message, Exception? exception = null)
    {
        if (!IsEnabled(LogLevel.Error))
        {
            return;
        }

        Trace.WriteLine(Format("ERROR", message, exception));
    }

    /// <inheritdoc />
    public void Warning(string message)
    {
        if (!IsEnabled(LogLevel.Warning))
        {
            return;
        }

        Trace.WriteLine(Format("WARN ", message, exception: null));
    }

    /// <inheritdoc />
    public void Info(string message)
    {
        if (!IsEnabled(LogLevel.Info))
        {
            return;
        }

        Trace.WriteLine(Format("INFO ", message, exception: null));
    }

    /// <inheritdoc />
    public void Debug(string message)
    {
        if (!IsEnabled(LogLevel.Debug))
        {
            return;
        }

        Trace.WriteLine(Format("DEBUG", message, exception: null));
    }

    private static string Format(string severity, string message, Exception? exception)
    {
        if (exception is null)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "[Confeature][{0}] {1}",
                severity,
                message);
        }

        return string.Format(
            CultureInfo.InvariantCulture,
            "[Confeature][{0}] {1}{2}{3}",
            severity,
            message,
            Environment.NewLine,
            exception);
    }
}
