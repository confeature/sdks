// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Confeature.Client.Internal;

/// <summary>
/// ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
/// .NET slice of #501).
/// </summary>
/// <remarks>
/// <para>
/// .NET port of the spec-117 TS reference
/// (<c>packages/sdk-shared/src/eval-log.ts</c> <c>EvaluateLogBuilder</c>) and
/// the Go / Python / Rust ports
/// (<c>apps/sdk-go/internal/evaluator/eval_log.go</c>,
/// <c>apps/sdk-python/.../eval_log.py</c>, <c>apps/sdk-rust/.../eval_log.rs</c>).
/// Produces the byte-identical indented textual trace ConfigCat's SDKs emit
/// during flag evaluation — its <c>evaluationlog/</c> corpus (replayed via
/// <c>packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json</c>)
/// is the byte-oracle.
/// </para>
/// <para>
/// The trace is emitted via the trace sink at INFO under event id 5000
/// (ConfigCat's verbosity contract) — see
/// <c>Evaluator.EvaluateCoreTraced</c>. This capture seam is intentionally
/// distinct from the public default <see cref="TraceLogger"/> (the
/// customer-facing logger): a customer logger has the error/warning/info/debug
/// shape, while the trace test taps a structured
/// <c>(level, eventId, message)</c> recorder. Keeping them separate matches the
/// Go / Python / Rust factoring and keeps the no-trace hot path zero-cost.
/// </para>
/// </remarks>
internal static class EvalLog
{
    /// <summary>
    /// ConfigCat's event id for the "config evaluated" INFO log line. Captured
    /// as <c>... [5000] ...</c>, matching the upstream oracle.
    /// </summary>
    public const string EventId = "5000";

    /// <summary>ConfigCat indents each nested eval-log line by two spaces per level.</summary>
    public const string IndentUnit = "  ";

    /// <summary>Max IS-ONE-OF / list items rendered before truncation (configcat parity).</summary>
    public const int StringListMaxLength = 10;

    // Placeholders ConfigCat substitutes for malformed condition parts (parity
    // with configcat-common's EvaluateLogBuilder).
    public const string InvalidValuePlaceholder = "<invalid value>";
    public const string InvalidNamePlaceholder = "<invalid name>";
    public const string InvalidOperatorPlaceholder = "<invalid operator>";

    /// <summary>
    /// Render a resolved SETTING value for the eval log (ConfigCat parity):
    /// boolean → <c>true</c>/<c>false</c> (lowercase), string → verbatim,
    /// number → its decimal string. Mirrors the <c>'&lt;value&gt;'</c> token in
    /// ConfigCat's <c>Returning '&lt;value&gt;'.</c> footer
    /// (eval-log.ts <c>settingValueToString</c>).
    /// </summary>
    public static string SettingValueToLogString(object? value)
    {
        switch (value)
        {
            case bool b:
                return BoolToLogString(b);
            case string s:
                return s;
            case double d:
                return Comparators.NumberToCanonicalString(d);
            case float f:
                return Comparators.NumberToCanonicalString(f);
            case int i:
                return i.ToString(CultureInfo.InvariantCulture);
            case long l:
                return l.ToString(CultureInfo.InvariantCulture);
            default:
                return string.Empty;
        }
    }

    /// <summary>Render a boolean as the lowercase <c>true</c>/<c>false</c> the oracle uses.</summary>
    public static string BoolToLogString(bool value) => value ? "true" : "false";
}

/// <summary>
/// The per-comparator value kind — which slot the comparator reads:
/// list / string / number / datetime.
/// </summary>
internal enum ComparatorKind
{
    List,
    Str,
    Number,
    DateTime,
}

/// <summary>
/// Three-valued THEN consequence (MATCH / no match / error string), mirroring
/// TS's <c>boolean | string</c> (eval-log.ts <c>appendTargetingRuleConsequence</c>).
/// </summary>
internal readonly struct MatchOrError
{
    private MatchOrError(int kind, string? error)
    {
        Kind = kind;
        Error = error;
    }

    public int Kind { get; }

    public string? Error { get; }

    public static MatchOrError Match() => new(0, null);

    public static MatchOrError NoMatch() => new(1, null);

    public static MatchOrError Err(string text) => new(2, text);
}

