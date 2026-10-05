// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Confeature.Client.Internal;

/// <summary>
/// ConfigCat-semantics semver parse + compare.
/// </summary>
/// <remarks>
/// <para>
/// Ported field-for-field from the spec-117 TS reference
/// (<c>packages/sdk-shared/src/semver.ts</c>), cross-checked against the
/// spec-118/119/120/121 ports, which themselves vendor ConfigCat
/// <c>common-js</c> <c>Semver.ts</c>. A NuGet semver package
/// (<c>NuGet.Versioning</c> / <c>SemanticVersioning</c>) is NOT used —
/// ConfigCat's strict-parse + precedence edge cases diverge and would fail
/// the vendored <c>testmatrix_semantic*</c> precedence rows.
/// </para>
/// <para>
/// Key behaviours: strict FULL-grammar parse
/// (<c>v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?</c>); parse on trim;
/// unparseable → <c>null</c> (never throws); precedence numeric core then
/// pre-release (a version without a pre-release ranks HIGHER than one with);
/// build metadata ignored.
/// </para>
/// </remarks>
internal sealed class Semver
{
    private const int MaxLength = 256;
    private const long MaxSafeInteger = 9007199254740991L;

    private static readonly Regex FullRegex = BuildFullRegex();
    private static readonly Regex NumericRegex =
        new("^[0-9]+$", RegexOptions.CultureInvariant);

    private readonly string _version;
    private readonly long _major;
    private readonly long _minor;
    private readonly long _patch;

    // Numberified pre-release identifiers: numeric ids are stored as boxed
    // long, alphanumeric as string (matching the TS number|string union).
    private readonly IReadOnlyList<object> _prerelease;

    private Semver(string version, long major, long minor, long patch, IReadOnlyList<object> prerelease)
    {
        _version = version;
        _major = major;
        _minor = minor;
        _patch = patch;
        _prerelease = prerelease;
    }

    /// <summary>
    /// Parse a version string under ConfigCat's strict grammar; returns
    /// <c>null</c> on any failure (length, grammar, out-of-range core
    /// component) — never throws. Trims the input first.
    /// </summary>
    public static Semver? Parse(string version)
    {
        var trimmed = version.Trim();
        if (trimmed.Length > MaxLength)
        {
            return null;
        }

        var m = FullRegex.Match(trimmed);
        if (!m.Success)
        {
            return null;
        }

        if (!TryParseCore(m.Groups[1].Value, out var major)
            || !TryParseCore(m.Groups[2].Value, out var minor)
            || !TryParseCore(m.Groups[3].Value, out var patch))
        {
            return null;
        }

        var prerelease = new List<object>();
        if (m.Groups[4].Success && m.Groups[4].Value.Length > 0)
        {
            foreach (var id in m.Groups[4].Value.Split('.'))
            {
                if (NumericRegex.IsMatch(id)
                    && long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var num)
                    && num >= 0 && num < MaxSafeInteger)
                {
                    prerelease.Add(num);
                }
                else
                {
                    prerelease.Add(id);
                }
            }
        }

        var canonical = new StringBuilder()
            .Append(major.ToString(CultureInfo.InvariantCulture))
            .Append('.')
            .Append(minor.ToString(CultureInfo.InvariantCulture))
            .Append('.')
            .Append(patch.ToString(CultureInfo.InvariantCulture));
        if (prerelease.Count > 0)
        {
            canonical.Append('-');
            for (var i = 0; i < prerelease.Count; i++)
            {
                if (i > 0)
                {
                    canonical.Append('.');
                }

                canonical.Append(Convert.ToString(prerelease[i], CultureInfo.InvariantCulture));
            }
        }

