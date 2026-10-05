// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Confeature.Client.Internal;

/// <summary>
/// The 36 ConfigCat <c>UserComparator</c> operations + attribute conversion.
/// </summary>
/// <remarks>
/// Ported field-for-field from the spec-117 TS reference
/// (<c>packages/sdk-shared/src/comparators.ts</c>), cross-checked against the
/// spec-118/119/120/121 Python / Go / Ruby / PHP ports, itself verified
/// against common-js <c>RolloutEvaluator.ts</c>. Each comparator returns a
/// bool match, or throws nothing — typed-attribute conversion failures are
/// surfaced via a <see cref="ValidationError"/> return on the conversion
/// helpers (FR-010). Number parsing uses
/// <see cref="CultureInfo.InvariantCulture"/> with <c>,</c>→<c>.</c>.
/// </remarks>
internal static class Comparators
{
    // UserComparator discriminators (mirror config-json.ts UserComparator).
    public const int TextIsOneOf = 0;
    public const int TextIsNotOneOf = 1;
    public const int TextContainsAnyOf = 2;
    public const int TextNotContainsAnyOf = 3;
    public const int SemVerIsOneOf = 4;
    public const int SemVerIsNotOneOf = 5;
    public const int SemVerLess = 6;
    public const int SemVerLessOrEquals = 7;
    public const int SemVerGreater = 8;
    public const int SemVerGreaterOrEquals = 9;
    public const int NumberEquals = 10;
    public const int NumberNotEquals = 11;
    public const int NumberLess = 12;
    public const int NumberLessOrEquals = 13;
    public const int NumberGreater = 14;
    public const int NumberGreaterOrEquals = 15;
    public const int SensitiveTextIsOneOf = 16;
    public const int SensitiveTextIsNotOneOf = 17;
    public const int DateTimeBefore = 18;
    public const int DateTimeAfter = 19;
    public const int SensitiveTextEquals = 20;
    public const int SensitiveTextNotEquals = 21;
    public const int SensitiveTextStartsWithAnyOf = 22;
    public const int SensitiveTextNotStartsWithAnyOf = 23;
    public const int SensitiveTextEndsWithAnyOf = 24;
    public const int SensitiveTextNotEndsWithAnyOf = 25;
    public const int SensitiveArrayContainsAnyOf = 26;
    public const int SensitiveArrayNotContainsAnyOf = 27;
    public const int TextEquals = 28;
    public const int TextNotEquals = 29;
    public const int TextStartsWithAnyOf = 30;
    public const int TextNotStartsWithAnyOf = 31;
    public const int TextEndsWithAnyOf = 32;
    public const int TextNotEndsWithAnyOf = 33;
    public const int ArrayContainsAnyOf = 34;
    public const int ArrayNotContainsAnyOf = 35;

    private static readonly Regex StrictFloatRegex = new(
        @"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$",
        RegexOptions.CultureInvariant);

    private static readonly Regex LeadingZeroOctalHexRegex = new(
        @"^\s*$|^\s*0[^\d.eE]",
        RegexOptions.CultureInvariant);

    private static readonly char[] ExponentMarkers = { 'e', 'E' };