/// <summary>
/// .NET analogue of eval-log.ts <c>EvaluateLogBuilder</c>: the
/// indent / newLine / append primitives + the condition-rendering helpers.
/// <c>Eol</c> is <c>"\n"</c> — the byte the upstream oracle uses.
/// </summary>
internal sealed class EvaluateLogBuilder
{
    private const char Eol = '\n';

    private readonly StringBuilder _chunks = new();
    private int _indentLevel;

    /// <summary>Append text to the current line.</summary>
    public EvaluateLogBuilder Append(string text)
    {
        _chunks.Append(text);
        return this;
    }

    /// <summary>Break to a new line at the current indent, then append <paramref name="text"/>.</summary>
    public EvaluateLogBuilder NewLine(string text = "")
    {
        _chunks.Append(Eol);
        for (var i = 0; i < _indentLevel; i++)
        {
            _chunks.Append(EvalLog.IndentUnit);
        }

        if (text.Length > 0)
        {
            _chunks.Append(text);
        }

        return this;
    }

    public EvaluateLogBuilder IncreaseIndent()
    {
        _indentLevel++;
        return this;
    }

    public EvaluateLogBuilder DecreaseIndent()
    {
        if (_indentLevel > 0)
        {
            _indentLevel--;
        }

        return this;
    }

    /// <summary>
    /// Render one user condition (<c>User.&lt;attr&gt; &lt;COMP&gt; &lt;value&gt;</c>).
    /// The compact <see cref="UserCondition"/> carries the value in <c>L</c>
    /// (list), <c>S</c> (string / sensitive-equals), or <c>D</c>
    /// (number / datetime), selected by the comparator kind.
    /// </summary>
    public EvaluateLogBuilder AppendUserCondition(UserCondition condition)
    {
        var attr = condition.A ?? EvalLog.InvalidNamePlaceholder;
        var c = condition.C;
        if (!ComparatorMeta.TryGet(c, out var meta))
        {
            return AppendUserConditionFallback(attr, c, condition);
        }

        switch (meta.Kind)
        {
            case ComparatorKind.List:
                return AppendUserConditionStringList(attr, c, condition.L, condition.HasL, meta.Sensitive);
            case ComparatorKind.Str:
                return AppendUserConditionString(attr, c, condition.S, meta.Sensitive);
            case ComparatorKind.Number:
                return AppendUserConditionNumber(attr, c, condition.D, isDateTime: false);
            case ComparatorKind.DateTime:
                return AppendUserConditionNumber(attr, c, condition.D, isDateTime: true);
            default:
                return this;
        }
    }

    /// <summary>Append a single condition's boolean result (<c> =&gt; true</c> / <c> =&gt; false, skipping…</c>).</summary>
    public EvaluateLogBuilder AppendConditionConsequence(bool result)
    {
        Append(" => " + EvalLog.BoolToLogString(result));
        return result ? this : Append(", skipping the remaining AND conditions");
    }

    /// <summary>
    /// Append a targeting rule's THEN consequence. <paramref name="thenValue"/>
    /// is the rule's formatted served value (e.g. <c>Dog</c>) for a fixed-value
    /// rule, or <c>null</c> for a rule serving <c>% options</c>.
    /// </summary>
    public EvaluateLogBuilder AppendTargetingRuleConsequence(string? thenValue, MatchOrError matchKind, bool newLine)
    {
        IncreaseIndent();
        if (newLine)
        {
            NewLine();
        }
        else
        {
            Append(" ");
        }

        Append("THEN");
        Append(thenValue is not null ? " '" + thenValue + "'" : " % options");
        Append(" => ");
        switch (matchKind.Kind)
        {
            case 0:
                Append("MATCH, applying rule");
                break;
            case 1:
                Append("no match");
                break;
            default:
                Append(matchKind.Error ?? string.Empty);
                break;
        }

        return DecreaseIndent();
    }

