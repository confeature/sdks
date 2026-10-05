// SPDX-License-Identifier: MIT

using System.Collections.Generic;

namespace Confeature.Client.Internal;

/// <summary>
/// Internal typed model of the parsed <c>config_v6.json</c> targeting tree
/// (spec 122 / FR-014). All types are additive: the public
/// <c>ConfeatureClient</c> / <c>EvaluationDetails&lt;T&gt;</c> surface is
/// unchanged. Mirrors the wire shapes in
/// <c>packages/sdk-shared/src/config-json.ts</c>; the rule engine
/// (<see cref="Evaluator"/>) consumes them.
/// </summary>
internal sealed class ConfigEnvelope
{
    /// <summary>Settings keyed by flag key (for prerequisite lookups).</summary>
    public IReadOnlyDictionary<string, Setting> Settings { get; init; } =
        new Dictionary<string, Setting>();

    /// <summary>Top-level config salt (<c>p.s</c>) for sensitive comparators.</summary>
    public string Salt { get; init; } = string.Empty;

    /// <summary>Top-level segment defs (<c>s[]</c>) for segment conditions.</summary>
    public IReadOnlyList<Segment> Segments { get; init; } = new List<Segment>();
}

/// <summary>A served value with its variation id — config_v6 <c>ServedValue</c> (<c>{v, i}</c>).</summary>
internal sealed class ServedValue
{
    /// <summary>The served value envelope.</summary>
    public SettingValue? V { get; init; }

    /// <summary>Variation id of the served value.</summary>
    public string? I { get; init; }
}

/// <summary>Targeting rule (config_v6 <c>TargetingRule</c>).</summary>
internal sealed class TargetingRuleModel
{
    /// <summary>Conditions (AND-grouped; the rule matches iff every one is true).</summary>
    public IReadOnlyList<Condition> C { get; init; } = new List<Condition>();

    /// <summary>The value served on match (mutually exclusive with <see cref="P"/>).</summary>
    public ServedValue? S { get; init; }

    /// <summary>Percentage options served on match (mutually exclusive with <see cref="S"/>).</summary>
    public IReadOnlyList<PercentageOptionModel>? P { get; init; }
}

/// <summary>A single condition (exactly one of user / prerequisite / segment is set).</summary>
internal sealed class Condition
{
    /// <summary>User comparator condition.</summary>
    public UserCondition? U { get; init; }

    /// <summary>Prerequisite-flag condition.</summary>
    public PrerequisiteCondition? P { get; init; }

    /// <summary>Segment condition.</summary>
    public SegmentCondition? S { get; init; }
}

/// <summary>User comparator condition (config_v6 <c>UserCondition</c>).</summary>
internal sealed class UserCondition
{
    /// <summary>Attribute name.</summary>
    public string? A { get; init; }

    /// <summary>Comparator discriminator.</summary>
    public int C { get; init; }

    /// <summary>String operand.</summary>
    public string? S { get; init; }

    /// <summary>Numeric operand.</summary>
    public double? D { get; init; }

    /// <summary>String-list operand.</summary>
    public IReadOnlyList<string> L { get; init; } = new List<string>();

    /// <summary>
    /// Whether the <c>l</c> (list) operand slot was present on the wire — used
    /// by the eval-log builder to distinguish a present-but-empty list
    /// (<c>[]</c>) from an absent one (<c>&lt;invalid value&gt;</c>), matching
    /// the TS <c>Array.isArray(values)</c> guard.
    /// </summary>
    public bool HasL { get; init; }
}

/// <summary>Prerequisite-flag condition (config_v6 <c>PrerequisiteFlagCondition</c>).</summary>
internal sealed class PrerequisiteCondition
{
    /// <summary>Prerequisite flag key.</summary>
    public string? F { get; init; }

    /// <summary>Comparator (0 = Equals, 1 = NotEquals).</summary>
    public int C { get; init; }

    /// <summary>Expected value envelope.</summary>
    public SettingValue? V { get; init; }
}

/// <summary>Segment condition (config_v6 <c>SegmentCondition</c>).</summary>
internal sealed class SegmentCondition
{
    /// <summary>Index into the config's top-level segment list.</summary>
    public int S { get; init; }

    /// <summary>Comparator (0 = IsIn, 1 = IsNotIn).</summary>
    public int C { get; init; }
}

/// <summary>Percentage option (config_v6 <c>PercentageOption</c>).</summary>
internal sealed class PercentageOptionModel
{
    /// <summary>Bucket width.</summary>
    public int P { get; init; }

    /// <summary>Served value envelope.</summary>
    public SettingValue? V { get; init; }

    /// <summary>Variation id.</summary>
    public string? I { get; init; }
}

/// <summary>Segment (config_v6 + legacy v5). Its <c>r[]</c> entries are bare user conditions.</summary>
internal sealed class Segment
{
    /// <summary>Segment name (the sensitive-comparator context salt for segment conds).</summary>
    public string? N { get; init; }

    /// <summary>AND-grouped bare user conditions.</summary>
    public IReadOnlyList<UserCondition> R { get; init; } = new List<UserCondition>();
}
