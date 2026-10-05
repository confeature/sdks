// SPDX-License-Identifier: MIT

import Foundation

/// Segment-condition resolution (US4), ported from
/// `packages/sdk-shared/src/segments.ts`.
///
/// A segment condition (`{ s: index, c: comparator }`) references a segment by
/// index into the config's top-level `s[]`. The segment's `r[]` entries are
/// **bare user conditions**, AND-grouped: the user IS-IN the segment iff every
/// condition matches. The membership decision is then optionally negated by
/// `IsNotIn`.
///
/// The **sensitive-comparator context salt is the segment NAME** (`segment.n`),
/// not the setting key — the crucial divergence from a user condition.
///
/// An error (no user / missing attribute) is returned **un-negated** —
/// `IsNotIn` does not flip an error into a match.
enum Segments {
    static let isIn = 0
    static let isNotIn = 1

    /// Resolve one segment condition. The per-user-condition evaluator is
    /// injected (the evaluator owns it). A malformed segment reference throws
    /// to the outer fail-closed frame.
    static func evaluate(
        condition: [String: Any],
        segments: [[String: Any]],
        hasUser: Bool,
        surfaceMissingUser: () -> String,
        evaluateUserCondition: ([String: Any], String) -> MatchOutcome
    ) throws -> MatchOutcome {
        if !hasUser {
            return .validationError(surfaceMissingUser())
        }

        guard let index = Evaluator.readInt(condition["s"]),
            index >= 0, index < segments.count
        else {
            throw EvalError.malformedConfig("Segment reference is invalid.")
        }
        let segment = segments[index]
        guard let segmentName = segment["n"] as? String, !segmentName.isEmpty else {
            throw EvalError.malformedConfig("Segment name is missing.")
        }
        let comparator = Evaluator.readInt(condition["c"]) ?? -1

        let conditions = segment["r"] as? [[String: Any]] ?? []
        var inSegment: MatchOutcome = .match
        for uc in conditions {
            inSegment = evaluateUserCondition(uc, segmentName)
            if case .match = inSegment { continue }
            break
        }

        // An error is returned un-negated.
        switch inSegment {
        case .validationError:
            return inSegment
        case .match:
            return comparator == isNotIn ? .noMatch : .match
        case .noMatch:
            return comparator == isNotIn ? .match : .noMatch
        }
    }
}