    /// <summary>Append a prerequisite-flag condition (<c>Flag 'X' EQUALS 'Y'</c>).</summary>
    public EvaluateLogBuilder AppendPrerequisiteFlagCondition(string prereqKey, int comparator, string comparisonValue)
    {
        var op = comparator == Prerequisites.PrerequisiteNotEquals ? "NOT EQUALS" : "EQUALS";
        return Append("Flag '" + prereqKey + "' " + op + " '" + comparisonValue + "'");
    }

    /// <summary>Append a segment condition (<c>User IS [NOT] IN SEGMENT 'X'</c>).</summary>
    public EvaluateLogBuilder AppendSegmentCondition(string segmentName, int comparator)
    {
        var op = comparator == Segments.SegmentIsNotIn ? "IS NOT IN SEGMENT" : "IS IN SEGMENT";
        return Append("User " + op + " '" + segmentName + "'");
    }

    /// <summary>Append a bare boolean condition result (<c>true</c> / <c>false</c>).</summary>
    public EvaluateLogBuilder AppendConditionResult(bool result) => Append(EvalLog.BoolToLogString(result));

    public override string ToString() => _chunks.ToString();

    private EvaluateLogBuilder AppendUserConditionCore(string attr, int comparator, string value)
    {
        if (value.Length == 0)
        {
            value = EvalLog.InvalidValuePlaceholder;
        }

        return Append("User." + attr + " " + ComparatorMeta.FormatUserComparator(comparator) + " '" + value + "'");
    }

    private EvaluateLogBuilder AppendUserConditionString(string attr, int comparator, string? value, bool isSensitive)
    {
        if (value is null)
        {
            return AppendUserConditionCore(attr, comparator, string.Empty);
        }

        return AppendUserConditionCore(attr, comparator, !isSensitive ? value : "<hashed value>");
    }

    private EvaluateLogBuilder AppendUserConditionStringList(
        string attr,
        int comparator,
        IReadOnlyList<string> values,
        bool hasValues,
        bool isSensitive)
    {
        if (!hasValues)
        {
            return AppendUserConditionCore(attr, comparator, string.Empty);
        }

        var comparatorText = ComparatorMeta.FormatUserComparator(comparator);
        if (isSensitive)
        {
            var word = values.Count == 1 ? "value" : "values";
            return Append("User." + attr + " " + comparatorText + " [<" + values.Count.ToString(CultureInfo.InvariantCulture) + " hashed " + word + ">]");
        }

        var listText = FormatStringList(values, EvalLog.StringListMaxLength);
        return Append("User." + attr + " " + comparatorText + " [" + listText + "]");
    }

    private EvaluateLogBuilder AppendUserConditionNumber(string attr, int comparator, double? value, bool isDateTime)
    {
        if (value is null)
        {
            return AppendUserConditionCore(attr, comparator, string.Empty);
        }

        var comparatorText = ComparatorMeta.FormatUserComparator(comparator);
        var valueText = Comparators.NumberToCanonicalString(value.Value);
        if (isDateTime && UnixSecondsToIso(value.Value, out var iso))
        {
            return Append("User." + attr + " " + comparatorText + " '" + valueText + "' (" + iso + " UTC)");
        }

        return Append("User." + attr + " " + comparatorText + " '" + valueText + "'");
    }

    private EvaluateLogBuilder AppendUserConditionFallback(string attr, int comparator, UserCondition condition)
    {
        if (condition.S is not null)
        {
            return AppendUserConditionCore(attr, comparator, condition.S);
        }

        if (condition.D is not null)
        {
            return AppendUserConditionCore(attr, comparator, Comparators.NumberToCanonicalString(condition.D.Value));
        }

        if (condition.HasL && condition.L.Count > 0)
        {
            return AppendUserConditionCore(attr, comparator, condition.L[0]);
        }

        return AppendUserConditionCore(attr, comparator, string.Empty);
    }

