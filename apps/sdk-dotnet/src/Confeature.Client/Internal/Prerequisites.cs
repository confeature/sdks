// SPDX-License-Identifier: MIT

using System;

namespace Confeature.Client.Internal;

/// <summary>
/// Prerequisite-flag condition resolution + circular-dependency detection.
/// Ported from the spec-117 TS reference
/// (<c>packages/sdk-shared/src/prerequisites.ts</c>), cross-checked against
/// the spec-118/119/120/121 ports.
/// </summary>
/// <remarks>
/// The prerequisite flag is re-evaluated in a child context (same config /
/// user, SHARED <see cref="VisitedFlags"/> stack). Cycle detection pushes the
/// current key, checks for the prerequisite key BEFORE recursing — a revisit
/// pushes the prerequisite key and throws
/// <see cref="CircularDependencyException"/>, which the outer fail-closed
/// frame converts to a fallback + error (bounded; FR-007 / SC-004). The pop
/// runs in a <c>finally</c> so siblings restore even when a child throws.
/// </remarks>
internal static class Prerequisites
{
    public const int PrerequisiteEquals = 0;
    public const int PrerequisiteNotEquals = 1;

    /// <summary>
    /// Resolve one prerequisite-flag condition. The setting re-evaluator +
    /// value selector are injected. Returns the comparison result; throws
    /// <see cref="CircularDependencyException"/> on a detected cycle or
    /// <see cref="MalformedConfigException"/> on a missing prerequisite flag.
    /// </summary>
    public static bool EvaluatePrerequisiteFlagCondition(
        PrerequisiteCondition condition,
        string currentKey,
        VisitedFlags visitedFlags,
        Func<string, int?> prereqType,
        Func<string, SettingValue?> evaluatePrereqFlag,
        Func<SettingValue?, int, object?> selectValue)
    {
        var prereqKey = condition.F;
        if (prereqKey is null)
        {
            throw new MalformedConfigException("Prerequisite flag key is missing or invalid.");
        }

        var declaredType = prereqType(prereqKey);
        if (declaredType is null)
        {
            throw new MalformedConfigException("Prerequisite flag is missing or invalid.");
        }

        var comparisonValue = selectValue(condition.V, declaredType.Value);

        visitedFlags.Push(currentKey);
        if (visitedFlags.Contains(prereqKey))
        {
            // On the cycle path both Push calls run before the throw, leaving
            // a "dirty" VisitedFlags stack — the finally below only wraps the
            // child evaluation, which never runs here. This is harmless:
            // VisitedFlags is created fresh per EvaluateCore call and the outer
            // catch abandons it on the cycle path (siblings never continue past
            // a cycle throw), so the second Push only enriches the error chain.
            visitedFlags.Push(prereqKey);
            var cycle = visitedFlags.Chain();
            throw new CircularDependencyException(
                "Circular dependency detected between the following depending flags: " + cycle + ".",
                cycle);
        }

        SettingValue? resolvedEnvelope;
        try
        {
            resolvedEnvelope = evaluatePrereqFlag(prereqKey);
        }
        finally
        {
            visitedFlags.Pop();
        }

        var resolvedValue = selectValue(resolvedEnvelope, declaredType.Value);

        return condition.C switch
        {
            PrerequisiteEquals => Equals(resolvedValue, comparisonValue),
            PrerequisiteNotEquals => !Equals(resolvedValue, comparisonValue),
            _ => throw new MalformedConfigException("Comparison operator is missing or invalid."),
        };
    }
}
