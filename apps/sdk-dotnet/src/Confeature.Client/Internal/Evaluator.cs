// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;

namespace Confeature.Client.Internal;

/// <summary>
/// ConfigCat-parity flag evaluator — full decision engine (spec 122).
/// Resolves a setting's value across the full <c>SettingType</c> matrix —
/// <c>boolean</c> (0), <c>string</c> (1), <c>int</c> (2), <c>double</c> (3) —
/// against a <see cref="User"/> targeting context, walking the config_v6
/// targeting tree (rules, comparators, segments, prerequisites, percentage
/// options). Returns the caller's typed fallback on any failure path.
/// </summary>
/// <remarks>
/// <para>
/// Ported from the spec-117 TS reference
/// (<c>packages/sdk-shared/src/evaluator.ts</c>) + the spec-118/119/120/121
/// Python / Go / Ruby / PHP ports. Decision flow mirrors
/// <c>evaluator.ts::evaluateSetting</c>: (1) walk <c>setting.Rules</c>
/// first-match-wins, AND-grouped conditions, served value or percentage
/// bucket; (2) setting-level percentage options; (3) served fallback
/// <c>setting.V</c>.
/// </para>
/// <para>
/// Fail-closed semantics (SC-006, NON-NEGOTIABLE): no exception escapes; any
/// unexpected state (incl. a detected prerequisite cycle) resolves to the
/// caller's default with a discrete <see cref="EvaluationError"/> code. The
/// existing strict dual-entry-point TYPE_MISMATCH / MALFORMED_VALUE /
/// UNSUPPORTED_TYPE decision tree (<see cref="ResolveTyped"/>) runs UNCHANGED
/// on the resolved value envelope, whatever its source (rule / % / static),
/// so the rule-less path is byte-identical to the pre-engine behaviour.
/// </para>
/// </remarks>
internal static class Evaluator
{
    private const string MissingUserObjectError = "cannot evaluate, User Object is missing";
    private const string IdentifierAttribute = "Identifier";

    /// <summary>
    /// Setting-type discriminator for boolean values. Mirrors
    /// <c>SettingType.Bool</c> (=0) from <c>packages/sdk-shared/src/config-json.ts</c>.
    /// </summary>
    public const int SettingTypeBool = 0;

    /// <summary>
    /// Setting-type discriminator for string values. Mirrors
    /// <c>SettingType.String</c> (=1) from <c>packages/sdk-shared/src/config-json.ts</c>.
    /// </summary>
    public const int SettingTypeString = 1;

    /// <summary>
    /// Setting-type discriminator for int values. Mirrors
    /// <c>SettingType.Int</c> (=2) from <c>packages/sdk-shared/src/config-json.ts</c>.
    /// </summary>
    public const int SettingTypeInt = 2;

    /// <summary>
    /// Setting-type discriminator for double values. Mirrors
    /// <c>SettingType.Double</c> (=3) from <c>packages/sdk-shared/src/config-json.ts</c>.
    /// </summary>
    public const int SettingTypeDouble = 3;

    /// <summary>
    /// Resolves <paramref name="key"/> against <paramref name="settings"/>,
    /// walking the targeting tree against <paramref name="user"/>.
    /// </summary>
    public static EvaluationResult Evaluate<T>(
        IReadOnlyDictionary<string, Setting>? settings,
        string key,
        T defaultValue,
        User? user)
    {
        return EvaluateCore(settings, key, defaultValue, user is null ? null : new UserAttributes(user));
    }

    /// <summary>
    /// Non-generic counterpart of <see cref="Evaluate{T}"/>. The caller
    /// supplies <paramref name="defaultValue"/> as <c>object?</c>; the
    /// TYPE_MISMATCH check inspects its runtime type.
    /// </summary>
    public static EvaluationResult EvaluateDynamic(
        IReadOnlyDictionary<string, Setting>? settings,
        string key,
        object? defaultValue,
        User? user)
    {
        return EvaluateCore(settings, key, defaultValue, user is null ? null : new UserAttributes(user));
    }

    /// <summary>
    /// Targeting-aware evaluation core consuming a duck-typed
    /// <see cref="IEvalUser"/> so the conformance corpus can feed typed custom
    /// attributes the public <see cref="User"/> cannot carry. Production code
    /// routes through <see cref="Evaluate{T}"/> / <see cref="EvaluateDynamic"/>
    /// with a real <see cref="UserAttributes"/>. NEVER throws — any internal
    /// exception (incl. a detected prerequisite cycle) is converted to a
    /// fail-closed result with <see cref="EvaluationError.EvalException"/>.
    /// </summary>
    public static EvaluationResult EvaluateCore(
        IReadOnlyDictionary<string, Setting>? settings,
        string key,
        object? defaultValue,
        IEvalUser? user)
    {
        return EvaluateCoreTraced(settings, key, defaultValue, user, null);
    }

