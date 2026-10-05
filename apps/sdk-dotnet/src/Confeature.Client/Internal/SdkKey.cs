// SPDX-License-Identifier: MIT

using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Confeature.Client.Internal;

/// <summary>
/// SDK-key format helpers + cache-key derivation.
/// </summary>
/// <remarks>
/// <para>
/// SECURITY (constitution security clause + spec 039 FR-021): SDK keys
/// are secrets. They MUST NEVER appear verbatim in any log line. Every
/// log site that references the key MUST route through <see cref="Redact"/>.
/// </para>
/// <para>
/// The cache-key algorithm mirrors <c>packages/sdk-shared/src/sdk-key.ts</c>'s
/// async <c>deriveCacheKey</c> (SHA-256 → base64url → first 32 chars) plus
/// the Python and Go ports. Cross-language fixture verification lives in
/// <c>SdkKeyTests.cs</c>.
/// </para>
/// </remarks>
internal static class SdkKey
{
    /// <summary>
    /// Envelope prefix for derived cache keys. Identical across every
    /// Confeature SDK; mirrors the TS implementation's constant.
    /// </summary>
    public const string CacheKeyPrefix = "confeature:cache:v1:";

    /// <summary>
    /// Wire formats of a valid Confeature SDK key — both are valid (#802):
    /// <list type="bullet">
    /// <item><description><c>configcat-sdk-1/&lt;22 url-safe chars&gt;/&lt;22 url-safe chars&gt;</c>
    /// — minted today; ConfigCat's own shape, so a stock ConfigCat SDK
    /// accepts the key too.</description></item>
    /// <item><description><c>confeature-sdk-1-&lt;32 url-safe chars&gt;-&lt;32 url-safe chars&gt;</c>
    /// — minted before #802; still served until the key is rotated.</description></item>
    /// </list>
    /// Mirrors <c>CONFEATURE_SDK_KEY_PATTERN</c> in <c>packages/sdk-shared</c>.
    /// Validation is lenient at runtime: malformed keys log
    /// <c>INVALID_SDK_KEY</c> (redacted) and continue.
    /// </summary>
    /// <remarks>
    /// Anchored with <c>\z</c>, not <c>$</c>: in .NET, <c>$</c> also matches
    /// before a trailing <c>\n</c>, which the JS reference rejects.
    /// </remarks>
    private static readonly Regex ConfeatureSdkKeyPattern = new(
        @"^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})\z",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Returns <c>true</c> iff the key matches either Confeature SDK-key
    /// format: <c>configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}</c>
    /// (current) or <c>confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32}</c>
    /// (legacy, still accepted).
    /// </summary>
    /// <remarks>
    /// A <c>false</c> result does NOT cause the SDK to throw; it triggers
    /// an <c>INVALID_SDK_KEY</c> log line (which, per the security clause,
    /// includes only the redacted form). The accept/reject cases live in
    /// <c>packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json</c>.
    /// </remarks>
    public static bool IsValidConfeatureKeyFormat(string? sdkKey)
    {
        if (sdkKey is null)
        {
            return false;
        }

        return ConfeatureSdkKeyPattern.IsMatch(sdkKey);
    }

    /// <summary>
    /// Returns a privacy-preserving rendering of <paramref name="sdkKey"/>
    /// for log output. NEVER returns the raw key.
    /// </summary>
    /// <remarks>
    /// Strategy: keep ~10% of the key visible at each end (minimum 4
    /// chars), mask the middle. The key is treated as opaque text, so a
    /// <c>/</c> is just another character: a 61-char
    /// <c>configcat-sdk-1/&lt;22&gt;/&lt;22&gt;</c> key shows 6 chars at each
    /// end — the head is all prefix, the tail 6 secret chars (the legacy
    /// 82-char shape shows 8). For short / unusual keys (&lt; 16 chars),
    /// <c>null</c>, and the empty string, fall back to a full mask.
    /// Mirrors <c>redactSdkKey</c> in <c>packages/sdk-shared</c> +
    /// <c>redact_sdk_key</c> in Python + <c>RedactSdkKey</c> in Go.
    /// </remarks>
    public static string Redact(string? sdkKey)
    {
        if (string.IsNullOrEmpty(sdkKey))
        {
            return "[redacted]";
        }

        if (sdkKey!.Length < 16)
        {
            return "[redacted]";
        }

        var visible = Math.Max(4, sdkKey.Length / 10);
        var head = sdkKey.Substring(0, visible);
        var tail = sdkKey.Substring(sdkKey.Length - visible);
        return head + "…[redacted]…" + tail;
    }

    /// <summary>
    /// Derives a stable, opaque cache key from an SDK key.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Format: <c>confeature:cache:v1:&lt;base64url(sha256(sdkKey))[:32]&gt;</c>.
    /// </para>
    /// <para>
    /// Output is byte-identical to:
    /// </para>
    /// <list type="bullet">
    /// <item><description><c>packages/sdk-shared/src/sdk-key.ts::deriveCacheKey</c> (TS canonical).</description></item>
    /// <item><description><c>apps/sdk-python/.../sdk_key.py::derive_cache_key</c>.</description></item>
    /// <item><description><c>apps/sdk-go/internal/sdkkey/sdkkey.go::DeriveCacheKey</c>.</description></item>
    /// </list>
    /// <para>
    /// The cross-language fixture at
    /// <c>packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json</c>
    /// pins ≥ 5 <c>(sdkKey, expectedCacheKey)</c> pairs; <c>SdkKeyTests.cs</c>
    /// asserts equality for every entry.
    /// </para>
    /// <para>
    /// SECURITY: the SDK key is HASHED, never stored raw. Even an attacker
    /// with filesystem access to the cache directory cannot read the SDK
    /// key from a written cache file's name.
    /// </para>
    /// </remarks>
    /// <param name="sdkKey">The SDK key. Must be non-null.</param>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="sdkKey"/> is <c>null</c>.
    /// </exception>
    public static string DeriveCacheKey(string sdkKey)
    {
        if (sdkKey is null)
        {
            throw new ArgumentNullException(nameof(sdkKey));
        }

        var bytes = Encoding.UTF8.GetBytes(sdkKey);
        byte[] hash;
#if NET8_0_OR_GREATER
        hash = SHA256.HashData(bytes);
#else
        using (var sha = SHA256.Create())
        {
            hash = sha.ComputeHash(bytes);
        }
#endif

        // Standard base64 → URL-safe base64 → strip padding → take first 32.
        // Matches RFC 4648 §5 (base64url) + the TS canonical's
        // .replace(/=+$/, "").slice(0, 32) post-processing.
        var b64 = Convert.ToBase64String(hash)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
        return CacheKeyPrefix + b64.Substring(0, 32);
    }
}
