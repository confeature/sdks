// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using Confeature.Client.Internal;
using Confeature.Client.Tests.TestUtils;
using Xunit;

namespace Confeature.Client.Tests;

/// <summary>
/// ConfigCat conformance gate (spec 122, SC-001) — the .NET engine replays the
/// vendored upstream evaluation matrix. Mirrors the spec-117 TS reference
/// suite (<c>packages/sdk-shared/tests/parity-upstream.test.ts</c>) and the
/// spec-118/119/120/121 Python / Go / Ruby / PHP ports (PHP is closest — same
/// corpus harness shape). The corpus
/// (<c>packages/test-fixtures-sdk-parity/fixtures/upstream/</c>, anchor
/// <c>configcat/go-sdk@08c4882</c> v9 — see <c>fixtures/upstream/PROVENANCE.md</c>)
/// is the oracle: each <c>(config, key, user) → expected</c> tuple is checked
/// against <see cref="Evaluator.EvaluateCore"/>'s value (and variationId for
/// the variation-id matrix).
/// </summary>
/// <remarks>
/// <para>
/// Scope = the full conformance surface: US1 targeting rules, US2 the 36
/// comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
/// multilevel + circular detection) / AND-groups, US5 attribute conversion +
/// trimming + typed-attribute validation + variationId / matched detail. Per
/// FR-018 only structured value / identity is asserted — never a textual trace.
/// </para>
/// <para>
/// The loaders port <c>packages/test-fixtures-sdk-parity/src/upstream-corpus.ts</c>
/// faithfully — most critically the Go <c>csv.Reader</c> LazyQuotes semantics
/// (a <c>"</c> only opens a quoted field at the field start), without which
/// every JSON-array attribute cell is corrupted. The CSV is parsed by a
/// hand-rolled LazyQuotes reader rather than a library.
/// </para>
/// <para>
/// Custom attributes are fed through <see cref="CorpusUser"/> (a typed value
/// object the evaluator reads duck-typed via <see cref="IEvalUser"/>) so the
/// conversion-driver cases can deliver numbers / arrays / epochs
/// un-stringified — the public <see cref="User"/> stringifies custom values by
/// contract, which would defeat those cases.
/// </para>
/// </remarks>
public class EvaluatorUpstreamCorpusTests
{
    private const string NullToken = "##null##";

    private const string Pkd = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/";
    private const string Jcp = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/";

    /// <summary>
    /// <c>dependentFeatureMultipleLevels</c> is the ONE corpus case whose config
    /// blob was NOT captured by the spec-117 vendoring (known DATA gap #401, not
    /// an engine gap). The multilevel-prerequisite path IS exercised by the
    /// 3-level circular_dep chain + the reconstructed-chain test below. Excluded
    /// LOUDLY (the same marker the TS / Python / Ruby / PHP references use),
    /// never silently.
    /// </summary>
    private static readonly string[] UnvendoredEvalLogKeys = { "dependentFeatureMultipleLevels" };

    private static readonly Dictionary<string, MatrixEntry> MatrixMap = new(StringComparer.Ordinal)
    {
        ["testmatrix.csv"] = new(Pkd + "AG6C1ngVb0CvM07un6JisQ", MatrixKind.Value),
        ["testmatrix_semantic.csv"] = new(Pkd + "iV8vH2MBakKxkFZylxHmTg", MatrixKind.Value),
        ["testmatrix_number.csv"] = new(Pkd + "FCWN-k1dV0iBf8QZrDgjdw", MatrixKind.Value),
        ["testmatrix_semantic_2.csv"] = new(Pkd + "U8nt3zEhDEO5S2ulubCopA", MatrixKind.Value),
        ["testmatrix_sensitive.csv"] = new(Pkd + "-0YmVOUNgEGKkgRF-rU65g", MatrixKind.Value),
        ["testmatrix_segments_old.csv"] = new(Pkd + "y_ZB7o-Xb0Swxth-ZlMSeA", MatrixKind.Value),
        ["testmatrix_and_or.csv"] = new(Jcp + "ByMO9yZNn02kXcm72lnY1A", MatrixKind.Value),
        ["testmatrix_comparators_v6.csv"] = new(Jcp + "OfQqcTjfFUGBwMKqtyEOrQ", MatrixKind.Value),
        ["testmatrix_prerequisite_flag.csv"] = new(Jcp + "JoGwdqJZQ0K2xDy7LnbyOg", MatrixKind.Value),
        ["testmatrix_segments.csv"] = new(Jcp + "h99HYXWWNE2bH8eWyLAVMA", MatrixKind.Value),
        ["testmatrix_unicode.csv"] = new(Jcp + "Da6w8dBbmUeMUBhh0iEeQQ", MatrixKind.Value),
        ["testmatrix_variationId.csv"] = new(Pkd + "spQnkRTIPEWVivZkWM84lQ", MatrixKind.Variation),
    };

    private enum MatrixKind
    {
        Value,
        Variation,
    }

    // -----------------------------------------------------------------------
    // Cached config loaders (parsed once, shared across theory cases).
    // -----------------------------------------------------------------------

    private static readonly Lazy<JsonDocument> ContentByKeyDoc =
        new(() => JsonDocument.Parse(WorkspaceRoot.UpstreamText("content-by-key.json")));

    private static readonly Lazy<JsonDocument> EvalLogConfigsDoc =
        new(() => JsonDocument.Parse(WorkspaceRoot.UpstreamText("evaluationlog/_configs-by-key.json")));

    private static readonly Dictionary<string, IReadOnlyDictionary<string, Setting>?> SettingsCache =
        new(StringComparer.Ordinal);

    private static readonly object CacheLock = new();