    /// <summary>
    /// Format a string list exactly as configcat-common's <c>formatStringList</c>
    /// (Utils.ts): <c>'a', 'b'</c> joined by <c>, </c>, with an optional
    /// truncation appendix once <paramref name="maxLength"/> is exceeded.
    /// </summary>
    private static string FormatStringList(IReadOnlyList<string> items, int maxLength)
    {
        if (items.Count == 0)
        {
            return string.Empty;
        }

        var shown = items;
        var appendix = string.Empty;
        if (maxLength > 0 && items.Count > maxLength)
        {
            var trimmed = new List<string>(maxLength);
            for (var i = 0; i < maxLength; i++)
            {
                trimmed.Add(items[i]);
            }

            shown = trimmed;
            var count = items.Count - maxLength;
            var word = count == 1 ? "value" : "values";
            appendix = ", ... <" + count.ToString(CultureInfo.InvariantCulture) + " more " + word + ">";
        }

        return "'" + string.Join("', '", shown) + "'" + appendix;
    }

    /// <summary>
    /// Render a Unix-seconds value as ConfigCat's eval-log datetime suffix —
    /// JS <c>new Date(value*1000).toISOString()</c>, e.g.
    /// <c>2023-04-01T00:00:00.000Z</c> (always millisecond precision, UTC).
    /// Returns <c>false</c> for non-finite values (NaN / ±Inf), matching the JS
    /// <c>isNaN(date)</c> guard.
    /// </summary>
    private static bool UnixSecondsToIso(double seconds, out string iso)
    {
        if (double.IsNaN(seconds) || double.IsInfinity(seconds))
        {
            iso = string.Empty;
            return false;
        }

        var ms = (long)Math.Round(seconds * 1000.0, MidpointRounding.AwayFromZero);
        var dt = DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;
        iso = dt.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) + "Z";
        return true;
    }
}

/// <summary>
/// Per-comparator eval-log metadata (configcat-common parity), mirroring
/// eval-log.ts <c>COMPARATOR_META</c>: <c>token</c> is the operator rendering,
/// <c>kind</c> selects the condition value slot, <c>sensitive</c> masks the
/// value as <c>&lt;hashed value&gt;</c>.
/// </summary>
internal static class ComparatorMeta
{
    private static readonly Dictionary<int, (string Token, ComparatorKind Kind, bool Sensitive)> Map = new()
    {
        [Comparators.TextIsOneOf] = ("IS ONE OF", ComparatorKind.List, false),
        [Comparators.TextIsNotOneOf] = ("IS NOT ONE OF", ComparatorKind.List, false),
        [Comparators.TextContainsAnyOf] = ("CONTAINS ANY OF", ComparatorKind.List, false),
        [Comparators.TextNotContainsAnyOf] = ("NOT CONTAINS ANY OF", ComparatorKind.List, false),
        [Comparators.SemVerIsOneOf] = ("IS ONE OF", ComparatorKind.List, false),
        [Comparators.SemVerIsNotOneOf] = ("IS NOT ONE OF", ComparatorKind.List, false),
        [Comparators.SemVerLess] = ("<", ComparatorKind.Str, false),
        [Comparators.SemVerLessOrEquals] = ("<=", ComparatorKind.Str, false),
        [Comparators.SemVerGreater] = (">", ComparatorKind.Str, false),
        [Comparators.SemVerGreaterOrEquals] = (">=", ComparatorKind.Str, false),
        [Comparators.NumberEquals] = ("=", ComparatorKind.Number, false),
        [Comparators.NumberNotEquals] = ("!=", ComparatorKind.Number, false),
        [Comparators.NumberLess] = ("<", ComparatorKind.Number, false),
        [Comparators.NumberLessOrEquals] = ("<=", ComparatorKind.Number, false),
        [Comparators.NumberGreater] = (">", ComparatorKind.Number, false),
        [Comparators.NumberGreaterOrEquals] = (">=", ComparatorKind.Number, false),
        [Comparators.SensitiveTextIsOneOf] = ("IS ONE OF", ComparatorKind.List, true),
        [Comparators.SensitiveTextIsNotOneOf] = ("IS NOT ONE OF", ComparatorKind.List, true),
        [Comparators.DateTimeBefore] = ("BEFORE", ComparatorKind.DateTime, false),
        [Comparators.DateTimeAfter] = ("AFTER", ComparatorKind.DateTime, false),
        [Comparators.SensitiveTextEquals] = ("EQUALS", ComparatorKind.Str, true),
        [Comparators.SensitiveTextNotEquals] = ("NOT EQUALS", ComparatorKind.Str, true),
        [Comparators.SensitiveTextStartsWithAnyOf] = ("STARTS WITH ANY OF", ComparatorKind.List, true),
        [Comparators.SensitiveTextNotStartsWithAnyOf] = ("NOT STARTS WITH ANY OF", ComparatorKind.List, true),
        [Comparators.SensitiveTextEndsWithAnyOf] = ("ENDS WITH ANY OF", ComparatorKind.List, true),
        [Comparators.SensitiveTextNotEndsWithAnyOf] = ("NOT ENDS WITH ANY OF", ComparatorKind.List, true),
        [Comparators.SensitiveArrayContainsAnyOf] = ("ARRAY CONTAINS ANY OF", ComparatorKind.List, true),
        [Comparators.SensitiveArrayNotContainsAnyOf] = ("ARRAY NOT CONTAINS ANY OF", ComparatorKind.List, true),
        [Comparators.TextEquals] = ("EQUALS", ComparatorKind.Str, false),
        [Comparators.TextNotEquals] = ("NOT EQUALS", ComparatorKind.Str, false),
        [Comparators.TextStartsWithAnyOf] = ("STARTS WITH ANY OF", ComparatorKind.List, false),
        [Comparators.TextNotStartsWithAnyOf] = ("NOT STARTS WITH ANY OF", ComparatorKind.List, false),
        [Comparators.TextEndsWithAnyOf] = ("ENDS WITH ANY OF", ComparatorKind.List, false),
        [Comparators.TextNotEndsWithAnyOf] = ("NOT ENDS WITH ANY OF", ComparatorKind.List, false),
        [Comparators.ArrayContainsAnyOf] = ("ARRAY CONTAINS ANY OF", ComparatorKind.List, false),
        [Comparators.ArrayNotContainsAnyOf] = ("ARRAY NOT CONTAINS ANY OF", ComparatorKind.List, false),
    };

