// SPDX-License-Identifier: MIT

import Foundation

/// Prerequisite-flag condition resolution + circular-dependency detection
/// (US4; FR-007, SC-004), ported from
/// `packages/sdk-shared/src/prerequisites.ts`.
///
/// A prerequisite condition (`{ f, c, v }`) is resolved by re-evaluating the
/// prerequisite flag `f` in a child context (same config / user, SHARED
/// `visitedFlags` stack), then comparing its resolved value to the expected
/// `v` through the prerequisite flag's own declared `SettingType`.
///
/// Cycle detection uses the shared `visitedFlags` array: push the CURRENT key,
/// check whether the prerequisite key is already on the stack BEFORE
/// recursing — if so, throw the cycle error. The outer `evaluate` catch turns
/// that throw into fallback + error, so a cycle is bounded (the key set is
/// finite). On the non-cycle path the current key is POPPED after the child
/// evaluation returns, restoring the stack for sibling prerequisites.
enum Prerequisites {
    static let equals = 0
    static let notEquals = 1

    /// Shared mutable cycle-detection stack.
    final class VisitedFlags {
        var stack: [String] = []
        func push(_ key: String) { stack.append(key) }
        func pop() { _ = stack.popLast() }
        func contains(_ key: String) -> Bool { stack.contains(key) }
        func joined() -> String { stack.joined(separator: " -> ") }
    }

    /// Resolve one prerequisite-flag condition. The setting re-evaluator +
    /// value selector are injected. Throws on a detected cycle or a missing
    /// prerequisite flag.
    static func evaluate(
        condition: [String: Any],
        currentKey: String,
        visited: VisitedFlags,
        prereqType: (String) -> Int?,
        evaluatePrereqFlag: (String) throws -> [String: Any],
        selectValue: (_ valueSlot: [String: Any]?, _ type: Int) -> Any?
    ) throws -> MatchOutcome {
        guard let prereqKey = condition["f"] as? String else {
            throw EvalError.malformedConfig("Prerequisite flag key is missing or invalid.")
        }
        guard let declaredType = prereqType(prereqKey) else {
            throw EvalError.malformedConfig("Prerequisite flag is missing or invalid.")
        }

        let comparisonValue = selectValue(condition["v"] as? [String: Any], declaredType)

        visited.push(currentKey)
        if visited.contains(prereqKey) {
            visited.push(prereqKey)
            let cycle = visited.joined()
            throw EvalError.circularDependency(
                "Circular dependency detected between the following depending flags: \(cycle).")
        }

        // Restore the stack for sibling prerequisites — via `defer` so the
        // pop runs even if the child evaluation throws (a nested malformed
        // config or a deeper cycle), keeping the shared stack consistent.
        defer { visited.pop() }
        let resolvedEnvelope = try evaluatePrereqFlag(prereqKey)

        let resolvedValue = selectValue(resolvedEnvelope, declaredType)

        let comparator = Evaluator.readInt(condition["c"]) ?? -1
        switch comparator {
        case equals:
            return Evaluator.anyEqual(resolvedValue, comparisonValue) ? .match : .noMatch
        case notEquals:
            return Evaluator.anyEqual(resolvedValue, comparisonValue) ? .noMatch : .match
        default:
            throw EvalError.malformedConfig("Comparison operator is missing or invalid.")
        }
    }
}