    private static IReadOnlyDictionary<string, Setting>? ConfigBySdkKey(string sdkKey)
    {
        lock (CacheLock)
        {
            if (SettingsCache.TryGetValue(sdkKey, out var cached))
            {
                return cached;
            }

            JsonElement blob;
            if (ContentByKeyDoc.Value.RootElement.TryGetProperty(sdkKey, out var fromContent))
            {
                blob = fromContent;
            }
            else if (EvalLogConfigsDoc.Value.RootElement.TryGetProperty(sdkKey, out var fromEval))
            {
                blob = fromEval;
            }
            else
            {
                throw new InvalidOperationException($"No config for sdkKey {sdkKey}");
            }

            var parsed = ConfigParser.Parse(blob);
            SettingsCache[sdkKey] = parsed;
            return parsed;
        }
    }

    private static IReadOnlyDictionary<string, Setting>? ConfigFromOverride(string fileName)
    {
        var key = "override:" + fileName;
        lock (CacheLock)
        {
            if (SettingsCache.TryGetValue(key, out var cached))
            {
                return cached;
            }

            using var doc = JsonDocument.Parse(WorkspaceRoot.UpstreamText("evaluationlog/_overrides/" + fileName));
            var parsed = ConfigParser.Parse(doc.RootElement);
            SettingsCache[key] = parsed;
            return parsed;
        }
    }

    private static IReadOnlyDictionary<string, Setting>? ComparisonConfig(string fixture)
    {
        var key = "cmp:" + fixture;
        lock (CacheLock)
        {
            if (SettingsCache.TryGetValue(key, out var cached))
            {
                return cached;
            }

            using var doc = JsonDocument.Parse(WorkspaceRoot.UpstreamText(fixture + ".json"));
            var parsed = ConfigParser.Parse(doc.RootElement);
            SettingsCache[key] = parsed;
            return parsed;
        }
    }

    private static int? SettingType(IReadOnlyDictionary<string, Setting>? settings, string key) =>
        settings is not null && settings.TryGetValue(key, out var s) && s is not null ? s.T : null;

    // -----------------------------------------------------------------------
    // CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port). A
    // `"` only opens a quoted field when it is the FIRST char of the field;
    // anywhere else it is a literal quote. Getting this wrong corrupts every
    // JSON-array attribute cell.
    // -----------------------------------------------------------------------

    private static List<string> ParseCsvLine(string line)
    {
        var fields = new List<string>();
        var field = new StringBuilder();
        var inQuotes = false;
        var fieldStart = true;
        var n = line.Length;
        for (var i = 0; i < n; i++)
        {
            var ch = line[i];
            if (inQuotes && ch == '"' && i + 1 < n && line[i + 1] == '"')
            {
                field.Append('"');
                i++;
            }
            else if (inQuotes && ch == '"')
            {
                inQuotes = false;
            }
            else if (inQuotes)
            {
                field.Append(ch);
            }
            else if (ch == '"' && fieldStart)
            {
                inQuotes = true;
                fieldStart = false;
            }
            else if (ch == ';')
            {
                fields.Add(field.ToString());
                field.Clear();
                fieldStart = true;
            }
            else
            {
                field.Append(ch);
                fieldStart = false;
            }
        }

        fields.Add(field.ToString());
        return fields;
    }

