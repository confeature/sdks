// SPDX-License-Identifier: MIT

using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Confeature.Client.Internal;

/// <summary>
/// ConfigCat evaluation hashes — SHA-1 (unsalted percentage bucketing) +
/// SHA-256 (salted sensitive comparators).
/// </summary>
/// <remarks>
/// <para>
/// Ported field-for-field from the spec-117 TS reference
/// (<c>packages/sdk-shared/src/hash.ts</c>), cross-checked against the
/// spec-118/119/120/121 Python / Go / Ruby / PHP ports. The flag evaluator
/// needs two synchronous hashes:
/// </para>
/// <list type="bullet">
///   <item><b>SHA-1, UNSALTED</b> for percentage bucketing —
///   <c>parseInt(sha1(key + attr)[0..7], 16) % 100</c>.</item>
///   <item><b>SHA-256, SALTED</b> for sensitive comparators —
///   <c>sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))</c>.</item>
/// </list>
/// <para>
/// Unlike the TS reference (which vendors a pure-JS implementation because
/// <c>crypto.subtle</c> is async on every runtime), .NET's
/// <see cref="SHA1"/> / <see cref="SHA256"/> are synchronous and present on
/// every supported TFM, so they are used directly. UTF-8 byte sequences are
/// obtained via <see cref="Encoding.UTF8"/>, so every bucket / hash comes out
/// byte-identical across the federation (the parity corpus requires this).
/// </para>
/// </remarks>
internal static class Hashing
{
    /// <summary>Lowercase-hex SHA-1 of the UTF-8 bytes of <paramref name="input"/>.</summary>
    public static string Sha1Hex(string input) => ToHex(Sha1(Encoding.UTF8.GetBytes(input)));

    /// <summary>Lowercase-hex SHA-256 of the UTF-8 bytes of <paramref name="input"/>.</summary>
    public static string Sha256Hex(string input) => Sha256HexBytes(Encoding.UTF8.GetBytes(input));

    /// <summary>Lowercase-hex SHA-256 of a raw byte sequence.</summary>
    public static string Sha256HexBytes(byte[] data) => ToHex(Sha256(data));

    /// <summary>
    /// Hash a user-attribute value for a sensitive comparator. Mirrors
    /// <c>hash.ts::hashComparisonValue</c>:
    /// <c>sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))</c>,
    /// concatenated with no separators, output as lowercase hex.
    /// </summary>
    public static string HashComparisonValue(string value, string configSalt, string contextSalt) =>
        Sha256Hex(value + configSalt + contextSalt);

    /// <summary>
    /// Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator.
    /// Mirrors <c>comparators.ts::hashComparisonValueSlice</c>:
    /// <c>sha256(sliceBytes ++ utf8(configSalt) ++ utf8(contextSalt))</c>. The
    /// slice is raw bytes (a byte-boundary cut that may land mid-codepoint),
    /// so the hash runs over the concatenated byte sequence.
    /// </summary>
    public static string HashComparisonValueSlice(byte[] sliceUtf8, string configSalt, string contextSalt)
    {
        var saltBytes = Encoding.UTF8.GetBytes(configSalt);
        var ctxBytes = Encoding.UTF8.GetBytes(contextSalt);
        var buf = new byte[sliceUtf8.Length + saltBytes.Length + ctxBytes.Length];
        Buffer.BlockCopy(sliceUtf8, 0, buf, 0, sliceUtf8.Length);
        Buffer.BlockCopy(saltBytes, 0, buf, sliceUtf8.Length, saltBytes.Length);
        Buffer.BlockCopy(ctxBytes, 0, buf, sliceUtf8.Length + saltBytes.Length, ctxBytes.Length);
        return Sha256HexBytes(buf);
    }

    /// <summary>
    /// Compute a ConfigCat percentage bucket in <c>[0, 99]</c> for
    /// <c>key + attrValue</c>. Mirrors <c>hash.ts::percentageBucket</c>:
    /// <c>parseInt(sha1(key + attrValue)[0..7], 16) % 100</c>. SHA-1,
    /// <b>unsalted</b>; 7 hex chars = 28 bits, well within a 32-bit parse.
    /// </summary>
    public static int PercentageBucket(string key, string attrValue)
    {
        var hex = Sha1Hex(key + attrValue).Substring(0, 7);
        var value = int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return value % 100;
    }

    private static byte[] Sha1(byte[] data)
    {
        // CA5350 justified-suppress: SHA-1 here is NOT used for any security
        // purpose — it is ConfigCat's fixed percentage-bucketing hash
        // (parseInt(sha1(key+attr)[0..7],16) % 100). The algorithm choice is
        // dictated by the wire contract / cross-language parity corpus and
        // cannot be swapped for a stronger hash without breaking parity.
#pragma warning disable CA5350 // Do Not Use Weak Cryptographic Algorithms
#if NET8_0_OR_GREATER
        return SHA1.HashData(data);
#else
        using var sha = SHA1.Create();
        return sha.ComputeHash(data);
#endif
#pragma warning restore CA5350
    }

    private static byte[] Sha256(byte[] data)
    {
#if NET8_0_OR_GREATER
        return SHA256.HashData(data);
#else
        using var sha = SHA256.Create();
        return sha.ComputeHash(data);
#endif
    }

    private static string ToHex(byte[] bytes)
    {
        const string hex = "0123456789abcdef";
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes)
        {
            sb.Append(hex[(b >> 4) & 0x0f]);
            sb.Append(hex[b & 0x0f]);
        }

        return sb.ToString();
    }
}
