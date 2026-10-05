// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Confeature.Client.Internal;

/// <summary>
/// Parses the wire <c>config_v6.json</c> body into an
/// <see cref="IReadOnlyDictionary{TKey, TValue}"/> the
/// <see cref="Evaluator"/> can consume.
/// </summary>
/// <remarks>
/// <para>
/// Parses the full config_v6 targeting tree (spec 122 / FR-014): rules
/// (<c>r</c>) with conditions (<c>c</c>: user <c>u</c> / prerequisite
/// <c>p</c> / segment <c>s</c>), percentage options (<c>p</c>), the
/// percentage attribute (<c>a</c>), the config-level salt (<c>p.s</c>), and
/// segment defs (<c>s</c>). The salt + segments are stamped on every parsed
/// <see cref="Setting"/> so the evaluator threads the envelope without a
/// signature change to the production call sites.
/// </para>
/// <para>
/// The parser is permissive — any malformed entry yields a Setting with a
/// non-bool type discriminator (today's sentinel) so the evaluator returns
/// the customer's default. Matches the Go / PHP evaluators' fail-closed
/// resilience model.
/// </para>
/// </remarks>
internal static class ConfigParser
{
    /// <summary>
    /// Returns the <c>f</c> map projected as
    /// <c>Dictionary&lt;string, Setting&gt;</c> (each setting stamped with the
    /// config-level salt + segments), or <c>null</c> when the body is
    /// unparseable.
    /// </summary>
    public static IReadOnlyDictionary<string, Setting>? Parse(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!body.TryGetProperty("f", out var settingsElement)
            || settingsElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var salt = ParseSalt(body);
        var segments = ParseSegments(body);

        var result = new Dictionary<string, Setting>(StringComparer.Ordinal);
        foreach (var prop in settingsElement.EnumerateObject())
        {
            result[prop.Name] = ParseSetting(prop.Value, salt, segments);
        }

        return result;
    }

    private static string ParseSalt(JsonElement body)
    {
        if (body.TryGetProperty("p", out var p)
            && p.ValueKind == JsonValueKind.Object
            && p.TryGetProperty("s", out var s)
            && s.ValueKind == JsonValueKind.String)
        {
            return s.GetString() ?? string.Empty;
        }

        return string.Empty;
    }

    private static List<Segment> ParseSegments(JsonElement body)
    {
        var segments = new List<Segment>();
        if (body.TryGetProperty("s", out var s) && s.ValueKind == JsonValueKind.Array)
        {
            foreach (var seg in s.EnumerateArray())
            {
                segments.Add(ParseSegment(seg));
            }
        }

        return segments;
    }

    private static Segment ParseSegment(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return new Segment();
        }

        string? name = null;
        if (element.TryGetProperty("n", out var n) && n.ValueKind == JsonValueKind.String)
        {
            name = n.GetString();
        }

        var rules = new List<UserCondition>();
        if (element.TryGetProperty("r", out var r) && r.ValueKind == JsonValueKind.Array)
        {
            foreach (var uc in r.EnumerateArray())
            {
                var parsed = ParseUserCondition(uc);
                if (parsed is not null)
                {
                    rules.Add(parsed);
                }
            }
        }

