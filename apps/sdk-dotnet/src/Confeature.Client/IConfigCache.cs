// SPDX-License-Identifier: MIT

namespace Confeature.Client;

/// <summary>
/// Customer-replaceable cache abstraction for the latest
/// <c>config_v6.json</c> body + ETag.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors <c>ConfigCat.Client.IConfigCatCache</c> 1:1 in shape; renamed
/// for the Confeature brand per constitution Principle IV.
/// </para>
/// <para>
/// The cache is consulted in two places: on construction (to restore
/// any persisted entry into in-memory state) and after every successful
/// fetch (to persist the new entry). Implementations MUST be safe to
/// invoke concurrently with reads + writes on the same key.
/// </para>
/// </remarks>
public interface IConfigCache
{
    /// <summary>
    /// Reads the latest cached entry for <paramref name="cacheKey"/>, or
    /// <c>null</c> when nothing has been persisted.
    /// </summary>
    /// <param name="cacheKey">
    /// The derived cache key (output of <c>SdkKey.DeriveCacheKey</c>).
    /// </param>
    string? Read(string cacheKey);

    /// <summary>Persists <paramref name="value"/> at <paramref name="cacheKey"/>.</summary>
    /// <param name="cacheKey">The derived cache key.</param>
    /// <param name="value">The JSON-encoded entry payload.</param>
    void Write(string cacheKey, string value);
}