    /// <summary>
    /// <see cref="EvaluateCore"/> with an optional eval-log trace sink (ADR 0003 /
    /// epic #494, #501). When the sink is INFO-enabled it drives the ConfigCat
    /// byte-identical evaluation-log trace: the WARN 3001/3003/3004 + ERROR 1002
    /// lines emitted during the walk, and the final INFO 5000 multi-line
    /// indented trace. A <c>null</c> sink (the hot path) is zero-cost — identical
    /// behaviour to <see cref="EvaluateCore"/>.
    /// </summary>
    public static EvaluationResult EvaluateCoreTraced(
        IReadOnlyDictionary<string, Setting>? settings,
        string key,
        object? defaultValue,
        IEvalUser? user,
        IEvalTraceSink? sink)
    {
        var log = new EvalTraceLog(sink);
        try
        {
            if (settings is null)
            {
                return new EvaluationResult { Value = defaultValue, Error = EvaluationError.NoConfig };
            }

            if (!settings.TryGetValue(key, out var setting) || setting is null)
            {
                return new EvaluationResult { Value = defaultValue, Error = EvaluationError.KeyNotFound };
            }

            // Type guard BEFORE evaluating rules (mirrors evaluator.ts): the
            // default must be type-compatible with the setting's declared type.
            // A `null` default bypasses the check (the variation-id matrix).
            if (defaultValue is not null)
            {
                var mismatch = CheckDefaultType(setting.T, defaultValue);
                if (mismatch is not null)
                {
                    return new EvaluationResult { Value = defaultValue, Error = mismatch.Value };
                }
            }

            // Evaluation-log trace (ADR 0003). Built lazily — only when the sink
            // would emit at INFO. The header is appended here; the
            // `Returning '<value>'.` footer below; the whole multi-line trace is
            // surfaced under event id 5000.
            EvaluateLogBuilder? logBuilder = null;
            if (log.Enabled(EvalTraceLevel.Info))
            {
                logBuilder = new EvaluateLogBuilder();
                logBuilder.Append("Evaluating '" + key + "'");
                if (user is not null)
                {
                    logBuilder.Append(" for User '" + UserAttributesForLogJson(user) + "'");
                }
            }

            var ctx = new EvalContext(
                key,
                setting,
                settings,
                setting.Segments,
                setting.ConfigSalt,
                user,
                new EvalState(),
                new VisitedFlags(),
                log,
                logBuilder);

            var result = EvaluateSetting(ctx);

            var variationId = result.VariationId ?? setting.VariationId;
            var typed = ResolveTyped(setting.T, result, defaultValue, variationId, ctx.State.EvalError);

            // Footer + emit. The INFO 5000 trace is emitted only when the resolved
            // value is clean (no error); a type/value error fails closed without a
            // footer (matching evaluator.ts, which emits after the value guard).
            if (logBuilder is not null && typed.Error == EvaluationError.None)
            {
                logBuilder.NewLine("Returning '" + EvalLog.SettingValueToLogString(typed.Value) + "'.");
                log.Info(EvalLog.EventId, logBuilder.ToString());
            }

            return typed;
        }
        catch (CircularDependencyException ex)
        {
            // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
            // (naming the setting + the chain), not the generic evaluation path.
            log.CircularDependency(key, ex.Cycle);
            return new EvaluationResult { Value = defaultValue, Error = EvaluationError.EvalException };
        }
        catch (Exception)
        {
            // Bounded fail-closed (FR-007 / SC-004): a malformed reference, or any
            // unexpected error resolves to the caller's default.
            return new EvaluationResult { Value = defaultValue, Error = EvaluationError.EvalException };
        }
    }

    /// <summary>
    /// Render the user's attributes as the eval-log header shows them — a
    /// Confeature-canonical object <c>{Identifier, Email?, Country?, …custom}</c>
    /// JSON-serialized to the <c>for User '…'</c> token (ADR 0003 addendum). This
    /// is the configcat-js form; insertion order is fixed (Identifier, Email,
    /// Country, then custom in sorted order — the corpus scenarios carry at most
    /// one custom key, so any total order is byte-identical to the oracle), and
    /// the serialization is compact with JS-JSON string escaping
    /// (<c>JSON.stringify</c>).
    /// </summary>
    private static string UserAttributesForLogJson(IEvalUser user)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append('{');
        sb.Append("\"Identifier\":").Append(JsJsonString(user.Identifier));

        var email = user.GetAttribute("Email") as string;
        if (!string.IsNullOrEmpty(email))
        {
            sb.Append(",\"Email\":").Append(JsJsonString(email!));
        }

        var country = user.GetAttribute("Country") as string;
        if (!string.IsNullOrEmpty(country))
        {
            sb.Append(",\"Country\":").Append(JsJsonString(country!));
        }

        foreach (var name in user.CustomKeysInOrder())
        {
            sb.Append(',')
                .Append(JsJsonString(name))
                .Append(':')
                .Append(JsJsonString(Comparators.UserAttributeValueToString(user.GetAttribute(name))));
        }

