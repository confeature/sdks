// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;

namespace Confeature.Client.Internal;

/// <summary>
/// Duck-typed targeting-user view consumed by the evaluator (spec 122).
/// </summary>
/// <remarks>
/// The public <see cref="User"/> stringifies its custom attributes by
/// contract; the conformance corpus must feed typed custom attributes
/// (numbers, string arrays, epoch dates) un-stringified. This interface lets
/// both the production <see cref="User"/> (via <see cref="UserAttributes"/>)
/// and the corpus harness's typed user supply attributes through one read
/// path. Mirrors the duck-typed user of the TS / Python / Go / Ruby / PHP
/// ports.
/// </remarks>
internal interface IEvalUser
{
    /// <summary>The targeting identifier (never null; may be empty).</summary>
    string Identifier { get; }

    /// <summary>
    /// Read a named attribute, returning its native value (string / double /
    /// bool / <c>IReadOnlyList&lt;string&gt;</c> / <see cref="DateTime"/>) or
    /// <c>null</c> when absent. Well-known names <c>Identifier</c> /
    /// <c>Email</c> / <c>Country</c> resolve to the typed properties; all
    /// others come from the custom bag.
    /// </summary>
    object? GetAttribute(string name);

    /// <summary>
    /// The custom-attribute names in a deterministic order, for the eval-log
    /// header (<c>for User '{…}'</c>). Excludes the well-known
    /// Identifier / Email / Country. The corpus scenarios carry at most one
    /// custom key, so any total order is byte-identical to the oracle; a
    /// sorted order is the natural deterministic choice (mirrors the Go
    /// <c>customKeysInOrder</c>).
    /// </summary>
    IEnumerable<string> CustomKeysInOrder();
}

/// <summary>
/// Adapter exposing the public <see cref="User"/> through
/// <see cref="IEvalUser"/>. Custom attributes are <c>object</c>-typed (string /
/// number / string[] / DateTimeOffset), matching ConfigCat's <c>Custom</c>
/// surface (spec 151 / #468); the comparators convert each per ConfigCat. A
/// <c>string[]</c> is normalised to <c>IReadOnlyList&lt;string&gt;</c> so the
/// array comparators read it un-stringified.
/// </summary>
internal sealed class UserAttributes : IEvalUser
{
    private readonly User _user;

    public UserAttributes(User user) => _user = user;

    public string Identifier => _user.Identifier;

    public object? GetAttribute(string name)
    {
        switch (name)
        {
            case "Identifier":
                return _user.Identifier;
            case "Email":
                return _user.Email;
            case "Country":
                return _user.Country;
            default:
                if (!_user.Custom.TryGetValue(name, out var value))
                {
                    return null;
                }

                // A raw string[] is not an IReadOnlyList<string> the array
                // comparators recognise directly until boxed as such — normalise
                // it so the native-typed array path is taken (un-stringified).
                return value is string[] array ? (IReadOnlyList<string>)array : value;
        }
    }

    public IEnumerable<string> CustomKeysInOrder()
    {
        var keys = new List<string>(_user.Custom.Keys);
        keys.Sort(StringComparer.Ordinal);
        return keys;
    }
}

/// <summary>
/// A validation / conversion failure outcome (surfaced, not silent). The
/// condition dispatch returns this instead of true/false when a typed
/// attribute conversion fails (FR-010). Mirrors the TS <c>{ error }</c>
/// arm. An error short-circuits the AND group like <c>false</c> but is
/// surfaced via <see cref="EvaluationResult.EvalError"/>.
/// </summary>
internal sealed class ValidationError
{
    public ValidationError(string message)
        : this(message, null, null)
    {
    }

    public ValidationError(string message, string? attribute, string? reason)
    {
        Message = message;
        Attribute = attribute;
        Reason = reason;
    }

    public string Message { get; }

    /// <summary>
    /// The offending attribute name, when this is a typed-attribute conversion
    /// failure (drives the WARN 3004 <c>userObjectAttributeIsInvalid</c> trace
    /// line). <c>null</c> for the missing-user / missing-attribute outcomes.
    /// </summary>
    public string? Attribute { get; }

    /// <summary>The conversion-failure reason (the parenthesised text in the WARN).</summary>
    public string? Reason { get; }
}

/// <summary>
/// A malformed CONFIG comparison-value outcome (#509). configcat-common
/// validates the config operand BEFORE the user attribute for the semver /
/// number / datetime comparators; a malformed operand short-circuits the AND
/// group like <c>false</c> but is surfaced with a distinct WARN 3004
/// (<c>comparisonValueIsInvalid</c>, NO "please check the User.&lt;attr&gt;…"
/// suffix). Mirrors the TS <c>{ error }</c> from <c>invalidComparisonValue</c>.
/// </summary>
internal sealed class ComparisonValueError
{
    public ComparisonValueError(string message) => Message = message;

