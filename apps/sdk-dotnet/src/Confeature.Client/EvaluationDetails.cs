// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client;

/// <summary>
/// Typed result envelope returned by
/// <see cref="ConfeatureClient.GetValueDetails{T}(string, T, User?)"/>,
/// <see cref="ConfeatureClient.GetValueDetailsAsync{T}(string, T, User?, System.Threading.CancellationToken)"/>,
/// and <see cref="ConfeatureSnapshot.GetValueDetails{T}(string, T, User?)"/>.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors upstream <c>ConfigCat.Client.EvaluationDetails&lt;T&gt;</c>
/// 1:1 field-for-field (spec 083 / #266). Consumers migrating from
/// <c>ConfigCat.Client</c> keep their property reads (<c>.Key</c>,
/// <c>.Value</c>, <c>.IsDefaultValue</c>, <c>.ErrorMessage</c>, ...)
/// unchanged. Property naming exactly matches upstream — <c>ErrorMessage</c>
/// (NOT <c>Error</c>), <c>FetchTime</c> as <see cref="DateTime"/>
/// (NOT <c>long</c> millis).
/// </para>
/// <para>
/// The evaluation engine populates <see cref="VariationId"/>,
/// <see cref="MatchedTargetingRule"/>, and
/// <see cref="MatchedPercentageOption"/> when a targeting rule or
/// percentage option decides the value: <see cref="MatchedTargetingRule"/>
/// is set when a targeting rule decides the value,
/// <see cref="MatchedPercentageOption"/> when a percentage option does,
/// and <see cref="VariationId"/> carries the variation ID of the matched
/// rule / option / setting. Each is left <c>null</c> when not applicable.
/// </para>
/// </remarks>
/// <typeparam name="T">
/// Resolved value type. Type-erased helpers use
/// <see cref="EvaluationDetails{T}"/> with <c>T = object?</c>.
/// </typeparam>
public sealed record class EvaluationDetails<T>
{
    /// <summary>Flag key the consumer asked for; echoed verbatim even on errors.</summary>
    public string Key { get; init; } = string.Empty;

    /// <summary>
    /// Evaluated value of the flag. On any failure path this is the
    /// caller's <c>defaultValue</c>, and <see cref="IsDefaultValue"/> is
    /// then <c>true</c>.
    /// </summary>
    public T Value { get; init; } = default!;

    /// <summary>
    /// Variation ID of the matched targeting rule, percentage option, or
    /// setting that decided the value. <c>null</c> when the config carries
    /// no variation ID for the resolved value.
    /// </summary>
    public string? VariationId { get; init; }

    /// <summary>
    /// Time of last successful config download (or <c>default</c> /
    /// <see cref="DateTime.MinValue"/> if there has been no successful
    /// download yet). UTC wall-clock; same value across all
    /// <see cref="EvaluationDetails{T}"/> served by a given
    /// <see cref="ConfeatureSnapshot"/>.
    /// </summary>
    public DateTime FetchTime { get; init; }

    /// <summary>
    /// The <see cref="Client.User"/> passed to <c>GetValueDetails</c>
    /// (or <c>DefaultUser</c> when none was passed).
    /// </summary>
    public User? User { get; init; }

    /// <summary>
    /// <c>true</c> when the accessor returned the supplied
    /// <c>defaultValue</c> for any reason (missing key, type mismatch,
    /// closed client, malformed config / value, unsupported type).
    /// </summary>
    public bool IsDefaultValue { get; init; }

    /// <summary>
    /// Stable evaluator error code on every fail branch; <c>null</c> on
    /// the happy path. Codes match the parity corpus' tier-0 set:
    /// <c>KEY_NOT_FOUND</c> / <c>TYPE_MISMATCH</c> / <c>MALFORMED_VALUE</c>
    /// / <c>UNSUPPORTED_TYPE</c> / <c>NO_CONFIG</c> / <c>CLIENT_CLOSED</c>.
    /// </summary>
    public string? ErrorMessage { get; init; }

    /// <summary>
    /// The targeting rule that decided the value, or <c>null</c> when no
    /// targeting rule decided it.
    /// </summary>
    public TargetingRule? MatchedTargetingRule { get; init; }

    /// <summary>
    /// The percentage option that decided the value, or <c>null</c> when no
    /// percentage option decided it.
    /// </summary>
    public PercentageOption? MatchedPercentageOption { get; init; }
}
