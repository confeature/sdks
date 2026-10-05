// SPDX-License-Identifier: MIT

using System;
using System.Collections.Generic;

namespace Confeature.Client.Internal;

/// <summary>
/// Segment-condition resolution (v6 + legacy v5). Ported from the spec-117 TS
/// reference (<c>packages/sdk-shared/src/segments.ts</c>), cross-checked
/// against the spec-118/119/120/121 ports.
/// </summary>
/// <remarks>
/// A segment's <c>r[]</c> entries are <b>bare user conditions</b>, AND-grouped:
/// the user IS-IN the segment iff every condition matches. The
/// sensitive-comparator context salt is the segment NAME (not the setting
/// key). A <see cref="ValidationError"/> is returned <b>un-negated</b> —
/// <c>IsNotIn</c> never flips an error into a match.
/// </remarks>
internal static class Segments
{
    public const int SegmentIsIn = 0;
    public const int SegmentIsNotIn = 1;

    /// <summary>
    /// Resolve one segment condition. <paramref name="evaluateUserCondition"/>
    /// is injected by the evaluator (segment name as context salt). Returns a
    /// bool match or a <see cref="ValidationError"/>.
    /// </summary>
    public static object EvaluateSegmentCondition(
        SegmentCondition condition,
        IReadOnlyList<Segment> segments,
        bool hasUser,
        Func<string> surfaceMissingUser,
        Func<UserCondition, string, object> evaluateUserCondition)
    {
        if (!hasUser)
        {
            return new ValidationError(surfaceMissingUser());
        }

        var index = condition.S;
        if (index < 0 || index >= segments.Count)
        {
            throw new MalformedConfigException("Segment reference is invalid.");
        }

        var segment = segments[index];
        var segmentName = segment.N;
        if (string.IsNullOrEmpty(segmentName))
        {
            throw new MalformedConfigException("Segment name is missing.");
        }

        object inSegment = true;
        foreach (var uc in segment.R)
        {
            inSegment = evaluateUserCondition(uc, segmentName!);
            if (inSegment is not bool b || !b)
            {
                break;
            }
        }

        // An error is returned un-negated.
        if (inSegment is not bool membership)
        {
            return inSegment;
        }

        return condition.C == SegmentIsNotIn ? !membership : membership;
    }
}