    public static bool TryGet(int comparator, out (string Token, ComparatorKind Kind, bool Sensitive) meta) =>
        Map.TryGetValue(comparator, out meta);

    /// <summary>
    /// Render a comparator as ConfigCat's eval-log operator token, or the
    /// invalid-operator placeholder for an unknown comparator.
    /// </summary>
    public static string FormatUserComparator(int comparator) =>
        Map.TryGetValue(comparator, out var meta) ? meta.Token : EvalLog.InvalidOperatorPlaceholder;
}

/// <summary>
/// Numeric log levels mirroring configcat-common's ordering (logger.ts
/// <c>LogLevel</c>), so level filtering ("Info and above") works identically
/// across SDKs. Intentionally distinct from the public
/// <see cref="Confeature.Client.LogLevel"/> (the customer-facing enum) — this
/// is the internal capture-side ordering.
/// </summary>
internal enum EvalTraceLevel
{
    Off = -1,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

/// <summary>
/// Captures the evaluator's structured log calls. Each call is one
/// <c>(level, eventId, message)</c> tuple; an INFO-enabled sink drives the
/// eval-log trace (the multi-line INFO 5000 line) plus the WARN/ERROR lines
/// emitted during the walk. This is the seam the parity test taps to
/// reconstruct ConfigCat's byte-identical capture string. Named distinctly from
/// the customer-facing <see cref="TraceLogger"/> default logger to avoid a
/// collision (this is the eval-log capture sink, not the SDK's public logger).
/// </summary>
internal interface IEvalTraceSink
{
    /// <summary>Reports the configured threshold (<see cref="EvalTraceLevel.Info"/> enables tracing).</summary>
    EvalTraceLevel Level { get; }

    /// <summary>Records one emitted line.</summary>
    void Log(EvalTraceLevel level, string eventId, string message);
}

/// <summary>
/// Internal logger adapter threaded through the evaluation context. Mirrors
/// logger.ts <c>LoggerWrapper</c>: a <c>null</c> inner means tracing is off
/// (zero cost), and every helper is level-gated at the boundary. The strings
/// are ported VERBATIM from logger.ts (Principle II — byte-identical to the
/// canonical).
/// </summary>
internal sealed class EvalTraceLog
{
    private readonly IEvalTraceSink? _inner;

