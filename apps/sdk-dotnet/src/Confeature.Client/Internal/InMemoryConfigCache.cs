// SPDX-License-Identifier: MIT

using System.Collections.Generic;

namespace Confeature.Client.Internal;

/// <summary>
/// Process-local <see cref="IConfigCache"/> backing. The fallback target
/// when <see cref="FileSystemConfigCache"/> encounters an
/// <see cref="System.IO.IOException"/> on the configured directory.
/// </summary>
/// <remarks>
/// Thread-safe via per-instance <c>lock</c>. Mirrors the Go SDK's
/// <c>MemoryCache</c> and Python's in-process dict fallback.
/// </remarks>
internal sealed class InMemoryConfigCache : IConfigCache
{
    private readonly Dictionary<string, string> _store = new();
    private readonly object _gate = new();

    /// <inheritdoc />
    public string? Read(string cacheKey)
    {
        lock (_gate)
        {
            return _store.TryGetValue(cacheKey, out var value) ? value : null;
        }
    }

    /// <inheritdoc />
    public void Write(string cacheKey, string value)
    {
        lock (_gate)
        {
            _store[cacheKey] = value;
        }
    }
}