    /// <summary>The full <c>comparison value '&lt;v&gt;' is invalid (&lt;reason&gt;)</c> text.</summary>
    public string Message { get; }
}

/// <summary>Per-evaluation mutable state shared across recursion (FR-016).</summary>
internal sealed class EvalState
{
    /// <summary>First surfaced informational rule-engine reason; never sets the fail-closed error.</summary>
    public string? EvalError { get; set; }

    /// <summary>
    /// Dedups the no-user WARN 3001 to once per context (common-js parity). A
    /// prerequisite flag evaluates in its OWN context (fresh state), so a
    /// prereq referenced by N rules logs the WARN N times, but a single rule
    /// with multiple no-user conditions logs it once.
    /// </summary>
    public bool MissingUserObjectLogged { get; set; }
}

/// <summary>
/// The shared cycle-detection stack for prerequisite-flag resolution
/// (FR-007 / SC-004). A mutable holder shared across recursion levels.
/// </summary>
internal sealed class VisitedFlags
{
    private readonly List<string> _stack = new();

    public void Push(string key) => _stack.Add(key);

    public void Pop()
    {
        if (_stack.Count > 0)
        {
            _stack.RemoveAt(_stack.Count - 1);
        }
    }

    public bool Contains(string key) => _stack.Contains(key);

    public string Chain() => string.Join(" -> ", _stack);
}

/// <summary>Per-evaluation context threaded through the rule engine (spec 122).</summary>
internal sealed class EvalContext
{
    public EvalContext(
        string key,
        Setting setting,
        IReadOnlyDictionary<string, Setting> settings,
        IReadOnlyList<Segment> segments,
        string configSalt,
        IEvalUser? user,
        EvalState state,
        VisitedFlags visitedFlags,
        EvalTraceLog log,
        EvaluateLogBuilder? logBuilder)
    {
        Key = key;
        Setting = setting;
        Settings = settings;
        Segments = segments;
        ConfigSalt = configSalt;
        User = user;
        State = state;
        VisitedFlags = visitedFlags;
        Log = log;
        LogBuilder = logBuilder;
    }

    public string Key { get; }

    public Setting Setting { get; }

    public IReadOnlyDictionary<string, Setting> Settings { get; }

    public IReadOnlyList<Segment> Segments { get; }

    public string ConfigSalt { get; }

    public IEvalUser? User { get; }

    public EvalState State { get; }

    public VisitedFlags VisitedFlags { get; }

    /// <summary>
    /// The eval-log trace adapter (ADR 0003 / #501). Always non-null; a sink-less
    /// instance reports <c>Enabled == false</c> so the no-trace hot path is
    /// zero-cost (every trace append is guarded by <see cref="LogBuilder"/> being
    /// non-null).
    /// </summary>
    public EvalTraceLog Log { get; }

    /// <summary>
    /// The eval-log trace builder, present only when the sink is INFO-enabled.
    /// <c>null</c> means tracing is off — the rule walk skips every append.
    /// Shared across the recursion (a prerequisite re-evaluates nested in
    /// <c>( … )</c> on the SAME builder).
    /// </summary>
    public EvaluateLogBuilder? LogBuilder { get; }

    /// <summary>
    /// A child context for a prerequisite-flag re-evaluation. The prereq
    /// evaluates in its OWN <see cref="EvalState"/> (configcat
    /// <c>forPrerequisiteFlag</c>): the no-user WARN dedups per flag, so a
    /// prereq referenced by N rules logs it N times — hence the fresh state.
    /// The first surfaced <see cref="EvalState.EvalError"/> is seeded in and
    /// bubbled back by the caller (FR-016).
    /// </summary>
    public EvalContext WithChild(string key, Setting setting, EvalState childState) =>
        new(key, setting, Settings, Segments, ConfigSalt, User, childState, VisitedFlags, Log, LogBuilder);
}

/// <summary>Raw result of the rule walk: the resolved envelope + matched identity.</summary>
internal sealed class SettingResult
{
    public SettingValue? Value { get; init; }

    public string? VariationId { get; init; }

    public bool MatchedRule { get; init; }

    public bool MatchedOption { get; init; }
}

/// <summary>Internal exception: a malformed reference that must fail closed.</summary>
internal sealed class MalformedConfigException : Exception
{
    public MalformedConfigException(string message)
        : base(message)
    {
    }
}

/// <summary>Internal exception: a detected prerequisite cycle (bounds the recursion).</summary>
internal sealed class CircularDependencyException : Exception
{
    public CircularDependencyException(string message, string cycle)
        : base(message)
    {
        Cycle = cycle;
    }

    /// <summary>
    /// The detected dependency chain (e.g. <c>key2 -&gt; key3 -&gt; key2</c>),
    /// rendered into ConfigCat's ERROR 1002 line by the trace logger.
    /// </summary>
    public string Cycle { get; }
}