    public EvalTraceLog(IEvalTraceSink? inner) => _inner = inner;

    public bool Enabled(EvalTraceLevel level)
    {
        if (_inner is null)
        {
            return false;
        }

        var threshold = _inner.Level;
        if (threshold == EvalTraceLevel.Off)
        {
            return false;
        }

        return (int)level <= (int)threshold;
    }

    /// <summary>WARN 3001 (verbatim from logger.ts <c>userObjectIsMissing</c>).</summary>
    public void UserObjectIsMissing(string key) =>
        Emit(
            EvalTraceLevel.Warn,
            "3001",
            "cannot evaluate targeting rules and % options for setting '" + key + "' "
            + "(User Object is missing); you should pass a User Object to the evaluation "
            + "methods like `getValue()` in order to make targeting work properly; read more: "
            + "https://configcat.com/docs/advanced/user-object/");

    /// <summary>WARN 3003 (verbatim from logger.ts <c>userObjectAttributeIsMissing</c>).</summary>
    public void UserObjectAttributeIsMissing(string key, string attributeName) =>
        Emit(
            EvalTraceLevel.Warn,
            "3003",
            "cannot evaluate certain targeting rules of setting '" + key + "' "
            + "(the User." + attributeName + " attribute is missing); you should set the "
            + "User." + attributeName + " attribute in order to make targeting work properly; "
            + "read more: https://configcat.com/docs/advanced/user-object/");

    /// <summary>WARN 3003, % options variant (verbatim from logger.ts).</summary>
    public void UserObjectAttributeIsMissingForPercentage(string key, string attributeName) =>
        Emit(
            EvalTraceLevel.Warn,
            "3003",
            "cannot evaluate % options for setting '" + key + "' "
            + "(the User." + attributeName + " attribute is missing); you should set the "
            + "User." + attributeName + " attribute in order to make targeting work properly; "
            + "read more: https://configcat.com/docs/advanced/user-object/");

    /// <summary>WARN 3004 (verbatim from logger.ts <c>userObjectAttributeIsInvalid</c>).</summary>
    public void UserObjectAttributeIsInvalid(string key, string attributeName, string reason) =>
        Emit(
            EvalTraceLevel.Warn,
            "3004",
            "cannot evaluate certain targeting rules of setting '" + key + "' "
            + "(the User." + attributeName + " attribute is invalid (" + reason + ")); please check the "
            + "User." + attributeName + " attribute and make sure that its value corresponds to the "
            + "comparison operator");

    /// <summary>
    /// WARN 3004, malformed config operand (#509). Note there is NO
    /// "please check the User.&lt;attr&gt;…" suffix (verbatim from logger.ts
    /// <c>comparisonValueIsInvalid</c>). <paramref name="innerMessage"/> is the
    /// full <c>comparison value '&lt;v&gt;' is invalid (&lt;reason&gt;)</c> text.
    /// </summary>
    public void ComparisonValueIsInvalid(string key, string innerMessage) =>
        Emit(
            EvalTraceLevel.Warn,
            "3004",
            "cannot evaluate certain targeting rules of setting '" + key + "' (" + innerMessage + ")");

    /// <summary>ERROR 1002 (verbatim from logger.ts <c>circularDependency</c>).</summary>
    public void CircularDependency(string key, string cycle) =>
        Emit(
            EvalTraceLevel.Error,
            "1002",
            "failed to evaluate setting '" + key + "' (circular dependency detected between the "
            + "following depending flags: [" + cycle + "])");

    /// <summary>INFO line (the 5000 trace). Mirrors logger.ts <c>LoggerWrapper.info</c>.</summary>
    public void Info(string eventId, string message) => Emit(EvalTraceLevel.Info, eventId, message);

    private void Emit(EvalTraceLevel level, string eventId, string message)
    {
        if (!Enabled(level))
        {
            return;
        }

        _inner!.Log(level, eventId, message);
    }
}
