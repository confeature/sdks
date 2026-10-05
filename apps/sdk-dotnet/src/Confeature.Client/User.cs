// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;

namespace Confeature.Client;

/// <summary>
/// Targeting context passed to flag-evaluation entry points on
/// <c>ConfeatureClient</c> and <c>ConfeatureSnapshot</c>.
/// </summary>
/// <remarks>
/// <para>
/// Field names mirror <c>ConfigCat.Client.User</c> 1:1 per constitution
/// Principle II. <see cref="Identifier"/> is the only required field;
/// <see cref="Email"/>, <see cref="Country"/>, and <see cref="Custom"/>
/// are optional and feed targeting-rule comparisons.
/// </para>
/// <para>
/// <see cref="Custom"/> values are <c>object</c>-typed, matching ConfigCat's
/// <c>IDictionary&lt;string, object&gt;</c> custom bag (spec 151 / #468). The
/// supported runtime types mirror ConfigCat's official .NET SDK: <c>string</c>,
/// <c>int</c> / <c>long</c> / <c>double</c> (numbers), <c>string[]</c> /
/// <c>IReadOnlyList&lt;string&gt;</c> (arrays), and <see cref="DateTimeOffset"/>
/// / <see cref="DateTime"/> (epoch-seconds dates). A non-string value is
/// converted at evaluation time exactly as ConfigCat does — numbers via
/// invariant-culture formatting, dates to fractional Unix seconds, arrays to a
/// JSON array string. A <see cref="string"/> value flows through verbatim,
/// byte-identical to the pre-typed string path (no regression).
/// </para>
/// </remarks>
public sealed class User : IEquatable<User>
{
    private static readonly IReadOnlyDictionary<string, object> EmptyCustom =
        new Dictionary<string, object>(0);

    /// <summary>
    /// Initialises a new <see cref="User"/> with a typed custom-attribute bag,
    /// matching ConfigCat's <c>IDictionary&lt;string, object&gt;</c> surface.
    /// </summary>
    /// <param name="identifier">
    /// The targeting identifier. Required (non-null); may be the empty
    /// string for anonymous sessions, matching ConfigCat's contract.
    /// </param>
    /// <param name="email">Optional email for email-based targeting rules.</param>
    /// <param name="country">Optional country for country-based targeting rules.</param>
    /// <param name="custom">
    /// Optional typed custom attribute bag (<c>string</c> / number /
    /// <c>string[]</c> / <see cref="DateTimeOffset"/>). Defaults to an empty
    /// dictionary when <c>null</c>; never throws on absent attributes.
    /// </param>
    /// <exception cref="ArgumentNullException">
    /// Thrown when <paramref name="identifier"/> is <c>null</c>.
    /// </exception>
    public User(
        string identifier,
        string? email = null,
        string? country = null,
        IReadOnlyDictionary<string, object>? custom = null)
    {
        Identifier = identifier ?? throw new ArgumentNullException(nameof(identifier));
        Email = email;
        Country = country;
        Custom = custom ?? EmptyCustom;
    }

    /// <summary>Targeting identifier. Never <c>null</c>; may be the empty string.</summary>
    public string Identifier { get; }

    /// <summary>Optional email for email-based targeting rules.</summary>
    public string? Email { get; }

    /// <summary>Optional country for country-based targeting rules.</summary>
    public string? Country { get; }

    /// <summary>
    /// Typed custom attribute bag. Never <c>null</c>; empty by default. Values
    /// are <c>object</c>-typed (string / number / string[] / DateTimeOffset),
    /// matching ConfigCat's <c>Custom</c> surface.
    /// </summary>
    public IReadOnlyDictionary<string, object> Custom { get; }

    /// <inheritdoc />
    public bool Equals(User? other)
    {
        if (other is null)
        {
            return false;
        }

        if (ReferenceEquals(this, other))
        {
            return true;
        }

        return string.Equals(Identifier, other.Identifier, StringComparison.Ordinal)
            && string.Equals(Email, other.Email, StringComparison.Ordinal)
            && string.Equals(Country, other.Country, StringComparison.Ordinal)
            && CustomEquals(Custom, other.Custom);
    }

    /// <inheritdoc />
    public override bool Equals(object? obj) => Equals(obj as User);

    /// <inheritdoc />
    public override int GetHashCode()
    {
        // Hash is intentionally lightweight — equality is the contract;
        // collisions are tolerable. Ordinal hashing on the BCL default
        // is sufficient and works on every TFM (netstandard2.0+).
        unchecked
        {
            var hash = StringComparer.Ordinal.GetHashCode(Identifier);
            hash = (hash * 397) ^ (Email is null ? 0 : StringComparer.Ordinal.GetHashCode(Email));
            hash = (hash * 397) ^ (Country is null ? 0 : StringComparer.Ordinal.GetHashCode(Country));
            hash = (hash * 397) ^ Custom.Count;
            return hash;
        }
    }

    private static bool CustomEquals(
        IReadOnlyDictionary<string, object> a,
        IReadOnlyDictionary<string, object> b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var kvp in a)
        {
            if (!b.TryGetValue(kvp.Key, out var bValue))
            {
                return false;
            }

            if (!Equals(kvp.Value, bValue))
            {
                return false;
            }
        }

        return true;
    }
}
