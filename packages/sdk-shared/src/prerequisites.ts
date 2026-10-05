// SPDX-License-Identifier: MIT

/**
 * Prerequisite-flag condition resolution + circular-dependency detection
 * (US4, research.md §R6; FR-007, SC-004). Ported from common-js
 * `RolloutEvaluator.evaluatePrerequisiteFlagCondition`, cross-checked against
 * the PHP reference `RolloutEvaluator::evaluatePrerequisiteFlagCondition`.
 *
 * A prerequisite condition (`IPrerequisiteFlagCondition { f, c, v }`) is
 * resolved by **re-evaluating the prerequisite flag `f`** in a child
 * {@link EvaluateContext} (same config / user, SHARED `visitedFlags` stack),
 * then comparing its resolved value to the expected `v` via the
 * {@link PrerequisiteFlagComparator} (`Equals` / `NotEquals`). The comparison
 * reads both the resolved value and `v` through the prerequisite flag's own
 * declared `SettingType`, so a string prereq compares strings, a bool prereq
 * compares booleans, etc.
 *
 * **Cycle detection** uses the shared `visitedFlags: string[]` stack: push the
 * CURRENT key, check whether the prerequisite key is already on the stack
 * (`indexOf >= 0`) BEFORE recursing — if so, push the prerequisite key too and
 * THROW the "Circular dependency detected ... a -> b -> a" error. The outer
 * `evaluate` try/catch turns that throw into fallback + error outcome, so a
 * cycle is bounded (the key set is finite; the second visit throws), never a
 * hang or crash. On the non-cycle path the current key is POPPED after the
 * child evaluation returns, restoring the stack for sibling prerequisites.
 *
 * Multilevel chains (A needs B needs C) work naturally via the recursion: each
 * level pushes its key, recurses, pops. The `evaluationlog/prerequisite_flag`
 * (`dependentFeatureMultipleLevels`) and `circular_dep` (key1→key2→key3→key1)
 * scenarios are the proof.
 */

import {
  type IPrerequisiteFlagCondition,
  type ISettingValue,
  PrerequisiteFlagComparator,
  type SettingType,
} from "./config-json.ts";

/**
 * Resolve one prerequisite-flag condition. The setting re-evaluator + value
 * selector are injected so this module has no back-reference to the
 * `RolloutEvaluator` class.
 *
 * @param condition          the prerequisite condition (`{ f, c, v }`).
 * @param currentKey         the key currently being evaluated (pushed to the
 *                           cycle stack before recursing).
 * @param visitedFlags       the SHARED cycle-detection stack.
 * @param prereqType         resolver for a setting's declared `SettingType`.
 * @param evaluatePrereqFlag re-evaluates the prerequisite flag in a child
 *                           context, returning its resolved `ISettingValue`.
 * @param selectValue        selects the typed JS primitive from an
 *                           `ISettingValue` envelope by `SettingType`.
 * @returns `true` / `false` — the comparison result. Throws on a detected
 *          cycle or a missing prerequisite flag (the outer fail-closed frame
 *          converts the throw to fallback + error).
 */
/**
 * A prerequisite-flag chain that loops back on itself. Carries the visited
 * `cycle` path (`a -> b -> a`) so the top-level fail-closed frame can surface
 * ConfigCat's circular-dependency ERROR (event 1002) with the exact chain,
 * rather than a generic evaluation failure.
 */
export class CircularDependencyError extends Error {
  constructor(readonly cycle: string) {
    super(`Circular dependency detected between the following depending flags: ${cycle}.`);
    this.name = "CircularDependencyError";
  }
}

export function evaluatePrerequisiteFlagCondition(
  condition: IPrerequisiteFlagCondition,
  currentKey: string,
  visitedFlags: string[],
  prereqType: (key: string) => SettingType | undefined,
  evaluatePrereqFlag: (key: string) => ISettingValue,
  selectValue: (
    value: ISettingValue | undefined,
    type: SettingType,
  ) => boolean | string | number | undefined,
): boolean {
  const prereqKey = condition.f;
  if (typeof prereqKey !== "string") {
    throw new Error("Prerequisite flag key is missing or invalid.");
  }
  const declaredType = prereqType(prereqKey);
  if (declaredType === undefined) {
    throw new Error("Prerequisite flag is missing or invalid.");
  }

  // The expected comparison value `v`, read through the prereq flag's type.
  const comparisonValue = selectValue(condition.v, declaredType);

  // Cycle detection: push current key, detect a revisit before recursing.
  visitedFlags.push(currentKey);
  if (visitedFlags.indexOf(prereqKey) >= 0) {
    visitedFlags.push(prereqKey);
    throw new CircularDependencyError(visitedFlags.join(" -> "));
  }

  const resolvedEnvelope = evaluatePrereqFlag(prereqKey);
  // Restore the stack for sibling prerequisites (common-js pops here).
  visitedFlags.pop();

  const resolvedValue = selectValue(resolvedEnvelope, declaredType);

  switch (condition.c) {
    case PrerequisiteFlagComparator.Equals:
      return resolvedValue === comparisonValue;
    case PrerequisiteFlagComparator.NotEquals:
      return resolvedValue !== comparisonValue;
    default:
      throw new Error("Comparison operator is missing or invalid.");
  }
}