    private static readonly DateTime UnixEpochUtc =
        new(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    // -----------------------------------------------------------------------
    // Attribute stringification
    // -----------------------------------------------------------------------

    /// <summary>True iff <paramref name="value"/> is a read-only list of strings.</summary>
    public static bool IsStringArray(object? value) => value is IReadOnlyList<string>;

    /// <summary>
    /// Stringify a user-attribute value (common-js
    /// <c>userAttributeValueToString</c>): string verbatim; bool →
    /// "true"/"false"; <see cref="DateTime"/> → Unix seconds; string array →
    /// JSON; number → JS canonical string; else cast to string.
    /// </summary>
    public static string UserAttributeValueToString(object? value)
    {
        switch (value)
        {
            case null:
                return string.Empty;
            case string s:
                return s;
            case bool b:
                return b ? "true" : "false";
            case IReadOnlyList<string> arr:
                return JsonArray(arr);
            case DateTime dt:
                return NumberToCanonicalString(ToUnixSeconds(dt));
            case DateTimeOffset dto:
                return NumberToCanonicalString(dto.ToUnixTimeMilliseconds() / 1000.0);
            case double d:
                return NumberToCanonicalString(d);
            case float f:
                return NumberToCanonicalString(f);
            case int i:
                return NumberToCanonicalString(i);
            case long l:
                return NumberToCanonicalString(l);
            default:
                return value.ToString() ?? string.Empty;
        }
    }

    /// <summary>Attribute → text (string verbatim; else stringified — never errors).</summary>
    public static string AttributeAsText(object? value) =>
        value is string s ? s : UserAttributeValueToString(value);

    // -----------------------------------------------------------------------
    // Number / strict float parse
    // -----------------------------------------------------------------------

    /// <summary>
    /// Strict whole-string float parse (common-js <c>parseFloatStrict</c>):
    /// rejects empty / all-whitespace and a leading <c>0</c> followed by a
    /// non-digit/non-<c>.</c>/non-<c>e</c> (octal / hex). Returns
    /// <see cref="double.NaN"/> on rejection. Accepts "Infinity" / "-Infinity"
    /// like JS <c>+value</c>.
    /// </summary>
    public static double ParseFloatStrict(string value)
    {
        if (value.Length == 0 || LeadingZeroOctalHexRegex.IsMatch(value))
        {
            return double.NaN;
        }

        var stripped = value.Trim();
        if (stripped == "Infinity")
        {
            return double.PositiveInfinity;
        }

        if (stripped == "-Infinity")
        {
            return double.NegativeInfinity;
        }

        if (stripped == "NaN")
        {
            return double.NaN;
        }

        if (!StrictFloatRegex.IsMatch(stripped))
        {
            return double.NaN;
        }

        return double.TryParse(stripped, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)
            ? d
            : double.NaN;
    }

    // -----------------------------------------------------------------------
    // Text — cleartext (case-sensitive, no trim)
    // -----------------------------------------------------------------------

    public static bool EvaluateTextEquals(string text, string comparisonValue, bool negate) =>
        string.Equals(text, comparisonValue, StringComparison.Ordinal) != negate;

    public static bool EvaluateTextIsOneOf(string text, IReadOnlyList<string> values, bool negate)
    {
        var found = false;
        foreach (var v in values)
        {
            if (string.Equals(text, v, StringComparison.Ordinal))
            {
                found = true;
                break;
            }
        }

        return found != negate;
    }

    public static bool EvaluateTextContainsAnyOf(string text, IReadOnlyList<string> values, bool negate)
    {
        foreach (var v in values)
        {
            if (OrdinalContains(text, v))
            {
                return !negate;
            }
        }

        return negate;
    }

    public static bool EvaluateTextSliceEqualsAnyOf(
        string text,
        IReadOnlyList<string> values,
        bool startsWith,
        bool negate)
    {
        foreach (var item in values)
        {
            if (text.Length < item.Length)
            {
                continue;
            }

            var matched = startsWith
                ? text.StartsWith(item, StringComparison.Ordinal)
                : text.EndsWith(item, StringComparison.Ordinal);
            if (matched)
            {
                return !negate;
            }
        }

        return negate;
    }

    // -----------------------------------------------------------------------
    // Text — sensitive (SHA-256 salted)
    // -----------------------------------------------------------------------

    public static bool EvaluateSensitiveTextEquals(
        string text,
        string comparisonValue,
        string configSalt,
        string contextSalt,
        bool negate)
    {
        var hash = Hashing.HashComparisonValue(text, configSalt, contextSalt);
        return string.Equals(hash, comparisonValue, StringComparison.Ordinal) != negate;
    }

    public static bool EvaluateSensitiveTextIsOneOf(
        string text,
        IReadOnlyList<string> values,
        string configSalt,
        string contextSalt,
        bool negate)
    {
        var hash = Hashing.HashComparisonValue(text, configSalt, contextSalt);
        var found = false;
        foreach (var v in values)
        {
            if (string.Equals(hash, v, StringComparison.Ordinal))
            {
                found = true;
                break;
            }
        }

        return found != negate;
    }

    public static bool EvaluateSensitiveTextSliceEqualsAnyOf(
        string text,
        IReadOnlyList<string> values,
        string configSalt,
        string contextSalt,
        bool startsWith,
        bool negate)
    {
        var textUtf8 = Encoding.UTF8.GetBytes(text);
        foreach (var item in values)
        {
            var index = item.IndexOf('_');
            if (index < 0)
            {
                continue;
            }

            var sliceLengthStr = item.Substring(0, index);
            if (!int.TryParse(sliceLengthStr, NumberStyles.None, CultureInfo.InvariantCulture, out var sliceLength))
            {
                continue;
            }

            if (textUtf8.Length < sliceLength)
            {
                continue;
            }

            var slice = new byte[sliceLength];
            var offset = startsWith ? 0 : textUtf8.Length - sliceLength;
            Buffer.BlockCopy(textUtf8, offset, slice, 0, sliceLength);
            var hash = Hashing.HashComparisonValueSlice(slice, configSalt, contextSalt);
            if (string.Equals(hash, item.Substring(index + 1), StringComparison.Ordinal))
            {
                return !negate;
            }
        }

        return negate;
    }

    // -----------------------------------------------------------------------
    // Semver
    // -----------------------------------------------------------------------

    // Semver IS-ONE-OF / IS-NOT-ONE-OF. Each operand is trimmed first; an operand that is empty
    // AFTER trimming (incl. whitespace-only) is skipped — matching ConfigCat, which trims before
    // the empty check. A non-empty but unparseable operand makes the whole comparator false.
    public static bool EvaluateSemVerIsOneOf(Semver version, IReadOnlyList<string> values, bool negate)
    {
        var result = false;
        foreach (var rawItem in values)
        {
            var item = rawItem.Trim();
            if (item.Length == 0)
            {
                continue;
            }

            var version2 = Semver.Parse(item);
            if (version2 is null)
            {
                return false;
            }

            if (!result && version.Compare(version2) == 0)
            {
                result = true;
            }
        }

        return result != negate;
    }

    public static bool EvaluateSemVerRelation(Semver version, int comparator, string comparisonValue)
    {
        var version2 = Semver.Parse(comparisonValue.Trim());
        if (version2 is null)
        {
            return false;
        }

        var cmp = version.Compare(version2);
        return comparator switch
        {
            SemVerLess => cmp < 0,
            SemVerLessOrEquals => cmp <= 0,
            SemVerGreater => cmp > 0,
            SemVerGreaterOrEquals => cmp >= 0,
            _ => false,
        };
    }

    // -----------------------------------------------------------------------
    // Number
    // -----------------------------------------------------------------------

    public static bool EvaluateNumberRelation(double num, int comparator, double comparisonValue)
    {
        return comparator switch
        {
            NumberEquals => num == comparisonValue,
            NumberNotEquals => num != comparisonValue,
            NumberLess => num < comparisonValue,
            NumberLessOrEquals => num <= comparisonValue,
            NumberGreater => num > comparisonValue,
            NumberGreaterOrEquals => num >= comparisonValue,
            _ => false,
        };
    }

    // -----------------------------------------------------------------------
    // Datetime (Unix seconds)
    // -----------------------------------------------------------------------

    public static bool EvaluateDateTimeRelation(double seconds, double comparisonValue, bool before) =>
        before ? seconds < comparisonValue : seconds > comparisonValue;

    // -----------------------------------------------------------------------
    // Array (cleartext + sensitive)
    // -----------------------------------------------------------------------

    public static bool EvaluateArrayContainsAnyOf(
        IReadOnlyList<string> array,
        IReadOnlyList<string> values,
        bool negate)
    {
        foreach (var item in array)
        {
            foreach (var v in values)
            {
                if (string.Equals(item, v, StringComparison.Ordinal))
                {
                    return !negate;
                }
            }
        }

        return negate;
    }

    public static bool EvaluateSensitiveArrayContainsAnyOf(
        IReadOnlyList<string> array,
        IReadOnlyList<string> values,
        string configSalt,
        string contextSalt,
        bool negate)
    {
        foreach (var item in array)
        {
            var hash = Hashing.HashComparisonValue(item, configSalt, contextSalt);
            foreach (var v in values)
            {
                if (string.Equals(hash, v, StringComparison.Ordinal))
                {
                    return !negate;
                }
            }
        }

        return negate;
    }

    // -----------------------------------------------------------------------
    // Attribute → typed value (FR-010)
    // -----------------------------------------------------------------------

    /// <summary>Attribute → semver, or a <see cref="ValidationError"/>.</summary>
    public static object AttributeAsSemVer(string attr, object? value)
    {
        if (value is string str)
        {
            var version = Semver.Parse(str.Trim());
            if (version is not null)
            {
                return version;
            }
        }

        return InvalidAttr(attr, $"'{UserAttributeValueToString(value)}' is not a valid semantic version");
    }

    /// <summary>Attribute → number, or a <see cref="ValidationError"/>. Returns boxed double.</summary>
    public static object AttributeAsNumber(string attr, object? value)
    {
        if (TryNumericNonBool(value, out var num))
        {
            return num;
        }

        if (value is string str)
        {
            var parsed = ParseFloatStrict(str.Replace(",", "."));
            if (!double.IsNaN(parsed) || str.Trim() == "NaN")
            {
                return parsed;
            }
        }

        return InvalidAttr(attr, $"'{UserAttributeValueToString(value)}' is not a valid decimal number");
    }

    /// <summary>Attribute → Unix seconds, or a <see cref="ValidationError"/>. Returns boxed double.</summary>
    public static object AttributeAsUnixTimeSeconds(string attr, object? value)
    {
        if (value is DateTime dt)
        {
            return ToUnixSeconds(dt);
        }

        if (value is DateTimeOffset dto)
        {
            return dto.ToUnixTimeMilliseconds() / 1000.0;
        }

        if (TryNumericNonBool(value, out var num))
        {
            return num;
        }

        if (value is string str)
        {
            var parsed = ParseFloatStrict(str.Replace(",", "."));
            if (!double.IsNaN(parsed) || str.Trim() == "NaN")
            {
                return parsed;
            }
        }

        return InvalidAttr(
            attr,
            $"'{UserAttributeValueToString(value)}' is not a valid Unix timestamp "
            + "(number of seconds elapsed since Unix epoch)");
    }

    /// <summary>
    /// Attribute → string array, or a <see cref="ValidationError"/>. A string
    /// attribute is JSON-parsed; the result must be a string array. Returns an
    /// <c>IReadOnlyList&lt;string&gt;</c> on success.
    /// </summary>
    public static object AttributeAsStringArray(string attr, object? value)
    {
        object? arr = value;
        if (value is string str)
        {
            var parsed = TryParseStringArray(str);
            if (parsed is not null)
            {
                arr = parsed;
            }
        }

        if (arr is IReadOnlyList<string> list)
        {
            return list;
        }

        return InvalidAttr(attr, $"'{UserAttributeValueToString(value)}' is not a valid string array");
    }

    // -----------------------------------------------------------------------
    // Comparison value (config operand) → typed value, with the same
    // three-valued error outcome (validation-order parity, #509).
    // configcat-common validates the CONFIG comparison value BEFORE the user
    // attribute for the semver relations, number relations, and datetime
    // comparators; a malformed operand surfaces a distinct
    // "comparison value '<v>' is invalid (<reason>)" error, which wins even
    // when the user attribute is ALSO malformed.
    // -----------------------------------------------------------------------

    /// <summary>
    /// Comparison value → semver (config operand for the semver relations).
    /// Returns the parsed <see cref="Semver"/> or a
    /// <see cref="ComparisonValueError"/>. The operand is trimmed before
    /// parsing (parity with <see cref="EvaluateSemVerRelation"/>).
    /// </summary>
    public static object ComparisonValueAsSemVer(string value)
    {
        var version = Semver.Parse(value.Trim());
        if (version is not null)
        {
            return version;
        }

        return InvalidComparisonValue(value, $"'{value}' is not a valid semantic version");
    }

    /// <summary>
    /// Comparison value → number (config operand for the number relations).
    /// Returns the boxed double or a <see cref="ComparisonValueError"/>.
    /// </summary>
    public static object ComparisonValueAsNumber(double? value)
    {
        if (value is not null && !double.IsNaN(value.Value))
        {
            return value.Value;
        }

        return InvalidComparisonValue(
            value is null ? "undefined" : NumberToCanonicalString(value.Value),
            $"'{(value is null ? "undefined" : NumberToCanonicalString(value.Value))}' is not a valid decimal number");
    }

    /// <summary>
    /// Comparison value → Unix seconds (config operand for the datetime
    /// comparators). Returns the boxed double or a
    /// <see cref="ComparisonValueError"/>.
    /// </summary>
    public static object ComparisonValueAsUnixTimeSeconds(double? value)
    {
        if (value is not null && !double.IsNaN(value.Value))
        {
            return value.Value;
        }

        var rendered = value is null ? "undefined" : NumberToCanonicalString(value.Value);
        return InvalidComparisonValue(
            rendered,
            $"'{rendered}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)");
    }

    // -----------------------------------------------------------------------
    // JS Number.toString canonicalisation
    // -----------------------------------------------------------------------

    /// <summary>
    /// Stringify a number as ConfigCat's canonical string (JS
    /// <c>Number.toString</c>). NaN / ±Infinity print as "NaN" / "Infinity" /
    /// "-Infinity"; otherwise the SHORTEST round-tripping digit sequence,
    /// fixed-point unless the magnitude warrants exponential.
    /// </summary>
    public static string NumberToCanonicalString(double value)
    {
        if (double.IsNaN(value))
        {
            return "NaN";
        }

        if (double.IsPositiveInfinity(value))
        {
            return "Infinity";
        }

        if (double.IsNegativeInfinity(value))
        {
            return "-Infinity";
        }

        if (value == 0.0)
        {
            return "0";
        }

        return JsNumberToString(value);
    }

    private static string JsNumberToString(double value)
    {
        var sign = value < 0 ? "-" : string.Empty;
        var av = Math.Abs(value);
        var (digits, point) = ShortestDigitsAndPoint(av);
        var k = digits.Length;
        var n = point;

        if (n >= k && n <= 21)
        {
            return sign + digits + new string('0', n - k);
        }

        if (n > 0 && n <= 21)
        {
            return sign + digits.Substring(0, n) + "." + digits.Substring(n);
        }

        if (n > -6 && n <= 0)
        {
            return sign + "0." + new string('0', -n) + digits;
        }

        var e = n - 1;
        var expSign = e >= 0 ? "+" : "-";
        var mant = k == 1 ? digits : digits[0] + "." + digits.Substring(1);
        return sign + mant + "e" + expSign + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
    }

    private static (string Digits, int Point) ShortestDigitsAndPoint(double av)
    {
        // .NET Core 3.0+ default ToString() produces the shortest round-
        // trippable representation, matching JS's shortest repr.
        var shortest = av.ToString("R", CultureInfo.InvariantCulture);
        string mant;
        int expVal;

        // CA1846/CA1870 justified-suppress: a cached SearchValues / AsSpan
        // rewrite buys nothing here — this is a cold canonicalisation path over
        // a two-char marker set, and the parsed substrings flow into string
        // arithmetic, not a span pipeline. Clarity over micro-optimisation.
#pragma warning disable CA1846, CA1870
        var eIdx = shortest.IndexOfAny(ExponentMarkers);
        if (eIdx >= 0)
        {
            mant = shortest.Substring(0, eIdx);
            expVal = int.Parse(shortest.Substring(eIdx + 1), NumberStyles.Integer, CultureInfo.InvariantCulture);
        }
        else
        {
            mant = shortest;
            expVal = 0;
        }
#pragma warning restore CA1846, CA1870

        string intPart;
        string fracPart;
        var dotIdx = mant.IndexOf('.');
        if (dotIdx >= 0)
        {
            intPart = mant.Substring(0, dotIdx);
            fracPart = mant.Substring(dotIdx + 1);
        }
        else
        {
            intPart = mant;
            fracPart = string.Empty;
        }

        var raw = intPart + fracPart;
        var point = intPart.Length + expVal;

        // Strip leading zeros (adjusting point), then trailing zeros.
        var lead = 0;
        while (lead < raw.Length - 1 && raw[lead] == '0')
        {
            lead++;
            point--;
        }

        raw = raw.Substring(lead).TrimEnd('0');
        if (raw.Length == 0)
        {
            raw = "0";
        }

        return (raw, point);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static ValidationError InvalidAttr(string attr, string reason) =>
        new($"cannot evaluate, the User.{attr} attribute is invalid ({reason})", attr, reason);

    private static ComparisonValueError InvalidComparisonValue(string value, string reason) =>
        new($"comparison value '{value}' is invalid ({reason})");

    private static bool TryNumericNonBool(object? value, out double result)
    {
        switch (value)
        {
            case double d:
                result = d;
                return true;
            case float f:
                result = f;
                return true;
            case int i:
                result = i;
                return true;
            case long l:
                result = l;
                return true;
            default:
                result = 0;
                return false;
        }
    }

    private static double ToUnixSeconds(DateTime dt)
    {
        var utc = dt.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(dt, DateTimeKind.Utc)
            : dt.ToUniversalTime();
        return (utc - UnixEpochUtc).TotalSeconds;
    }

    private static bool OrdinalContains(string haystack, string needle) =>
#if NETSTANDARD2_0
        // string.Contains(string, StringComparison) is unavailable on ns2.0.
#pragma warning disable CA2249
        haystack.IndexOf(needle, StringComparison.Ordinal) >= 0;
#pragma warning restore CA2249
#else
        haystack.Contains(needle, StringComparison.Ordinal);
#endif

    private static List<string>? TryParseStringArray(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var list = new List<string>();
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String)
                {
                    return null;
                }

                list.Add(item.GetString() ?? string.Empty);
            }

            return list;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string JsonArray(IReadOnlyList<string> arr)
    {
        // Compact JSON with unescaped slashes + unicode (matches the TS
        // reference's JSON.stringify of a string array).
        var sb = new StringBuilder();
        sb.Append('[');
        for (var i = 0; i < arr.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }

            sb.Append(JsonStringEscape(arr[i]));
        }

        sb.Append(']');
        return sb.ToString();
    }

    private static string JsonStringEscape(string s)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '\b':
                    sb.Append("\\b");
                    break;
                case '\f':
                    sb.Append("\\f");
                    break;
                case '\n':
                    sb.Append("\\n");
                    break;
                case '\r':
                    sb.Append("\\r");
                    break;
                case '\t':
                    sb.Append("\\t");
                    break;
                default:
                    if (ch < 0x20)
                    {
                        sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(ch);
                    }

                    break;
            }
        }

        sb.Append('"');
        return sb.ToString();
    }
}