        return new Segment { N = name, R = rules };
    }

    private static Setting ParseSetting(
        JsonElement element,
        string salt,
        IReadOnlyList<Segment> segments)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            // Sentinel non-bool type so the evaluator returns default.
            return new Setting { T = -1, V = null, ConfigSalt = salt, Segments = segments };
        }

        int settingType = -1;
        if (element.TryGetProperty("t", out var tElement)
            && tElement.ValueKind == JsonValueKind.Number
            && tElement.TryGetInt32(out var tInt))
        {
            settingType = tInt;
        }

        SettingValue? value = null;
        if (element.TryGetProperty("v", out var vElement)
            && vElement.ValueKind == JsonValueKind.Object)
        {
            value = ParseSettingValue(vElement);
        }

        string? variationId = null;
        if (element.TryGetProperty("i", out var idElement)
            && idElement.ValueKind == JsonValueKind.String)
        {
            variationId = idElement.GetString();
        }

        string? percentageAttr = null;
        if (element.TryGetProperty("a", out var aElement)
            && aElement.ValueKind == JsonValueKind.String)
        {
            percentageAttr = aElement.GetString();
        }

        var rules = ParseRules(element);
        var percentageOptions = ParsePercentageOptions(element);

        return new Setting
        {
            T = settingType,
            V = value,
            VariationId = variationId,
            Rules = rules,
            PercentageOptions = percentageOptions,
            PercentageAttr = percentageAttr,
            ConfigSalt = salt,
            Segments = segments,
        };
    }

    private static List<TargetingRuleModel> ParseRules(JsonElement element)
    {
        var rules = new List<TargetingRuleModel>();
        if (!element.TryGetProperty("r", out var r) || r.ValueKind != JsonValueKind.Array)
        {
            return rules;
        }

        foreach (var rule in r.EnumerateArray())
        {
            if (rule.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var conditions = new List<Condition>();
            if (rule.TryGetProperty("c", out var c) && c.ValueKind == JsonValueKind.Array)
            {
                foreach (var cond in c.EnumerateArray())
                {
                    conditions.Add(ParseCondition(cond));
                }
            }

            ServedValue? served = null;
            if (rule.TryGetProperty("s", out var s) && s.ValueKind == JsonValueKind.Object)
            {
                served = ParseServedValue(s);
            }

            IReadOnlyList<PercentageOptionModel>? rulePct = null;
            if (rule.TryGetProperty("p", out var p) && p.ValueKind == JsonValueKind.Array)
            {
                rulePct = ParsePercentageOptionList(p);
            }

            rules.Add(new TargetingRuleModel { C = conditions, S = served, P = rulePct });
        }

        return rules;
    }

    private static Condition ParseCondition(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return new Condition();
        }

        UserCondition? u = null;
        if (element.TryGetProperty("u", out var uEl) && uEl.ValueKind == JsonValueKind.Object)
        {
            u = ParseUserCondition(uEl);
        }

        PrerequisiteCondition? p = null;
        if (element.TryGetProperty("p", out var pEl) && pEl.ValueKind == JsonValueKind.Object)
        {
            p = ParsePrerequisiteCondition(pEl);
        }

        SegmentCondition? s = null;
        if (element.TryGetProperty("s", out var sEl) && sEl.ValueKind == JsonValueKind.Object)
        {
            s = ParseSegmentCondition(sEl);
        }

        return new Condition { U = u, P = p, S = s };
    }

    private static UserCondition? ParseUserCondition(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        string? a = null;
        if (element.TryGetProperty("a", out var aEl) && aEl.ValueKind == JsonValueKind.String)
        {
            a = aEl.GetString();
        }

        int c = -1;
        if (element.TryGetProperty("c", out var cEl)
            && cEl.ValueKind == JsonValueKind.Number
            && cEl.TryGetInt32(out var cInt))
        {
            c = cInt;
        }

        string? s = null;
        if (element.TryGetProperty("s", out var sEl) && sEl.ValueKind == JsonValueKind.String)
        {
            s = sEl.GetString();
        }

        double? d = null;
        if (element.TryGetProperty("d", out var dEl)
            && dEl.ValueKind == JsonValueKind.Number
            && dEl.TryGetDouble(out var dDouble))
        {
            d = dDouble;
        }

        var list = new List<string>();
        var hasList = false;
        if (element.TryGetProperty("l", out var lEl) && lEl.ValueKind == JsonValueKind.Array)
        {
            hasList = true;
            foreach (var item in lEl.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    list.Add(item.GetString() ?? string.Empty);
                }
            }
        }

        return new UserCondition { A = a, C = c, S = s, D = d, L = list, HasL = hasList };
    }

    private static PrerequisiteCondition ParsePrerequisiteCondition(JsonElement element)
    {
        string? f = null;
        if (element.TryGetProperty("f", out var fEl) && fEl.ValueKind == JsonValueKind.String)
        {
            f = fEl.GetString();
        }

        int c = -1;
        if (element.TryGetProperty("c", out var cEl)
            && cEl.ValueKind == JsonValueKind.Number
            && cEl.TryGetInt32(out var cInt))
        {
            c = cInt;
        }

        SettingValue? v = null;
        if (element.TryGetProperty("v", out var vEl) && vEl.ValueKind == JsonValueKind.Object)
        {
            v = ParseSettingValue(vEl);
        }

        return new PrerequisiteCondition { F = f, C = c, V = v };
    }

    private static SegmentCondition ParseSegmentCondition(JsonElement element)
    {
        int s = -1;
        if (element.TryGetProperty("s", out var sEl)
            && sEl.ValueKind == JsonValueKind.Number
            && sEl.TryGetInt32(out var sInt))
        {
            s = sInt;
        }

        int c = -1;
        if (element.TryGetProperty("c", out var cEl)
            && cEl.ValueKind == JsonValueKind.Number
            && cEl.TryGetInt32(out var cInt))
        {
            c = cInt;
        }

        return new SegmentCondition { S = s, C = c };
    }

    private static List<PercentageOptionModel> ParsePercentageOptions(JsonElement element)
    {
        if (element.TryGetProperty("p", out var p) && p.ValueKind == JsonValueKind.Array)
        {
            return ParsePercentageOptionList(p);
        }

        return new List<PercentageOptionModel>();
    }

    private static List<PercentageOptionModel> ParsePercentageOptionList(JsonElement array)
    {
        var options = new List<PercentageOptionModel>();
        foreach (var opt in array.EnumerateArray())
        {
            if (opt.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            int width = 0;
            if (opt.TryGetProperty("p", out var pEl) && pEl.ValueKind == JsonValueKind.Number)
            {
                if (pEl.TryGetInt32(out var pInt))
                {
                    width = pInt;
                }
                else if (pEl.TryGetDouble(out var pDouble))
                {
                    width = (int)pDouble;
                }
            }

            SettingValue? v = null;
            if (opt.TryGetProperty("v", out var vEl) && vEl.ValueKind == JsonValueKind.Object)
            {
                v = ParseSettingValue(vEl);
            }

            string? i = null;
            if (opt.TryGetProperty("i", out var iEl) && iEl.ValueKind == JsonValueKind.String)
            {
                i = iEl.GetString();
            }

            options.Add(new PercentageOptionModel { P = width, V = v, I = i });
        }

        return options;
    }

    private static ServedValue ParseServedValue(JsonElement element)
    {
        SettingValue? v = null;
        if (element.TryGetProperty("v", out var vEl) && vEl.ValueKind == JsonValueKind.Object)
        {
            v = ParseSettingValue(vEl);
        }

        string? i = null;
        if (element.TryGetProperty("i", out var iEl) && iEl.ValueKind == JsonValueKind.String)
        {
            i = iEl.GetString();
        }

        return new ServedValue { V = v, I = i };
    }

    private static SettingValue ParseSettingValue(JsonElement element)
    {
        bool? b = null;
        string? s = null;
        int? i = null;
        double? d = null;

        if (element.TryGetProperty("b", out var bElement))
        {
            if (bElement.ValueKind == JsonValueKind.True)
            {
                b = true;
            }
            else if (bElement.ValueKind == JsonValueKind.False)
            {
                b = false;
            }
        }

        if (element.TryGetProperty("s", out var sElement)
            && sElement.ValueKind == JsonValueKind.String)
        {
            s = sElement.GetString();
        }

        if (element.TryGetProperty("i", out var iElement)
            && iElement.ValueKind == JsonValueKind.Number
            && iElement.TryGetInt32(out var iInt))
        {
            i = iInt;
        }

        if (element.TryGetProperty("d", out var dElement)
            && dElement.ValueKind == JsonValueKind.Number
            && dElement.TryGetDouble(out var dDouble))
        {
            d = dDouble;
        }

        return new SettingValue { B = b, S = s, I = i, D = d };
    }

    /// <summary>
    /// Parse a full <c>config_v6</c> body (the <c>{p, f, s}</c> envelope) into
    /// a <see cref="ConfigEnvelope"/>. Used by the conformance corpus harness,
    /// which feeds raw config JSON directly. Returns an empty envelope when
    /// the body is not a config object.
    /// </summary>
    public static ConfigEnvelope ParseEnvelope(JsonElement body)
    {
        var settings = Parse(body) ?? new Dictionary<string, Setting>(StringComparer.Ordinal);
        return new ConfigEnvelope
        {
            Settings = settings,
            Salt = ParseSalt(body),
            Segments = ParseSegments(body),
        };
    }

    /// <summary>Read a comparator <c>l</c> string list directly off a raw array element.</summary>
    internal static IReadOnlyList<string> ReadStringList(JsonElement element)
    {
        var list = new List<string>();
        if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    list.Add(item.GetString() ?? string.Empty);
                }
            }
        }

        return list;
    }

    /// <summary>Parse an invariant-culture integer from a string (helper, fail returns 0).</summary>
    internal static int ParseIntInvariant(string value) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;
}