    /// <summary>Parse a CSV cell to its primitive (mirrors upstream <c>parseCell</c>).</summary>
    private static object ParseCell(string s)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(s, "^-?[0-9]+$")
            && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)
            && Math.Abs(n) <= 9007199254740991L
            && n.ToString(CultureInfo.InvariantCulture) == s)
        {
            // Guard against a silent int overflow: a value outside the Int32
            // range would wrap when cast to int, masking a real corpus
            // mismatch. Return it as long so the numeric-tolerant comparer
            // still handles it correctly. The JS-safe-integer ceiling above
            // is preserved.
            if (n < int.MinValue || n > int.MaxValue)
            {
                return n;
            }

            return (int)n;
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(s, @"^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$")
            && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
        {
            return d;
        }

        if (s == "True")
        {
            return true;
        }

        if (s == "False")
        {
            return false;
        }

        return s;
    }

    private static CorpusUser? UserFromRow(List<string> line, string customKey)
    {
        if (line.Count == 0 || line[0] == NullToken)
        {
            return null;
        }

        static string? SetOrNull(string? v) =>
            v is null || v.Length == 0 || v == NullToken ? null : v;

        var identifier = line.Count > 0 ? line[0] : string.Empty;
        var email = SetOrNull(line.Count > 1 ? line[1] : null);
        var country = SetOrNull(line.Count > 2 ? line[2] : null);
        var customVal = SetOrNull(line.Count > 3 ? line[3] : null);
        Dictionary<string, object?>? custom =
            customVal is null ? null : new Dictionary<string, object?>(StringComparer.Ordinal) { [customKey] = customVal };

        return new CorpusUser(identifier, email, country, custom);
    }

    private sealed record MatrixTuple(
        string Matrix,
        string Key,
        CorpusUser? User,
        MatrixKind Kind,
        object? Expected,
        IReadOnlyDictionary<string, Setting>? Settings);

    private static List<MatrixTuple> LoadMatrix(string matrix)
    {
        if (!MatrixMap.TryGetValue(matrix, out var entry))
        {
            throw new InvalidOperationException($"Unknown testmatrix file: {matrix}");
        }

        var settings = ConfigBySdkKey(entry.SdkKey);
        var text = WorkspaceRoot.UpstreamText(matrix);
        var lines = text.Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .Where(l => l.Length > 0)
            .ToList();

        var header = ParseCsvLine(lines[0]);
        var customKey = header.Count > 3 ? header[3] : "Custom1";
        var settingKeys = header.Skip(4).ToList();

        var tuples = new List<MatrixTuple>();
        for (var r = 1; r < lines.Count; r++)
        {
            var cols = ParseCsvLine(lines[r]);
            var user = UserFromRow(cols, customKey);
            for (var c = 0; c < settingKeys.Count; c++)
            {
                var raw = (c + 4) < cols.Count ? cols[c + 4] : string.Empty;
                object? expected = entry.Kind == MatrixKind.Value ? ParseCell(raw) : raw;
                tuples.Add(new MatrixTuple(matrix, settingKeys[c], user, entry.Kind, expected, settings));
            }
        }

        return tuples;
    }

    // -----------------------------------------------------------------------
    // evaluationlog/<scenario> (port loadEvalLogScenario).
    // -----------------------------------------------------------------------

    private static CorpusUser? EvalLogUser(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var identifier = string.Empty;
        string? email = null;
        string? country = null;
        var custom = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var prop in raw.EnumerateObject())
        {
            switch (prop.Name)
            {
                case "Identifier":
                    identifier = prop.Value.GetString() ?? string.Empty;
                    break;
                case "Email":
                    email = prop.Value.GetString();
                    break;
                case "Country":
                    country = prop.Value.GetString();
                    break;
                default:
                    // Custom attributes keep their native JSON-decoded type so a
                    // numeric / bool / array custom attr reaches the comparator
                    // un-stringified (exercises CorpusUser's native-typed branch).
                    custom[prop.Name] = JsonValueToNative(prop.Value);
                    break;
            }
        }

        return new CorpusUser(identifier, email, country, custom.Count == 0 ? null : custom);
    }

    private static object? JsonValueToNative(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.String:
                return el.GetString();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                return el.GetDouble();
            case JsonValueKind.Array:
                {
                    var list = new List<string>();
                    foreach (var item in el.EnumerateArray())
                    {
                        list.Add(item.GetString() ?? string.Empty);
                    }

                    return list;
                }

            default:
                return null;
        }
    }

    private sealed record EvalLogTuple(
        string Scenario,
        string Key,
        JsonElement? DefaultValue,
        CorpusUser? User,
        object? ExpectedValue,
        IReadOnlyDictionary<string, Setting>? Settings);

    private static IReadOnlyDictionary<string, Setting>? EvalLogConfig(JsonElement suite)
    {
        if (suite.TryGetProperty("jsonOverride", out var jo) && jo.ValueKind == JsonValueKind.String)
        {
            return ConfigFromOverride(jo.GetString()!);
        }

        if (suite.TryGetProperty("sdkKey", out var sk) && sk.ValueKind == JsonValueKind.String)
        {
            return ConfigBySdkKey(sk.GetString()!);
        }

        throw new InvalidOperationException("Eval-log suite has neither jsonOverride nor sdkKey");
    }

    private static List<EvalLogTuple> LoadEvalLogScenario(string scenario)
    {
        using var doc = JsonDocument.Parse(WorkspaceRoot.UpstreamText($"evaluationlog/{scenario}.json"));
        var suite = doc.RootElement;
        var settings = EvalLogConfig(suite);

        var tuples = new List<EvalLogTuple>();
        if (suite.TryGetProperty("tests", out var tests) && tests.ValueKind == JsonValueKind.Array)
        {
            foreach (var t in tests.EnumerateArray())
            {
                if (t.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var key = t.TryGetProperty("key", out var k) ? k.GetString() ?? string.Empty : string.Empty;
                JsonElement? dv = t.TryGetProperty("defaultValue", out var dvEl) ? dvEl.Clone() : null;
                var user = t.TryGetProperty("user", out var u) ? EvalLogUser(u) : null;
                object? expected = t.TryGetProperty("returnValue", out var rv) ? JsonExpected(rv) : null;
                tuples.Add(new EvalLogTuple(scenario, key, dv, user, expected, settings));
            }
        }

        return tuples;
    }

    private static object? JsonExpected(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.String:
                return el.GetString();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                if (el.TryGetInt32(out var i) && el.GetRawText().IndexOf('.') < 0)
                {
                    return i;
                }

                return el.GetDouble();
            default:
                return null;
        }
    }

    // -----------------------------------------------------------------------
    // Default selection + tolerant equality (mirror PHP).
    // -----------------------------------------------------------------------

    private static object? DefaultFor(object? expected, int? settingType)
    {
        if (expected is bool)
        {
            return false;
        }

        if (expected is int || expected is double)
        {
            return settingType == Evaluator.SettingTypeDouble ? (object)0.0 : 0;
        }

        return "__default__";
    }

    private static object? CoerceJsonDefault(JsonElement dv, int? settingType, object? expected)
    {
        switch (dv.ValueKind)
        {
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.String:
                return dv.GetString();
            case JsonValueKind.Number:
                if (settingType == Evaluator.SettingTypeDouble)
                {
                    return dv.GetDouble();
                }

                if (settingType == Evaluator.SettingTypeInt)
                {
                    return dv.GetInt32();
                }

                // No declared type guidance — fall back to the expected shape.
                return expected is double ? (object)dv.GetDouble() : dv.GetInt32();
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                return DefaultFor(expected, settingType);
            default:
                return DefaultFor(expected, settingType);
        }
    }

    private static bool ValueEqual(object? actual, object? expected)
    {
        if (expected is int or double && expected is not bool)
        {
            if (actual is bool)
            {
                return false;
            }

            var ed = Convert.ToDouble(expected, CultureInfo.InvariantCulture);
            if (double.IsNaN(ed))
            {
                return actual is double ad && double.IsNaN(ad);
            }

            if (actual is int or double)
            {
                return Convert.ToDouble(actual, CultureInfo.InvariantCulture) == ed;
            }

            return false;
        }

        if (expected is bool != actual is bool)
        {
            return false;
        }

        return Equals(actual, expected);
    }

    private static string Repr(object? v) => v switch
    {
        null => "null",
        string s => $"\"{s}\"",
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString() ?? "?",
    };

    private static string UserRepr(CorpusUser? u) => u is null
        ? "null"
        : $"id={Repr(u.Identifier)} email={Repr(u.Email)} country={Repr(u.Country)}";

    private static EvaluationResult Eval(
        IReadOnlyDictionary<string, Setting>? settings,
        string key,
        object? defaultValue,
        CorpusUser? user) =>
        Evaluator.EvaluateCore(settings, key, defaultValue, user);

    private static void AssertMatrixTuple(MatrixTuple t, List<string> failures)
    {
        var label = $"{t.Matrix} {t.Key} user={UserRepr(t.User)}";
        if (t.Kind == MatrixKind.Variation)
        {
            var r = Eval(t.Settings, t.Key, null, t.User);
            if (!string.Equals(r.VariationId, (string?)t.Expected, StringComparison.Ordinal))
            {
                failures.Add($"{label}: actual={Repr(r.VariationId)} expected={Repr(t.Expected)}");
            }

            return;
        }

        var def = DefaultFor(t.Expected, SettingType(t.Settings, t.Key));
        var result = Eval(t.Settings, t.Key, def, t.User);
        if (!ValueEqual(result.Value, t.Expected))
        {
            failures.Add($"{label}: actual={Repr(result.Value)} expected={Repr(t.Expected)}");
        }
    }

    private static void AssertEvalLogValue(EvalLogTuple t, List<string> failures)
    {
        var settingType = SettingType(t.Settings, t.Key);
        var def = t.DefaultValue is null
            ? DefaultFor(t.ExpectedValue, settingType)
            : CoerceJsonDefault(t.DefaultValue.Value, settingType, t.ExpectedValue);
        var label = $"{t.Scenario} {t.Key} user={UserRepr(t.User)}";
        var result = Eval(t.Settings, t.Key, def, t.User);
        if (!ValueEqual(result.Value, t.ExpectedValue))
        {
            failures.Add($"{label}: actual={Repr(result.Value)} expected={Repr(t.ExpectedValue)}");
        }
    }

    // =======================================================================
    // US1 / US2 — value + comparator matrices
    // =======================================================================

    public static IEnumerable<object[]> ValueMatrices() => new[]
    {
        new object[] { "testmatrix.csv" },
        new object[] { "testmatrix_comparators_v6.csv" },
        new object[] { "testmatrix_semantic.csv" },
        new object[] { "testmatrix_semantic_2.csv" },
        new object[] { "testmatrix_number.csv" },
        new object[] { "testmatrix_sensitive.csv" },
        new object[] { "testmatrix_unicode.csv" },
    };

    [Theory]
    [MemberData(nameof(ValueMatrices))]
    public void ValueMatrices_match(string matrix)
    {
        var tuples = LoadMatrix(matrix);
        Assert.True(tuples.Count > 0, $"{matrix} produced no tuples");
        var failures = new List<string>();
        foreach (var t in tuples)
        {
            AssertMatrixTuple(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    // =======================================================================
    // US1 — targeting-rule eval-log scenarios
    // =======================================================================

    public static IEnumerable<object[]> TargetingRuleScenarios() => new[]
    {
        new object[] { "1_targeting_rule" },
        new object[] { "2_targeting_rules" },
        new object[] { "simple_value" },
    };

    [Theory]
    [MemberData(nameof(TargetingRuleScenarios))]
    public void TargetingRuleScenarios_match(string scenario)
    {
        var failures = new List<string>();
        var tuples = LoadEvalLogScenario(scenario);
        Assert.True(tuples.Count > 0, $"{scenario} produced no tuples");
        foreach (var t in tuples)
        {
            AssertEvalLogValue(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    [Fact]
    public void MatchedTargetingRule_is_reported()
    {
        var cases = LoadEvalLogScenario("1_targeting_rule");
        var matching = cases.First(c => Equals(c.ExpectedValue, "Dog"));
        var result = Eval(matching.Settings, matching.Key, "default", matching.User);
        Assert.Equal("Dog", result.Value);
        Assert.True(result.MatchedRule);
        Assert.False(result.MatchedOption);
        Assert.Equal("d0cd8f06", result.VariationId);
    }

    [Fact]
    public void NoUser_serves_fallback_with_reason_and_never_throws()
    {
        var cases = LoadEvalLogScenario("1_targeting_rule");
        var noUser = cases.First(c => c.User is null);
        var result = Eval(noUser.Settings, noUser.Key, "default", null);
        Assert.Equal("Cat", result.Value); // fallback
        Assert.Equal(EvaluationError.None, result.Error); // a value was cleanly resolved
        Assert.NotNull(result.EvalError);
        Assert.Contains("User Object is missing", result.EvalError);
        Assert.False(result.MatchedRule);
    }

    // =======================================================================
    // US3 — percentage rollout
    // =======================================================================

    public static IEnumerable<object[]> PercentageScenarios() => new[]
    {
        new object[] { "options_based_on_user_id" },
        new object[] { "options_based_on_custom_attr" },
        new object[] { "options_after_targeting_rule" },
        new object[] { "options_within_targeting_rule" },
    };

    [Theory]
    [MemberData(nameof(PercentageScenarios))]
    public void PercentageScenarios_match(string scenario)
    {
        var failures = new List<string>();
        var tuples = LoadEvalLogScenario(scenario);
        Assert.True(tuples.Count > 0, $"{scenario} produced no tuples");
        foreach (var t in tuples)
        {
            AssertEvalLogValue(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    [Fact]
    public void PercentageBucketing_is_deterministic()
    {
        var cases = LoadEvalLogScenario("options_based_on_user_id");
        var withUser = cases.First(c => c.User is not null);
        var first = Eval(withUser.Settings, withUser.Key, "default", withUser.User);
        for (var i = 0; i < 20; i++)
        {
            var again = Eval(withUser.Settings, withUser.Key, "default", withUser.User);
            Assert.Equal(first.Value, again.Value); // repeat-invariant
            Assert.Equal(first.VariationId, again.VariationId);
        }

        Assert.True(ValueEqual(first.Value, withUser.ExpectedValue));
        Assert.True(first.MatchedOption);
    }

    // =======================================================================
    // US4 — segments / prerequisites / AND-OR matrices + scenarios
    // =======================================================================

    public static IEnumerable<object[]> Us4Matrices() => new[]
    {
        new object[] { "testmatrix_and_or.csv" },
        new object[] { "testmatrix_segments.csv" },
        new object[] { "testmatrix_segments_old.csv" },
        new object[] { "testmatrix_prerequisite_flag.csv" },
    };

    [Theory]
    [MemberData(nameof(Us4Matrices))]
    public void Us4Matrices_match(string matrix)
    {
        var tuples = LoadMatrix(matrix);
        Assert.True(tuples.Count > 0, $"{matrix} produced no tuples");
        var failures = new List<string>();
        foreach (var t in tuples)
        {
            AssertMatrixTuple(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    public static IEnumerable<object[]> Us4EvalLogScenarios() => new[]
    {
        new object[] { "segment" },
        new object[] { "prerequisite_flag" },
        new object[] { "and_rules" },
    };

    [Theory]
    [MemberData(nameof(Us4EvalLogScenarios))]
    public void Us4EvalLogScenarios_match(string scenario)
    {
        var failures = new List<string>();
        foreach (var t in LoadEvalLogScenario(scenario))
        {
            if (UnvendoredEvalLogKeys.Contains(t.Key))
            {
                continue;
            }

            AssertEvalLogValue(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    // -----------------------------------------------------------------------
    // Evaluation-log TRACE fidelity (ADR 0003 / epic #494, #501 .NET slice).
    //
    // Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
    // (the cross-language byte-oracle; each tuple carries a Confeature-canonical
    // expectedTrace) through Evaluator.EvaluateCoreTraced and asserts the emitted
    // trace is byte-identical. Mirrors the Go / Python / Rust ports. The corpus
    // carries a self-contained config per tuple, so the multilevel-prerequisite
    // case IS covered here (no vendoring carve-out needed).
    // -----------------------------------------------------------------------

    private static readonly string[] TraceScenarios =
    {
        "simple_value",
        "1_targeting_rule",
        "2_targeting_rules",
        "and_rules",
        "options_based_on_user_id",
        "options_based_on_custom_attr",
        "options_after_targeting_rule",
        "options_within_targeting_rule",
        "list_truncation",
        "number_validation",
        "circular_dep",
        "prerequisite_flag",
        "semver_validation",
        "epoch_date_validation",
    };

    [Fact]
    public void EvalLogTraceFidelity_byte_identical()
    {
        var path = System.IO.Path.Combine(
            WorkspaceRoot.Path,
            "packages",
            "test-fixtures-sdk-parity",
            "fixtures",
            "parity-evaluationlog.json");
        using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(path));
        var tuples = doc.RootElement;
        Assert.True(
            tuples.ValueKind == JsonValueKind.Array && tuples.GetArrayLength() > 0,
            "parity-evaluationlog.json produced no tuples");

        var scenarioSet = new HashSet<string>(TraceScenarios, StringComparer.Ordinal);
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        var failures = new List<string>();

        foreach (var t in tuples.EnumerateArray())
        {
            if (!t.TryGetProperty("expectedTrace", out var expectedEl)
                || expectedEl.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var scenario = t.TryGetProperty("scenario", out var sc) ? sc.GetString() ?? string.Empty : string.Empty;
            if (!scenarioSet.Contains(scenario))
            {
                continue;
            }

            var key = t.TryGetProperty("key", out var k) ? k.GetString() ?? string.Empty : string.Empty;
            var settings = ConfigParser.Parse(t.GetProperty("config"));
            var settingType = SettingType(settings, key);
            object? def = t.TryGetProperty("defaultValue", out var dvEl)
                ? CoerceJsonDefault(dvEl, settingType, null)
                : null;
            var user = t.TryGetProperty("user", out var u) ? TraceUser(u) : null;

            var sink = new CaptureSink();
            Evaluator.EvaluateCoreTraced(settings, key, def, user, sink);
            var actual = sink.Render();
            var expected = expectedEl.GetString() ?? string.Empty;

            seen[scenario] = seen.TryGetValue(scenario, out var c) ? c + 1 : 1;
            if (actual != expected)
            {
                failures.Add($"trace mismatch for {scenario}/{key}\n--- want ---\n{expected}\n--- got ---\n{actual}");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n\n", failures));

        // Every trace-bearing scenario must have asserted >=1 tuple (guards a
        // silently shrinking oracle / a renamed scenario).
        foreach (var scenario in TraceScenarios)
        {
            Assert.True(
                seen.GetValueOrDefault(scenario) > 0,
                $"trace scenario '{scenario}' carried no asserted tuples");
        }
    }

    /// <summary>
    /// Build a <see cref="CorpusUser"/> from the corpus tuple's LOWERCASE user
    /// object (<c>{identifier, email?, country?, custom?}</c>) — the shape the
    /// Go/Python/Rust trace tests consume. Custom values keep their native type.
    /// </summary>
    private static CorpusUser? TraceUser(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var identifier = string.Empty;
        string? email = null;
        string? country = null;
        var custom = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var prop in raw.EnumerateObject())
        {
            switch (prop.Name)
            {
                case "identifier":
                    identifier = prop.Value.GetString() ?? string.Empty;
                    break;
                case "email":
                    email = prop.Value.GetString();
                    break;
                case "country":
                    country = prop.Value.GetString();
                    break;
                case "custom":
                    if (prop.Value.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var c in prop.Value.EnumerateObject())
                        {
                            custom[c.Name] = JsonValueToNative(c.Value);
                        }
                    }

                    break;
                default:
                    break;
            }
        }

        return new CorpusUser(identifier, email, country, custom.Count == 0 ? null : custom);
    }

    /// <summary>
    /// INFO-level eval-log capture sink: records each emitted
    /// <c>(level, eventId, message)</c> and renders the byte-string the parity
    /// oracle uses (<c>"&lt;LEVEL&gt;: [&lt;eventId&gt;] &lt;message&gt;"</c> per call, "\n"-joined).
    /// </summary>
    private sealed class CaptureSink : IEvalTraceSink
    {
        private readonly List<(EvalTraceLevel Level, string EventId, string Message)> _calls = new();

        public EvalTraceLevel Level => EvalTraceLevel.Info;

        public void Log(EvalTraceLevel level, string eventId, string message) =>
            _calls.Add((level, eventId, message));

        public string Render() =>
            string.Join("\n", _calls.Select(c => $"{Label(c.Level)}: [{c.EventId}] {c.Message}"));

        private static string Label(EvalTraceLevel level) => level switch
        {
            EvalTraceLevel.Error => "ERROR",
            EvalTraceLevel.Warn => "WARN",
            EvalTraceLevel.Info => "INFO",
            EvalTraceLevel.Debug => "DEBUG",
            _ => "?",
        };
    }

    [Fact]
    public void MultilevelPrerequisite_resolves_through_reconstructed_chain()
    {
        // Reconstructed from evaluationlog/prerequisite_flag (its config blob
        // was not vendored, #401). Proves the engine recurses A → B → C.
        const string json = """
        {
          "p": { "u": "", "r": 0, "s": "salt" },
          "s": [],
          "f": {
            "mainFeatureWithoutUserCondition": { "t": 0, "v": { "b": true }, "i": "main", "r": [] },
            "intermediateFeature": {
              "t": 0, "v": { "b": false }, "i": "inter",
              "r": [{
                "c": [
                  { "p": { "f": "mainFeatureWithoutUserCondition", "c": 0, "v": { "b": true } } },
                  { "p": { "f": "mainFeatureWithoutUserCondition", "c": 0, "v": { "b": true } } }
                ],
                "s": { "v": { "b": true }, "i": "interT" }
              }]
            },
            "dependentFeatureMultipleLevels": {
              "t": 1, "v": { "s": "Cat" }, "i": "dep",
              "r": [{
                "c": [{ "p": { "f": "intermediateFeature", "c": 0, "v": { "b": true } } }],
                "s": { "v": { "s": "Dog" }, "i": "depDog" }
              }]
            }
          }
        }
        """;
        using var doc = JsonDocument.Parse(json);
        var settings = ConfigParser.Parse(doc.RootElement);
        var result = Eval(settings, "dependentFeatureMultipleLevels", "default", null);
        Assert.Equal("Dog", result.Value);
        Assert.True(result.MatchedRule);
    }

    // =======================================================================
    // US4 — circular-dependency termination (SC-004)
    // =======================================================================

    [Fact]
    public void CircularDepScenarios_bounded_fallback()
    {
        var failures = new List<string>();
        foreach (var t in LoadEvalLogScenario("circular_dep"))
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var result = Eval(t.Settings, t.Key, "default", t.User);
            sw.Stop();
            if (sw.Elapsed.TotalSeconds >= 1.0)
            {
                failures.Add($"{t.Key} took too long ({sw.Elapsed.TotalSeconds}s) — cycle not bounded");
            }

            if (!Equals(result.Value, "default"))
            {
                failures.Add($"{t.Key} value={Repr(result.Value)} (expected fail-closed default)");
            }

            if (result.Error == EvaluationError.None)
            {
                failures.Add($"{t.Key} resolved with no error code");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void DirectTwoFlagCycle_terminates()
    {
        const string json = """
        {
          "p": { "u": "", "r": 0, "s": "salt" },
          "s": [],
          "f": {
            "flagA": {
              "t": 1, "v": { "s": "A" }, "i": "a",
              "r": [{ "c": [{ "p": { "f": "flagB", "c": 0, "v": { "b": true } } }], "s": { "v": { "s": "AA" }, "i": "aa" } }]
            },
            "flagB": {
              "t": 1, "v": { "s": "B" }, "i": "b",
              "r": [{ "c": [{ "p": { "f": "flagA", "c": 0, "v": { "b": true } } }], "s": { "v": { "s": "BB" }, "i": "bb" } }]
            }
          }
        }
        """;
        using var doc = JsonDocument.Parse(json);
        var settings = ConfigParser.Parse(doc.RootElement);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = Eval(settings, "flagA", "default", null);
        sw.Stop();
        Assert.True(sw.Elapsed.TotalSeconds < 1.0, "a direct two-flag cycle must terminate bounded");
        Assert.Equal("default", result.Value);
        Assert.NotEqual(EvaluationError.None, result.Error);
    }

    // =======================================================================
    // US5 — normalization / conversion / trimming (comparison_*.json drivers)
    // =======================================================================

    [Fact]
    public void ComparisonAttributeConversion_matches()
    {
        var settings = ComparisonConfig("comparison_attribute_conversion");
        var driver = new (string Key, object? Custom1, string Expected)[]
        {
            ("numberToStringConversion", 0.12345, "1"),
            ("numberToStringConversionInt", 125.0, "4"),
            ("numberToStringConversionPositiveExp", -1.23456789e96, "2"),
            ("numberToStringConversionNegativeExp", -1.23456789e-96, "4"),
            ("numberToStringConversionNaN", double.NaN, "3"),
            ("numberToStringConversionPositiveInf", double.PositiveInfinity, "4"),
            ("numberToStringConversionNegativeInf", double.NegativeInfinity, "3"),
            ("dateToStringConversion", 1680307199.999, "3"),
            ("dateToStringConversionNaN", double.NaN, "3"),
            ("dateToStringConversionPositiveInf", double.PositiveInfinity, "1"),
            ("dateToStringConversionNegativeInf", double.NegativeInfinity, "5"),
            ("stringArrayToStringConversion", new List<string> { "read", "Write", " eXecute " }, "4"),
            ("stringArrayToStringConversionEmpty", new List<string>(), "5"),
            ("stringArrayToStringConversionSpecialChars", new List<string> { "+<>%\"'\\/\t\r\n" }, "3"),
            ("stringArrayToStringConversionUnicode", new List<string> { "äöüÄÖÜçéèñışğâ¢™✓😀" }, "2"),
        };
        var failures = new List<string>();
        foreach (var (key, custom1, expected) in driver)
        {
            var user = new CorpusUser(
                "12345",
                null,
                null,
                new Dictionary<string, object?>(StringComparer.Ordinal) { ["Custom1"] = custom1 });
            var result = Eval(settings, key, "default", user);
            if (!Equals(result.Value, expected))
            {
                failures.Add($"{key}: actual={Repr(result.Value)} expected={Repr(expected)}");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    /// <summary>
    /// Native-typed custom attributes must reach the numeric comparator
    /// un-stringified and evaluate identically to their string spelling. This
    /// directly exercises CorpusUser's native-numeric branch, not only the
    /// string→double coercion path the matrix CSVs / eval-log scenarios cover.
    /// </summary>
    [Fact]
    public void NativeNumericCustomAttribute_matches_string_form()
    {
        const string json = """
        {
          "p": { "u": "", "r": 0, "s": "salt" },
          "s": [],
          "f": {
            "numericGate": {
              "t": 1, "a": "Custom1", "v": { "s": "no-match" }, "i": "ng",
              "r": [{ "c": [{ "u": { "a": "Custom1", "c": 15, "d": 18.0 } }], "s": { "v": { "s": "match" }, "i": "m" } }]
            }
          }
        }
        """;
        using var doc = JsonDocument.Parse(json);
        var settings = ConfigParser.Parse(doc.RootElement);

        var cases = new (string Label, object? Attr, string Expected)[]
        {
            ("native-int-pass", 21.0, "match"),
            ("native-float-pass", 18.0, "match"),
            ("native-int-fail", 17.0, "no-match"),
            ("native-float-fail", 17.999, "no-match"),
            ("string-int-pass", "21", "match"),
            ("string-float-pass", "18.0", "match"),
            ("string-int-fail", "17", "no-match"),
        };

        var failures = new List<string>();
        foreach (var (label, attr, expected) in cases)
        {
            var user = new CorpusUser(
                "12345",
                null,
                null,
                new Dictionary<string, object?>(StringComparer.Ordinal) { ["Custom1"] = attr });
            var result = Eval(settings, "numericGate", "default", user);
            if (!Equals(result.Value, expected))
            {
                failures.Add($"{label}: actual={Repr(result.Value)} expected={Repr(expected)}");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void ComparisonAttributeTrimming_matches()
    {
        var settings = ComparisonConfig("comparison_attribute_trimming");
        var user = new CorpusUser(
            " 12345 ",
            null,
            "[\" USA \"]",
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["Version"] = " 1.0.0 ",
                ["Number"] = " 3 ",
                ["Date"] = " 1705253400 ",
            });
        var failures = new List<string>();
        foreach (var (key, expected) in TrimmingDriver())
        {
            var result = Eval(settings, key, "default", user);
            if (!Equals(result.Value, expected))
            {
                failures.Add($"{key}: actual={Repr(result.Value)} expected={Repr(expected)}");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void ComparisonValueTrimming_matches()
    {
        var settings = ComparisonConfig("comparison_value_trimming");
        var user = new CorpusUser(
            "12345",
            null,
            "[\"USA\"]",
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["Version"] = "1.0.0",
                ["Number"] = "3",
                ["Date"] = "1705253400",
            });
        var failures = new List<string>();
        foreach (var (key, expected) in ValueTrimmingDriver())
        {
            var result = Eval(settings, key, "default", user);
            if (!Equals(result.Value, expected))
            {
                failures.Add($"{key}: actual={Repr(result.Value)} expected={Repr(expected)}");
            }
        }

        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    // =======================================================================
    // US5 — typed-attribute validation outcomes (FR-010) + list truncation
    // =======================================================================

    public static IEnumerable<object[]> ValidationScenarios() => new[]
    {
        new object[] { "semver_validation" },
        new object[] { "number_validation" },
        new object[] { "epoch_date_validation" },
        new object[] { "list_truncation" },
    };

    [Theory]
    [MemberData(nameof(ValidationScenarios))]
    public void ValidationScenarios_match(string scenario)
    {
        var failures = new List<string>();
        var tuples = LoadEvalLogScenario(scenario);
        Assert.True(tuples.Count > 0, $"{scenario} produced no tuples");
        foreach (var t in tuples)
        {
            AssertEvalLogValue(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    // =======================================================================
    // US5 — variationId + matched rule/option detail (FR-011)
    // =======================================================================

    [Fact]
    public void VariationIdMatrix_matches()
    {
        var tuples = LoadMatrix("testmatrix_variationId.csv");
        Assert.True(tuples.Count > 0);
        var failures = new List<string>();
        foreach (var t in tuples)
        {
            AssertMatrixTuple(t, failures);
        }

        Assert.True(failures.Count == 0, $"{failures.Count} drift:\n{string.Join("\n", failures)}");
    }

    [Fact]
    public void SegmentMatchedFlag_reports_value_and_variationId()
    {
        var cases = LoadEvalLogScenario("segment");
        var match = cases.First(c => c.Key == "featureWithSegmentTargeting" && c.User is not null
            && Equals(c.ExpectedValue, true));
        var result = Eval(match.Settings, match.Key, false, match.User);
        Assert.Equal(true, result.Value);
        Assert.True(result.MatchedRule);
        Assert.NotNull(result.VariationId);
    }

    // -----------------------------------------------------------------------
    // Trimming driver tables (ported verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    private static IEnumerable<(string Key, string Expected)> TrimmingDriver()
    {
        var noTrim = new[]
        {
            "isoneof", "isnotoneof", "isoneofhashed", "isnotoneofhashed", "equalshashed",
            "notequalshashed", "arraycontainsanyofhashed", "arraynotcontainsanyofhashed", "equals",
            "notequals", "startwithanyof", "notstartwithanyof", "endswithanyof", "notendswithanyof",
            "arraycontainsanyof", "arraynotcontainsanyof", "startwithanyofhashed", "notstartwithanyofhashed",
            "endswithanyofhashed", "notendswithanyofhashed",
        };
        foreach (var key in noTrim)
        {
            yield return (key, "no trim");
        }

        var trims = new (string, string)[]
        {
            ("semverisoneof", "4 trim"), ("semverisnotoneof", "5 trim"), ("semverless", "6 trim"),
            ("semverlessequals", "7 trim"), ("semvergreater", "8 trim"), ("semvergreaterequals", "9 trim"),
            ("numberequals", "10 trim"), ("numbernotequals", "11 trim"), ("numberless", "12 trim"),
            ("numberlessequals", "13 trim"), ("numbergreater", "14 trim"), ("numbergreaterequals", "15 trim"),
            ("datebefore", "18 trim"), ("dateafter", "19 trim"),
        };
        foreach (var (key, expected) in trims)
        {
            yield return (key, expected);
        }

        yield return ("containsanyof", "no trim");
        yield return ("notcontainsanyof", "no trim");
    }

    private static IEnumerable<(string Key, string Expected)> ValueTrimmingDriver()
    {
        var noTrim = new[]
        {
            "isoneof", "isnotoneof", "containsanyof", "notcontainsanyof", "isoneofhashed", "isnotoneofhashed",
            "equalshashed", "notequalshashed", "arraycontainsanyofhashed", "arraynotcontainsanyofhashed",
            "equals", "notequals", "startwithanyof", "notstartwithanyof", "endswithanyof", "notendswithanyof",
            "arraycontainsanyof", "arraynotcontainsanyof", "startwithanyofhashed", "notstartwithanyofhashed",
            "endswithanyofhashed", "notendswithanyofhashed",
        };
        foreach (var key in noTrim)
        {
            yield return (key, "no trim");
        }

        var trims = new (string, string)[]
        {
            ("semverisoneof", "4 trim"), ("semverisnotoneof", "5 trim"), ("semverless", "6 trim"),
            ("semverlessequals", "7 trim"), ("semvergreater", "8 trim"), ("semvergreaterequals", "9 trim"),
        };
        foreach (var (key, expected) in trims)
        {
            yield return (key, expected);
        }
    }

    private readonly record struct MatrixEntry(string SdkKey, MatrixKind Kind);
}

/// <summary>
/// Typed targeting-user the evaluator reads duck-typed (spec 122). The public
/// <see cref="User"/> stringifies custom attributes by contract; the
/// conformance corpus must feed them un-stringified (numbers, arrays, epochs),
/// so this implements <see cref="IEvalUser"/> directly. Mirrors the PHP
/// <c>CorpusUser</c> and the TS / Python / Go / Ruby duck-typed user.
/// </summary>
internal sealed class CorpusUser : IEvalUser
{
    private readonly IReadOnlyDictionary<string, object?>? _custom;

    public CorpusUser(string identifier, string? email, string? country, IReadOnlyDictionary<string, object?>? custom)
    {
        Identifier = identifier;
        Email = email;
        Country = country;
        _custom = custom;
    }

    public string Identifier { get; }

    public string? Email { get; }

    public string? Country { get; }

    public object? GetAttribute(string name)
    {
        switch (name)
        {
            case "Identifier":
                return Identifier;
            case "Email":
                return Email;
            case "Country":
                return Country;
            default:
                return _custom is not null && _custom.TryGetValue(name, out var v) ? v : null;
        }
    }

    public IEnumerable<string> CustomKeysInOrder()
    {
        if (_custom is null)
        {
            return Array.Empty<string>();
        }

        var keys = new List<string>(_custom.Keys);
        keys.Sort(StringComparer.Ordinal);
        return keys;
    }
}
