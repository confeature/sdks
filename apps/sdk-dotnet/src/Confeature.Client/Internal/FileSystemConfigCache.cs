// SPDX-License-Identifier: MIT

using System;
using System.IO;
using System.Threading;

namespace Confeature.Client.Internal;

/// <summary>
/// Filesystem-backed <see cref="IConfigCache"/>. Default in
/// production; mirrors the Python + Go file caches.
/// </summary>
/// <remarks>
/// <para>
/// Writes to <c>{CacheDirectory}/confeature-{cacheKeyTail}.json</c> atomically:
/// the payload lands in a temp file first, then <see cref="File.Move(string, string)"/>
/// renames it over the target.
/// </para>
/// <para>
/// On the first <see cref="IOException"/> (read or write), the cache logs
/// a single WARNING and switches to memory-only mode for the remainder of
/// the client lifetime — subsequent operations route through an internal
/// <see cref="InMemoryConfigCache"/> and never re-attempt the filesystem.
/// Matches Python (FR-012) and Go (research §R6).
/// </para>
/// </remarks>
internal sealed class FileSystemConfigCache : IConfigCache
{
    private readonly string _cacheDirectory;
    private readonly IConfeatureLogger _logger;
    private readonly InMemoryConfigCache _memoryFallback = new();
    private int _fallbackEngaged; // 0 = filesystem, 1 = memory-only

    /// <summary>Initialises a new <see cref="FileSystemConfigCache"/>.</summary>
    /// <param name="cacheDirectory">
    /// Filesystem path to the cache directory. Created on first write.
    /// Required (non-null, non-empty).
    /// </param>
    /// <param name="logger">Logger. Required.</param>
    public FileSystemConfigCache(string cacheDirectory, IConfeatureLogger logger)
    {
        if (string.IsNullOrEmpty(cacheDirectory))
        {
            throw new ArgumentException(
                "cacheDirectory must be non-empty.",
                nameof(cacheDirectory));
        }

        _cacheDirectory = cacheDirectory;
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Computes the on-disk path for a cache key.</summary>
    /// <remarks>
    /// Filename is <c>confeature-{cacheKeyTail}.json</c> where the tail
    /// is the 32-char base64url segment after the envelope prefix.
    /// Mirrors the Python + Go file naming exactly so customers can
    /// freely switch SDK languages without invalidating the on-disk
    /// cache.
    /// </remarks>
    public string ResolveFilePath(string cacheKey)
    {
        if (cacheKey is null)
        {
            throw new ArgumentNullException(nameof(cacheKey));
        }

        var idx = cacheKey.LastIndexOf(':');
        var tail = idx >= 0 && idx < cacheKey.Length - 1
            ? cacheKey.Substring(idx + 1)
            : cacheKey;
        return Path.Combine(_cacheDirectory, "confeature-" + tail + ".json");
    }

    /// <summary>Returns <c>true</c> when the cache has switched to memory-only mode.</summary>
    internal bool IsMemoryFallback => Volatile.Read(ref _fallbackEngaged) == 1;

    /// <inheritdoc />
    public string? Read(string cacheKey)
    {
        if (IsMemoryFallback)
        {
            return _memoryFallback.Read(cacheKey);
        }

        var path = ResolveFilePath(cacheKey);
        try
        {
            if (!File.Exists(path))
            {
                return _memoryFallback.Read(cacheKey);
            }

            return File.ReadAllText(path);
        }
        catch (IOException ex)
        {
            EngageFallback(path, ex);
            return _memoryFallback.Read(cacheKey);
        }
        catch (UnauthorizedAccessException ex)
        {
            EngageFallback(path, ex);
            return _memoryFallback.Read(cacheKey);
        }
    }

    /// <inheritdoc />
    public void Write(string cacheKey, string value)
    {
        // Mirror every write into memory first so a subsequent Read after
        // a failed disk write still returns the entry.
        _memoryFallback.Write(cacheKey, value);

        if (IsMemoryFallback)
        {
            return;
        }

        var path = ResolveFilePath(cacheKey);
        var tmp = path + ".tmp";
        try
        {
            Directory.CreateDirectory(_cacheDirectory);
            File.WriteAllText(tmp, value);

            // File.Move with overwrite is the atomic-rename idiom on .NET Core 3+ /
            // net5+. netstandard2.0 / netstandard2.1 lack the overload; emulate
            // via delete-then-move (small race window acceptable — the cache is
            // a best-effort hint, not a source of truth).
#if NET6_0_OR_GREATER
            File.Move(tmp, path, overwrite: true);
#else
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            File.Move(tmp, path);
#endif
        }
        catch (IOException ex)
        {
            TryCleanupTemp(tmp);
            EngageFallback(path, ex);
        }
        catch (UnauthorizedAccessException ex)
        {
            TryCleanupTemp(tmp);
            EngageFallback(path, ex);
        }
    }

    private void EngageFallback(string path, Exception ex)
    {
        if (Interlocked.Exchange(ref _fallbackEngaged, 1) == 0)
        {
            _logger.Warning(
                "FileSystemConfigCache: filesystem unwritable at " + path
                + "; falling back to in-memory cache. reason=" + ex.Message);
        }
    }

    private static void TryCleanupTemp(string tmp)
    {
        try
        {
            if (File.Exists(tmp))
            {
                File.Delete(tmp);
            }
        }
        catch (IOException)
        {
            // Best-effort cleanup — already in the failure path; another
            // IOException here is not actionable.
        }
        catch (UnauthorizedAccessException)
        {
            // Same rationale as the IOException above.
        }
    }
}