        return new Semver(canonical.ToString(), major, minor, patch, prerelease);
    }

    /// <summary>
    /// Compare against <paramref name="other"/>: &lt;0 lower, 0 equal, &gt;0
    /// higher. Build metadata is ignored.
    /// </summary>
    public int Compare(Semver other)
    {
        if (string.Equals(other._version, _version, StringComparison.Ordinal))
        {
            return 0;
        }

        var main = CompareMain(other);
        return main != 0 ? main : ComparePre(other);
    }

    private static bool TryParseCore(string value, out long result)
    {
        if (long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out result)
            && result >= 0 && result <= MaxSafeInteger)
        {
            return true;
        }

        result = 0;
        return false;
    }

    private int CompareMain(Semver other)
    {
        var c = CompareIdentifiers(_major, other._major);
        if (c != 0)
        {
            return c;
        }

        c = CompareIdentifiers(_minor, other._minor);
        if (c != 0)
        {
            return c;
        }

        return CompareIdentifiers(_patch, other._patch);
    }

    private int ComparePre(Semver other)
    {
        // A version WITHOUT a pre-release is higher-precedence than one WITH.
        if (_prerelease.Count > 0 && other._prerelease.Count == 0)
        {
            return -1;
        }

        if (_prerelease.Count == 0 && other._prerelease.Count > 0)
        {
            return 1;
        }

        if (_prerelease.Count == 0 && other._prerelease.Count == 0)
        {
            return 0;
        }

        var i = 0;
        while (true)
        {
            var a = i < _prerelease.Count ? _prerelease[i] : null;
            var b = i < other._prerelease.Count ? other._prerelease[i] : null;
            if (a is null && b is null)
            {
                return 0;
            }

            if (b is null)
            {
                return 1;
            }

            if (a is null)
            {
                return -1;
            }

            if (IdentifierEquals(a, b))
            {
                i++;
                continue;
            }

            return CompareIdentifiers(a, b);
        }
    }

    private static bool IdentifierEquals(object a, object b)
    {
        if (a is long la && b is long lb)
        {
            return la == lb;
        }

        return string.Equals(
            Convert.ToString(a, CultureInfo.InvariantCulture),
            Convert.ToString(b, CultureInfo.InvariantCulture),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Compare two pre-release / core identifiers (common-js
    /// <c>compareIdentifiers</c>): both numeric → numeric compare; a numeric
    /// identifier is lower-precedence than an alphanumeric one; otherwise
    /// ASCII-lexical.
    /// </summary>
    private static int CompareIdentifiers(object a, object b)
    {
        var aStr = Convert.ToString(a, CultureInfo.InvariantCulture) ?? string.Empty;
        var bStr = Convert.ToString(b, CultureInfo.InvariantCulture) ?? string.Empty;
        var anum = NumericRegex.IsMatch(aStr);
        var bnum = NumericRegex.IsMatch(bStr);

        if (anum && bnum)
        {
            var av = long.Parse(aStr, NumberStyles.None, CultureInfo.InvariantCulture);
            var bv = long.Parse(bStr, NumberStyles.None, CultureInfo.InvariantCulture);
            if (av == bv)
            {
                return 0;
            }

            return av < bv ? -1 : 1;
        }

        if (string.Equals(aStr, bStr, StringComparison.Ordinal))
        {
            return 0;
        }

        if (anum && !bnum)
        {
            return -1;
        }

        if (bnum && !anum)
        {
            return 1;
        }

        return string.CompareOrdinal(aStr, bStr) < 0 ? -1 : 1;
    }

    private static Regex BuildFullRegex()
    {
        const string numericIdentifier = "0|[1-9]\\d*";
        const string nonNumericIdentifier = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
        var main = $"({numericIdentifier})\\.({numericIdentifier})\\.({numericIdentifier})";
        var prereleaseId = $"(?:{numericIdentifier}|{nonNumericIdentifier})";
        var prerelease = $"(?:-({prereleaseId}(?:\\.{prereleaseId})*))";
        const string buildId = "[0-9A-Za-z-]+";
        var build = $"(?:\\+({buildId}(?:\\.{buildId})*))";
        return new Regex($"^v?{main}{prerelease}?{build}?$", RegexOptions.CultureInvariant);
    }
}