        sb.Append('}');
        return sb.ToString();
    }

    /// <summary>
    /// Serialize a string exactly as ECMAScript <c>JSON.stringify</c> renders a
    /// string value: double-quoted, with <c>"</c>, <c>\</c>, and the C0 control
    /// characters escaped, and all other code points (incl. <c>/</c> and
    /// non-ASCII) emitted verbatim.
    /// </summary>
    private static string JsJsonString(string s)
    {
        var sb = new System.Text.StringBuilder();
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
                case '\t':
                    sb.Append("\\t");
                    break;
                case '\n':
                    sb.Append("\\n");
                    break;
                case '\f':
                    sb.Append("\\f");
                    break;
                case '\r':
                    sb.Append("\\r");
                    break;
                default:
                    if (ch < 0x20)
                    {
                        sb.Append("\\u00")
                            .Append(((int)ch).ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
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

    /// <summary>
    /// Returns a <see cref="EvaluationError"/> when the default type is wrong,
    /// else <c>null</c>. Preserves the strict typed-default guards (SC-006).
    /// </summary>
    private static EvaluationError? CheckDefaultType(int settingType, object defaultValue)
    {
        return settingType switch
        {
            SettingTypeBool => defaultValue is bool ? null : EvaluationError.TypeMismatch,
            SettingTypeString => defaultValue is string ? null : EvaluationError.TypeMismatch,
            SettingTypeInt => defaultValue is int ? null : EvaluationError.TypeMismatch,
            SettingTypeDouble => defaultValue is double ? null : EvaluationError.TypeMismatch,
            _ => null,
        };
    }

    // -----------------------------------------------------------------------
    // Evaluation core — rule walk / conditions / percentage
    // -----------------------------------------------------------------------

    private static SettingResult EvaluateSetting(EvalContext ctx)
    {
        var setting = ctx.Setting;

        // 1. Targeting rules — first-match-wins (US1).
        if (setting.Rules.Count > 0)
        {
            var ruleResult = EvaluateTargetingRules(setting.Rules, ctx);
            if (ruleResult is not null)
            {
                return ruleResult;
            }
        }

        // 2. Setting-level percentage options (US3).
        if (setting.PercentageOptions.Count > 0)
        {
            var optionResult = EvaluatePercentageOptions(setting.PercentageOptions, false, ctx);
            if (optionResult is not null)
            {
                return optionResult;
            }
        }

        // 3. Served fallback `setting.V`.
        return new SettingResult { Value = setting.V, VariationId = setting.VariationId };
    }

    private static SettingResult? EvaluateTargetingRules(
        IReadOnlyList<TargetingRuleModel> rules,
        EvalContext ctx)
    {
        var lb = ctx.LogBuilder;
        lb?.NewLine("Evaluating targeting rules and applying the first match if any:");
        foreach (var rule in rules)
        {
            var outcome = EvaluateConditions(rule.C, ctx.Key, ctx, rule);
            if (outcome is not bool matched || !matched)
            {
                // A rule whose conditions ERRORED (missing user/attr/validation)
                // is ignored and evaluation continues — ConfigCat emits this
                // trace line. A rule that merely did NOT match (false) just
                // continues, with no such line.
                if (outcome is not bool)
                {
                    lb?.IncreaseIndent()
                        .NewLine("The current targeting rule is ignored and the evaluation continues with the next rule.")
                        .DecreaseIndent();
                }

                continue;
            }

            if (rule.S is not null)
            {
                return new SettingResult { Value = rule.S.V, VariationId = rule.S.I, MatchedRule = true };
            }

            // A rule serving % options: the block is traced one level deeper
            // (under the rule). If the options can't resolve (no user / missing
            // keying attr) the rule is ignored and evaluation continues.
            var options = rule.P ?? new List<PercentageOptionModel>();
            lb?.IncreaseIndent();
            var optionResult = EvaluatePercentageOptions(options, true, ctx);
            if (optionResult is not null)
            {
                lb?.DecreaseIndent();
                return optionResult;
            }

            lb?.NewLine("The current targeting rule is ignored and the evaluation continues with the next rule.")
                .DecreaseIndent();
        }

        return null;
    }

    private static SettingResult? EvaluatePercentageOptions(
        IReadOnlyList<PercentageOptionModel> options,
        bool matchedRule,
        EvalContext ctx)
    {
        var lb = ctx.LogBuilder;
        if (ctx.User is null)
        {
            SurfaceMissingUser(ctx);
            lb?.NewLine("Skipping % options because the User Object is missing.");
            return null;
        }

        string attrName;
        object? attrValue;
        if (ctx.Setting.PercentageAttr is null)
        {
            attrName = IdentifierAttribute;
            attrValue = ctx.User.Identifier;
        }
        else
        {
            attrName = ctx.Setting.PercentageAttr;
            attrValue = ctx.User.GetAttribute(attrName);
        }

        if (attrValue is null)
        {
            ctx.State.EvalError ??= MissingUserAttributeError(attrName);
            ctx.Log.UserObjectAttributeIsMissingForPercentage(ctx.Key, attrName);
            lb?.NewLine("Skipping % options because the User." + attrName + " attribute is missing.");
            return null;
        }

        var hashValue = Hashing.PercentageBucket(
            ctx.Key,
            Comparators.UserAttributeValueToString(attrValue));

        lb?.NewLine("Evaluating % options based on the User." + attrName + " attribute:");
        lb?.NewLine(
            "- Computing hash in the [0..99] range from User." + attrName + " => "
            + hashValue.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + " (this value is sticky and consistent across all SDKs)");

        var bucket = 0;
        for (var i = 0; i < options.Count; i++)
        {
            var option = options[i];
            bucket += option.P;
            if (hashValue >= bucket)
            {
                continue;
            }

            lb?.NewLine(
                "- Hash value " + hashValue.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " selects % option " + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " (" + option.P.ToString(System.Globalization.CultureInfo.InvariantCulture) + "%), '"
                + EvalLog.SettingValueToLogString(SelectSettingValue(option.V, ctx.Setting.T)) + "'.");

            return new SettingResult
            {
                Value = option.V,
                VariationId = option.I,
                MatchedRule = matchedRule,
                MatchedOption = true,
            };
        }

        // Sum of widths < 100 — malformed; fail closed via the outer frame.
        throw new MalformedConfigException("Sum of percentage option percentages is less than 100.");
    }

    /// <summary>
    /// AND-grouped condition list; short-circuits on first non-match / error.
    /// Returns <c>true</c>, <c>false</c>, a <see cref="ValidationError"/>, or a
    /// <see cref="ComparisonValueError"/>. When <paramref name="rule"/> is
    /// non-null the rule's THEN consequence is traced (a bare segment passes
    /// <c>null</c>). Mirrors evaluator.ts <c>evaluateConditions</c>.
    /// </summary>
    private static object EvaluateConditions(
        IReadOnlyList<Condition> conditions,
        string contextSalt,
        EvalContext ctx,
        TargetingRuleModel? rule)
    {
        var lb = ctx.LogBuilder;
        object result = true;
        lb?.NewLine("- ");
        for (var i = 0; i < conditions.Count; i++)
        {
            var condition = conditions[i];
            if (lb is not null)
            {
                if (i == 0)
                {
                    lb.Append("IF ").IncreaseIndent();
                }
                else
                {
                    lb.IncreaseIndent().NewLine("AND ");
                }
            }

            if (condition.U is not null)
            {
                result = EvaluateUserCondition(condition.U, contextSalt, ctx);
            }
            else if (condition.P is not null)
            {
                result = EvaluatePrerequisiteCondition(condition.P, ctx);
            }
            else if (condition.S is not null)
            {
                result = EvaluateSegmentCondition(condition.S, ctx);
            }
            else
            {
                result = new ValidationError("empty condition");
            }

            if (lb is not null)
            {
                // The go-sdk oracle always shows the per-condition consequence
                // (even for a single-condition rule, where configcat-js omits
                // it) — match go.
                lb.AppendConditionConsequence(result is bool rb && rb);
                lb.DecreaseIndent();
            }

            if (result is not bool b || !b)
            {
                break;
            }
        }

        // When evaluating a targeting rule (not a bare segment), append its THEN
        // consequence. The go oracle always newlines THEN when the rule has
        // conditions.
        if (rule is not null && lb is not null)
        {
            var thenValue = rule.S is not null
                ? EvalLog.SettingValueToLogString(SelectSettingValue(rule.S.V, ctx.Setting.T))
                : null;
            var matchKind = result switch
            {
                bool rb when rb => MatchOrError.Match(),
                bool => MatchOrError.NoMatch(),
                ValidationError ve => MatchOrError.Err(ve.Message),
                ComparisonValueError cve => MatchOrError.Err(cve.Message),
                _ => MatchOrError.Err(string.Empty),
            };
            lb.AppendTargetingRuleConsequence(thenValue, matchKind, conditions.Count > 0);
        }

        return result;
    }

    private static object EvaluateUserCondition(
        UserCondition condition,
        string contextSalt,
        EvalContext ctx)
    {
        ctx.LogBuilder?.AppendUserCondition(condition);

        if (ctx.User is null)
        {
            SurfaceMissingUser(ctx);
            return new ValidationError(MissingUserObjectError);
        }

        var attrName = condition.A;
        var attrValue = attrName is null ? null : ctx.User.GetAttribute(attrName);
        if (attrName is null || attrValue is null || (attrValue is string emptyStr && emptyStr.Length == 0))
        {
            var msg = MissingUserAttributeError(attrName ?? string.Empty);
            ctx.State.EvalError ??= msg;
            // ConfigCat logs a WARN (event 3003) per targeting rule whose
            // attribute is missing — not deduped per evaluation.
            ctx.Log.UserObjectAttributeIsMissing(ctx.Key, attrName ?? string.Empty);
            return new ValidationError(msg);
        }

        var cmp = condition.C;
        var list = condition.L;
        var sv = condition.S ?? string.Empty;
        var dv = condition.D ?? 0.0;

        var outcome = DispatchComparator(cmp, attrName, attrValue, list, sv, dv, ctx.ConfigSalt, contextSalt, condition);
        switch (outcome)
        {
            case ValidationError ve when ve.Attribute is not null && ve.Reason is not null:
                // A typed-attribute conversion failure (bad semver / number /
                // datetime / array): record for FR-016 + emit WARN 3004.
                ctx.State.EvalError ??= ve.Message;
                ctx.Log.UserObjectAttributeIsInvalid(ctx.Key, ve.Attribute, ve.Reason);
                break;
            case ComparisonValueError cve:
                // A malformed CONFIG comparison value (#509): distinct WARN 3004
                // (no "please check the User.<attr>…" suffix).
                ctx.State.EvalError ??= cve.Message;
                ctx.Log.ComparisonValueIsInvalid(ctx.Key, cve.Message);
                break;
        }

        return outcome;
    }

    private static object DispatchComparator(
        int cmp,
        string attrName,
        object attrValue,
        IReadOnlyList<string> list,
        string sv,
        double dv,
        string salt,
        string contextSalt,
        UserCondition condition)
    {
        var text = Comparators.AttributeAsText(attrValue);
        switch (cmp)
        {
            case Comparators.TextEquals:
            case Comparators.TextNotEquals:
                return Comparators.EvaluateTextEquals(text, sv, cmp == Comparators.TextNotEquals);
            case Comparators.SensitiveTextEquals:
            case Comparators.SensitiveTextNotEquals:
                return Comparators.EvaluateSensitiveTextEquals(
                    text, sv, salt, contextSalt, cmp == Comparators.SensitiveTextNotEquals);
            case Comparators.TextIsOneOf:
            case Comparators.TextIsNotOneOf:
                return Comparators.EvaluateTextIsOneOf(text, list, cmp == Comparators.TextIsNotOneOf);
            case Comparators.SensitiveTextIsOneOf:
            case Comparators.SensitiveTextIsNotOneOf:
                return Comparators.EvaluateSensitiveTextIsOneOf(
                    text, list, salt, contextSalt, cmp == Comparators.SensitiveTextIsNotOneOf);
            case Comparators.TextStartsWithAnyOf:
            case Comparators.TextNotStartsWithAnyOf:
                return Comparators.EvaluateTextSliceEqualsAnyOf(
                    text, list, true, cmp == Comparators.TextNotStartsWithAnyOf);
            case Comparators.SensitiveTextStartsWithAnyOf:
            case Comparators.SensitiveTextNotStartsWithAnyOf:
                return Comparators.EvaluateSensitiveTextSliceEqualsAnyOf(
                    text, list, salt, contextSalt, true, cmp == Comparators.SensitiveTextNotStartsWithAnyOf);
            case Comparators.TextEndsWithAnyOf:
            case Comparators.TextNotEndsWithAnyOf:
                return Comparators.EvaluateTextSliceEqualsAnyOf(
                    text, list, false, cmp == Comparators.TextNotEndsWithAnyOf);
            case Comparators.SensitiveTextEndsWithAnyOf:
            case Comparators.SensitiveTextNotEndsWithAnyOf:
                return Comparators.EvaluateSensitiveTextSliceEqualsAnyOf(
                    text, list, salt, contextSalt, false, cmp == Comparators.SensitiveTextNotEndsWithAnyOf);
            case Comparators.TextContainsAnyOf:
            case Comparators.TextNotContainsAnyOf:
                return Comparators.EvaluateTextContainsAnyOf(text, list, cmp == Comparators.TextNotContainsAnyOf);
            case Comparators.SemVerIsOneOf:
            case Comparators.SemVerIsNotOneOf:
                {
                    var r = Comparators.AttributeAsSemVer(attrName, attrValue);
                    return r is Semver version
                        ? Comparators.EvaluateSemVerIsOneOf(version, list, cmp == Comparators.SemVerIsNotOneOf)
                        : r;
                }

            case Comparators.SemVerLess:
            case Comparators.SemVerLessOrEquals:
            case Comparators.SemVerGreater:
            case Comparators.SemVerGreaterOrEquals:
                {
                    // configcat-common validates the CONFIG comparison value
                    // BEFORE the user attribute (#509): a malformed operand wins
                    // even when the attribute is also malformed.
                    var cv = Comparators.ComparisonValueAsSemVer(sv);
                    if (cv is ComparisonValueError)
                    {
                        return cv;
                    }

                    var r = Comparators.AttributeAsSemVer(attrName, attrValue);
                    return r is Semver version
                        ? Comparators.EvaluateSemVerRelation(version, cmp, sv)
                        : r;
                }

            case Comparators.NumberEquals:
            case Comparators.NumberNotEquals:
            case Comparators.NumberLess:
            case Comparators.NumberLessOrEquals:
            case Comparators.NumberGreater:
            case Comparators.NumberGreaterOrEquals:
                {
                    var cv = Comparators.ComparisonValueAsNumber(condition.D);
                    if (cv is ComparisonValueError)
                    {
                        return cv;
                    }

                    var r = Comparators.AttributeAsNumber(attrName, attrValue);
                    return r is double num
                        ? Comparators.EvaluateNumberRelation(num, cmp, dv)
                        : r;
                }

            case Comparators.DateTimeBefore:
            case Comparators.DateTimeAfter:
                {
                    var cv = Comparators.ComparisonValueAsUnixTimeSeconds(condition.D);
                    if (cv is ComparisonValueError)
                    {
                        return cv;
                    }

                    var r = Comparators.AttributeAsUnixTimeSeconds(attrName, attrValue);
                    return r is double seconds
                        ? Comparators.EvaluateDateTimeRelation(seconds, dv, cmp == Comparators.DateTimeBefore)
                        : r;
                }

            case Comparators.ArrayContainsAnyOf:
            case Comparators.ArrayNotContainsAnyOf:
                {
                    var r = Comparators.AttributeAsStringArray(attrName, attrValue);
                    return r is IReadOnlyList<string> arr
                        ? Comparators.EvaluateArrayContainsAnyOf(arr, list, cmp == Comparators.ArrayNotContainsAnyOf)
                        : r;
                }

            case Comparators.SensitiveArrayContainsAnyOf:
            case Comparators.SensitiveArrayNotContainsAnyOf:
                {
                    var r = Comparators.AttributeAsStringArray(attrName, attrValue);
                    return r is IReadOnlyList<string> arr
                        ? Comparators.EvaluateSensitiveArrayContainsAnyOf(
                            arr, list, salt, contextSalt, cmp == Comparators.SensitiveArrayNotContainsAnyOf)
                        : r;
                }

            default:
                return new ValidationError($"unknown comparator {cmp}");
        }
    }

    private static bool EvaluatePrerequisiteCondition(PrerequisiteCondition condition, EvalContext ctx)
    {
        var lb = ctx.LogBuilder;
        if (lb is not null && condition.F is not null)
        {
            int? prereqType = ctx.Settings.TryGetValue(condition.F, out var s) && s is not null ? s.T : null;
            var cmpVal = prereqType is not null ? SelectSettingValue(condition.V, prereqType.Value) : null;
            lb.AppendPrerequisiteFlagCondition(
                condition.F,
                condition.C,
                cmpVal is not null ? EvalLog.SettingValueToLogString(cmpVal) : string.Empty);
        }

        return Prerequisites.EvaluatePrerequisiteFlagCondition(
            condition,
            ctx.Key,
            ctx.VisitedFlags,
            prereqKey => ctx.Settings.TryGetValue(prereqKey, out var s) && s is not null ? s.T : (int?)null,
            prereqKey =>
            {
                if (!ctx.Settings.TryGetValue(prereqKey, out var prereqSetting) || prereqSetting is null)
                {
                    throw new MalformedConfigException("Prerequisite flag is missing or invalid.");
                }

                // The prerequisite evaluates in its OWN state (fresh
                // MissingUserObjectLogged) so a prereq referenced by N rules
                // logs WARN 3001 N times, not once (common-js parity). Seed the
                // parent's first surfaced error in; bubble any new one back.
                var childState = new EvalState { EvalError = ctx.State.EvalError };
                var child = ctx.WithChild(prereqKey, prereqSetting, childState);

                // The trace re-enters the full evaluation nested in `( … )`
                // (go-sdk oracle structure): the child appends its own
                // "Evaluating '<key>' …" header + "Returning …".
                if (lb is not null)
                {
                    lb.NewLine("(").IncreaseIndent().NewLine("Evaluating '" + prereqKey + "'");
                    if (ctx.User is not null)
                    {
                        lb.Append(" for User '" + UserAttributesForLogJson(ctx.User) + "'");
                    }
                }

                var childResult = EvaluateSetting(child);
                if (lb is not null)
                {
                    var childValue = SelectSettingValue(childResult.Value, prereqSetting.T);
                    lb.NewLine("Returning '" + EvalLog.SettingValueToLogString(childValue) + "'.")
                        .DecreaseIndent()
                        .NewLine(")");
                }

                ctx.State.EvalError ??= childState.EvalError;
                return childResult.Value;
            },
            SelectSettingValue);
    }

    private static object EvaluateSegmentCondition(SegmentCondition condition, EvalContext ctx)
    {
        var lb = ctx.LogBuilder;
        var index = condition.S;
        var segment = index >= 0 && index < ctx.Segments.Count ? ctx.Segments[index] : null;
        var segmentName = segment?.N ?? string.Empty;
        lb?.AppendSegmentCondition(segmentName, condition.C);

        if (ctx.User is null)
        {
            SurfaceMissingUser(ctx);
            return new ValidationError(MissingUserObjectError);
        }

        if (segment is null)
        {
            throw new MalformedConfigException("Segment reference is invalid.");
        }

        if (string.IsNullOrEmpty(segmentName))
        {
            throw new MalformedConfigException("Segment name is missing.");
        }

        lb?.NewLine("(").IncreaseIndent().NewLine("Evaluating segment '" + segmentName + "':");

        // The segment's AND-grouped bare user conditions, traced via the shared
        // EvaluateConditions path (segment name = the sensitive-comparator salt).
        var wrapped = new List<Condition>(segment.R.Count);
        foreach (var uc in segment.R)
        {
            wrapped.Add(new Condition { U = uc });
        }

        var inSegment = EvaluateConditions(wrapped, segmentName!, ctx, null);

        // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
        object result = inSegment;
        if (inSegment is bool membership && condition.C == Segments.SegmentIsNotIn)
        {
            result = !membership;
        }

        if (lb is not null)
        {
            lb.NewLine("Segment evaluation result: ");
            if (inSegment is bool b)
            {
                lb.Append(b ? "User IS IN SEGMENT" : "User IS NOT IN SEGMENT");
            }
            else
            {
                lb.Append(SegmentErrorMessage(inSegment));
            }

            lb.Append(".");
            lb.NewLine("Condition (").AppendSegmentCondition(segmentName, condition.C).Append(")");
            if (result is bool rb)
            {
                lb.Append(" evaluates to ").AppendConditionResult(rb);
            }
            else
            {
                lb.Append(" failed to evaluate");
            }

            lb.Append(".").DecreaseIndent().NewLine(")");
        }

        return result;
    }

    private static string SegmentErrorMessage(object error) => error switch
    {
        ValidationError ve => ve.Message,
        ComparisonValueError cve => cve.Message,
        _ => string.Empty,
    };

    /// <summary>
    /// Read the typed value out of a <c>v</c> envelope by the setting's
    /// <c>t</c>. Mirrors <c>evaluator.ts::selectSettingValue</c>: the key is
    /// chosen from <c>t</c>, never from the runtime shape. The double case
    /// returns only the <c>d</c> slot (no int-slot fallback), matching the
    /// TS reference so a malformed double setting resolves as malformed.
    /// </summary>
    private static object? SelectSettingValue(SettingValue? value, int settingType)
    {
        if (value is null)
        {
            return null;
        }

        return settingType switch
        {
            SettingTypeBool => value.B,
            SettingTypeString => value.S,
            SettingTypeInt => value.I,
            SettingTypeDouble => value.D,
            _ => null,
        };
    }

    private static void SurfaceMissingUser(EvalContext ctx)
    {
        ctx.State.EvalError ??= MissingUserObjectError;

        // ConfigCat logs the no-user WARN (event 3001) once per context. A
        // prerequisite flag evaluates in its OWN context (fresh state), so a
        // prereq referenced by N rules logs it N times (common-js parity).
        if (!ctx.State.MissingUserObjectLogged)
        {
            ctx.Log.UserObjectIsMissing(ctx.Key);
            ctx.State.MissingUserObjectLogged = true;
        }
    }

    private static string MissingUserAttributeError(string attr) =>
        $"cannot evaluate, the User.{attr} attribute is missing";

    /// <summary>
    /// Per-type resolution arm — the strict dual-entry-point decision tree
    /// (#257) runs UNCHANGED on the resolved envelope, whatever its source
    /// (rule / % / static). <paramref name="defaultValue"/> is inspected via
    /// <c>is</c> pattern matching.
    /// </summary>
    private static EvaluationResult ResolveTyped(
        int settingType,
        SettingResult result,
        object? defaultValue,
        string? variationId,
        string? evalError)
    {
        var value = result.Value;
        if (value is null)
        {
            return new EvaluationResult { Value = defaultValue, Error = EvaluationError.MalformedValue };
        }

        EvaluationResult Ok(object resolved) => new()
        {
            Value = resolved,
            Error = EvaluationError.None,
            VariationId = variationId,
            MatchedRule = result.MatchedRule,
            MatchedOption = result.MatchedOption,
            EvalError = evalError,
        };

        switch (settingType)
        {
            case SettingTypeBool:
                if (defaultValue is not null and not bool)
                {
                    return new EvaluationResult { Value = defaultValue, Error = EvaluationError.TypeMismatch };
                }

                return value.B.HasValue
                    ? Ok(value.B.Value)
                    : new EvaluationResult { Value = defaultValue, Error = EvaluationError.MalformedValue };

            case SettingTypeString:
                if (defaultValue is not null and not string)
                {
                    return new EvaluationResult { Value = defaultValue, Error = EvaluationError.TypeMismatch };
                }

                return value.S is not null
                    ? Ok(value.S)
                    : new EvaluationResult { Value = defaultValue, Error = EvaluationError.MalformedValue };

            case SettingTypeInt:
                if (defaultValue is not null and not int)
                {
                    return new EvaluationResult { Value = defaultValue, Error = EvaluationError.TypeMismatch };
                }

                return value.I.HasValue
                    ? Ok(value.I.Value)
                    : new EvaluationResult { Value = defaultValue, Error = EvaluationError.MalformedValue };

            case SettingTypeDouble:
                if (defaultValue is not null and not double)
                {
                    return new EvaluationResult { Value = defaultValue, Error = EvaluationError.TypeMismatch };
                }

                // JSON integral doubles decode as int; widen to double.
                if (value.D.HasValue)
                {
                    return Ok(value.D.Value);
                }

                return value.I.HasValue
                    ? Ok((double)value.I.Value)
                    : new EvaluationResult { Value = defaultValue, Error = EvaluationError.MalformedValue };

            default:
                return new EvaluationResult { Value = defaultValue, Error = EvaluationError.UnsupportedType };
        }
    }
}

/// <summary>
/// Internal wire-shape record for a single setting. Mirrors the parsed
/// <c>config_v6.json</c> "f[key]" entry. Multi-TFM-safe; uses only BCL
/// primitives.
/// </summary>
internal sealed class Setting
{
    /// <summary>Type discriminator (0 = bool; 1 = string; 2 = int; 3 = double).</summary>
    public int T { get; init; }

    /// <summary>The setting value slot.</summary>
    public SettingValue? V { get; init; }

    /// <summary>Variation id (config_v6 <c>i</c>). Additive (spec 122).</summary>
    public string? VariationId { get; init; }

    /// <summary>Targeting rules (config_v6 <c>r</c>). Additive (spec 122).</summary>
    public IReadOnlyList<TargetingRuleModel> Rules { get; init; } = new List<TargetingRuleModel>();

    /// <summary>Setting-level percentage options (config_v6 <c>p</c>). Additive (spec 122).</summary>
    public IReadOnlyList<PercentageOptionModel> PercentageOptions { get; init; } =
        new List<PercentageOptionModel>();

    /// <summary>Percentage-options attribute (config_v6 <c>a</c>). Additive (spec 122).</summary>
    public string? PercentageAttr { get; init; }

    /// <summary>
    /// Top-level config salt (<c>p.s</c>), stamped on every setting by the
    /// parser so the evaluator can resolve sensitive comparators without a
    /// separate envelope parameter (keeps the production call sites — which
    /// only hold the settings dict — unchanged). Additive (spec 122).
    /// </summary>
    public string ConfigSalt { get; init; } = string.Empty;

    /// <summary>
    /// Top-level config segments (<c>s[]</c>), stamped on every setting by
    /// the parser for segment conditions. Additive (spec 122).
    /// </summary>
    public IReadOnlyList<Segment> Segments { get; init; } = new List<Segment>();
}

/// <summary>
/// Evaluation outcome envelope. Returned by <see cref="Evaluator.Evaluate{T}"/>.
/// </summary>
internal sealed class EvaluationResult
{
    /// <summary>The resolved typed value or the caller's default on failure.</summary>
    public object? Value { get; init; }

    /// <summary>The error class, or <see cref="EvaluationError.None"/> on happy path.</summary>
    public EvaluationError Error { get; init; } = EvaluationError.None;

    /// <summary>Variation id of the resolved value (rule / option / setting). Additive (spec 122).</summary>
    public string? VariationId { get; init; }

    /// <summary><c>true</c> when a targeting rule decided the value. Additive (spec 122).</summary>
    public bool MatchedRule { get; init; }

    /// <summary><c>true</c> when a percentage option decided the value. Additive (spec 122).</summary>
    public bool MatchedOption { get; init; }

    /// <summary>
    /// Informational rule-engine reason (missing user / attribute / validation)
    /// surfaced when a value WAS still resolved (FR-016); never sets
    /// <see cref="Error"/>. Additive (spec 122).
    /// </summary>
    public string? EvalError { get; init; }

    /// <summary><c>true</c> when <see cref="Error"/> is <see cref="EvaluationError.TypeMismatch"/>.</summary>
    public bool IsTypeMismatch => Error == EvaluationError.TypeMismatch;

    /// <summary><c>true</c> when <see cref="Error"/> is <see cref="EvaluationError.UnsupportedType"/>.</summary>
    public bool IsUnsupportedType => Error == EvaluationError.UnsupportedType;
}

/// <summary>
/// Discrete evaluation error classes. Mirrors the Go port's string codes
/// in a typed enum form.
/// </summary>
internal enum EvaluationError
{
    /// <summary>Happy path: a typed value was resolved cleanly.</summary>
    None = 0,

    /// <summary>The supplied configuration was <c>null</c>.</summary>
    NoConfig = 1,

    /// <summary>The key is absent from the settings map.</summary>
    KeyNotFound = 2,

    /// <summary>The setting type is not one of <c>0</c> / <c>1</c> / <c>2</c> / <c>3</c>.</summary>
    UnsupportedType = 3,

    /// <summary>The caller's default value does not match the setting's runtime type.</summary>
    TypeMismatch = 4,

    /// <summary>The setting value slot for the discriminated type is missing.</summary>
    MalformedValue = 5,

    /// <summary>
    /// An unexpected internal failure (incl. a detected prerequisite cycle or
    /// a malformed targeting reference) — the fail-closed catch-all (spec 122,
    /// FR-007 / SC-004).
    /// </summary>
    EvalException = 6,
}
