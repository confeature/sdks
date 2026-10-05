// SPDX-License-Identifier: MIT

// Prerequisite-flag condition resolution + circular-dependency detection.
//
// Ported from the spec-117 TS reference
// (packages/sdk-shared/src/prerequisites.ts), itself from common-js
// RolloutEvaluator.evaluatePrerequisiteFlagCondition.
//
// A prerequisite condition ({"f": key, "c": comparator, "v": envelope}) is
// resolved by re-evaluating the prerequisite flag in a child context (same
// config / user, SHARED visitedFlags slice), then comparing its resolved value
// to the expected v via the comparator (Equals / NotEquals). Both the resolved
// value and v are read through the prerequisite flag's own declared SettingType.
//
// Cycle detection uses the shared visitedFlags slice: append the CURRENT key,
// check whether the prerequisite key is already on the slice BEFORE recursing —
// if so, append the prerequisite key too and return errCircularDependency. The
// outer Evaluate guard turns that into a fail-closed fallback + error, so a
// cycle is bounded (the key set is finite; the second visit returns the error) —
// never a hang, never a stack-overflow escape (FR-007, SC-004). On the
// non-cycle path the current key is popped after the child evaluation returns,
// restoring the slice for sibling prerequisites.
package evaluator

import (
	"errors"
	"strings"
)

const (
	prerequisiteEquals    = 0
	prerequisiteNotEquals = 1
)

// circularDependencyError is returned on a detected prerequisite cycle (caught
// by Evaluate's fail-closed frame). It carries the visited cycle path
// (`a -> b -> a`) so the trace can surface ConfigCat's ERROR 1002 with the exact
// chain, mirroring eval-log.ts's CircularDependencyError.
type circularDependencyError struct{ cycle string }

func (e *circularDependencyError) Error() string {
	return "circular dependency detected between the following depending flags: " + e.cycle
}

// errPrerequisiteReference is a missing / invalid prerequisite flag — a fatal
// config error (fail-closed).
var errPrerequisiteReference = errors.New("prerequisite flag is missing or invalid")

// evaluatePrerequisiteFlagCondition resolves one prerequisite-flag condition.
// The setting re-evaluator + value selector are injected so this file has no
// back-reference to the rule walk.
//
// Returns the comparison result (true / false). Returns errCircularDependency on
// a detected cycle or errPrerequisiteReference on a missing prerequisite flag
// (the outer fail-closed frame converts the error to fallback + error).
func evaluatePrerequisiteFlagCondition(
	condition map[string]any,
	currentKey string,
	visitedFlags *[]string,
	prereqType func(key string) (int, bool),
	evaluatePrereqFlag func(key string) (map[string]any, error),
	selectValue func(value map[string]any, settingType int) (any, bool),
) (bool, error) {
	prereqKey, ok := condition["f"].(string)
	if !ok {
		return false, errPrerequisiteReference
	}
	declaredType, ok := prereqType(prereqKey)
	if !ok {
		return false, errPrerequisiteReference
	}

	// The expected comparison value v, read through the prereq flag's type.
	vEnvelope, _ := condition["v"].(map[string]any)
	comparisonValue, _ := selectValue(vEnvelope, declaredType)

	// Cycle detection: push current key, detect a revisit BEFORE recursing.
	*visitedFlags = append(*visitedFlags, currentKey)
	for _, k := range *visitedFlags {
		if k == prereqKey {
			*visitedFlags = append(*visitedFlags, prereqKey)
			return false, &circularDependencyError{cycle: strings.Join(*visitedFlags, " -> ")}
		}
	}

	resolvedEnvelope, err := evaluatePrereqFlag(prereqKey)
	if err != nil {
		return false, err
	}
	// Restore the slice for sibling prerequisites (common-js pops here).
	*visitedFlags = (*visitedFlags)[:len(*visitedFlags)-1]

	resolvedValue, _ := selectValue(resolvedEnvelope, declaredType)

	switch readIntOrZero(condition["c"]) {
	case prerequisiteEquals:
		return valuesEqual(resolvedValue, comparisonValue), nil
	case prerequisiteNotEquals:
		return !valuesEqual(resolvedValue, comparisonValue), nil
	default:
		return false, errPrerequisiteReference
	}
}

// valuesEqual compares two selected typed values for prerequisite equality.
// Both come from selectSettingValue so they are bool / string / float64 / int
// (or nil). A nil on either side compares unequal unless both are nil.
func valuesEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	// selectSettingValue normalizes numeric slots; compare via interface
	// equality which is correct for the comparable primitives produced here.
	return a == b
}
