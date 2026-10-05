// SPDX-License-Identifier: MIT

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Confeature.Client.Tests.TestUtils;

/// <summary>
/// <see cref="IConfeatureLogger"/> implementation that records every
/// message at any severity into a thread-safe list. Used by SDK key
/// redaction assertions across the unit-test suite.
/// </summary>
internal sealed class CapturingLogger : IConfeatureLogger
{
    private readonly ConcurrentQueue<(LogLevel Level, string Message, Exception? Exception)> _entries = new();

    public LogLevel LogLevel { get; set; } = LogLevel.Debug;

    public bool IsEnabled(LogLevel level) => level != LogLevel.Off && (int)level <= (int)LogLevel;

    public void Error(string message, Exception? exception = null)
    {
        _entries.Enqueue((LogLevel.Error, message, exception));
    }

    public void Warning(string message)
    {
        _entries.Enqueue((LogLevel.Warning, message, null));
    }

    public void Info(string message)
    {
        _entries.Enqueue((LogLevel.Info, message, null));
    }

    public void Debug(string message)
    {
        _entries.Enqueue((LogLevel.Debug, message, null));
    }

    /// <summary>Returns every message captured so far, regardless of severity.</summary>
    public IReadOnlyList<string> AllMessages =>
        _entries.Select(e => e.Message).ToList();

    /// <summary>
    /// Returns everything a real logger would print: every message, plus —
    /// for each logged exception — the <see cref="Exception.Message"/> and
    /// <see cref="Exception.ToString"/> of the exception and of its whole
    /// cause chain (<see cref="Exception.InnerException"/> and every
    /// <see cref="AggregateException.InnerExceptions"/> entry). Key-free
    /// assertions (FR-021) MUST check this, not <see cref="AllMessages"/>.
    /// </summary>
    public IReadOnlyList<string> AllRendered
    {
        get
        {
            var rendered = new List<string>();
            foreach (var entry in _entries)
            {
                rendered.Add(entry.Message);
                if (entry.Exception is not null)
                {
                    AddChain(entry.Exception, rendered);
                }
            }

            return rendered;
        }
    }

    /// <summary>Returns every exception passed to <see cref="Error"/>, in order.</summary>
    public IReadOnlyList<Exception> Exceptions =>
        _entries.Where(e => e.Exception is not null).Select(e => e.Exception!).ToList();

    private static void AddChain(Exception root, List<string> rendered)
    {
        var pending = new Stack<Exception>();
        var seen = new HashSet<Exception>(ReferenceEqualityComparer.Instance);
        pending.Push(root);
        while (pending.Count > 0)
        {
            var ex = pending.Pop();
            if (!seen.Add(ex))
            {
                continue;
            }

            rendered.Add(ex.Message);
            rendered.Add(ex.ToString());
            if (ex is AggregateException aggregate)
            {
                foreach (var inner in aggregate.InnerExceptions)
                {
                    pending.Push(inner);
                }
            }

            if (ex.InnerException is not null)
            {
                pending.Push(ex.InnerException);
            }
        }
    }

    /// <summary>Returns messages at a specific severity.</summary>
    public IReadOnlyList<string> MessagesAt(LogLevel level) =>
        _entries.Where(e => e.Level == level).Select(e => e.Message).ToList();
}
