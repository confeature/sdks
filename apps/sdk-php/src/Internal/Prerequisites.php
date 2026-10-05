<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Prerequisite-flag condition resolution + circular-dependency detection.
 * Ported from the spec-117 TS reference
 * (`packages/sdk-shared/src/prerequisites.ts`), cross-checked against the
 * spec-118/119/120 ports, itself from common-js
 * `RolloutEvaluator.evaluatePrerequisiteFlagCondition`.
 *
 * A prerequisite condition (`['f' => key, 'c' => comparator, 'v' => env]`)
 * is resolved by **re-evaluating the prerequisite flag** in a child context
 * (same config / user, SHARED `visitedFlags` list), then comparing its
 * resolved value to the expected `v` via the comparator (`Equals` /
 * `NotEquals`). Both the resolved value and `v` are read through the
 * prerequisite flag's own declared `SettingType`.
 *
 * **Cycle detection** uses the shared `visitedFlags` list: push the CURRENT
 * key, check whether the prerequisite key is already on the list BEFORE
 * recursing — if so, push the prerequisite key too and throw
 * {@link CircularDependencyException}. The outer `evaluate` rescue-all turns
 * that into a fail-closed fallback + error, so a cycle is **bounded** (the
 * key set is finite; the second visit throws) — never a hang, never a fatal
 * error escape (FR-007, SC-004). On the non-cycle path the current key is
 * popped after the child evaluation returns, restoring the list for siblings.
 */
final class Prerequisites
{
    public const PREREQUISITE_EQUALS = 0;
    public const PREREQUISITE_NOT_EQUALS = 1;

    private function __construct()
    {
    }

    /**
     * Resolve one prerequisite-flag condition. The setting re-evaluator +
     * value selector are injected so this module has no back-reference to the
     * evaluator. Returns the comparison result (`true` / `false`). Throws
     * {@link CircularDependencyException} on a detected cycle or
     * {@link MalformedConfigException} on a missing prerequisite flag.
     *
     * @param array<string, mixed>            $condition
     * @param callable(string):(int|null)     $prereqType
     * @param callable(string):mixed          $evaluatePrereqFlag   returns the resolved `v` envelope
     * @param callable(mixed, int):mixed      $selectValue
     */
    public static function evaluatePrerequisiteFlagCondition(
        array $condition,
        string $currentKey,
        VisitedFlags $visitedFlags,
        callable $prereqType,
        callable $evaluatePrereqFlag,
        callable $selectValue,
    ): bool {
        $prereqKey = $condition['f'] ?? null;
        if (!\is_string($prereqKey)) {
            throw new MalformedConfigException('Prerequisite flag key is missing or invalid.');
        }

        $declaredType = $prereqType($prereqKey);
        if ($declaredType === null) {
            throw new MalformedConfigException('Prerequisite flag is missing or invalid.');
        }

        // The expected comparison value `v`, read through the prereq's type.
        $comparisonValue = $selectValue($condition['v'] ?? null, $declaredType);

        // Cycle detection: push current key, detect a revisit BEFORE recursing.
        $visitedFlags->push($currentKey);
        if ($visitedFlags->contains($prereqKey)) {
            $visitedFlags->push($prereqKey);

            $chain = $visitedFlags->chain();

            throw new CircularDependencyException(
                'Circular dependency detected between the following depending flags: '
                . $chain . '.',
                $chain,
            );
        }

        // Restore the list for sibling prerequisites (common-js pops here).
        // The pop MUST run even if the child evaluation throws (a nested
        // MalformedConfigException or a deeper CircularDependencyException),
        // otherwise the shared stack leaks an entry and the "pop restores for
        // siblings" invariant breaks — hence the try/finally.
        try {
            $resolvedEnvelope = $evaluatePrereqFlag($prereqKey);
        } finally {
            $visitedFlags->pop();
        }

        $resolvedValue = $selectValue($resolvedEnvelope, $declaredType);

        return match ($condition['c'] ?? null) {
            self::PREREQUISITE_EQUALS => $resolvedValue === $comparisonValue,
            self::PREREQUISITE_NOT_EQUALS => $resolvedValue !== $comparisonValue,
            default => throw new MalformedConfigException('Comparison operator is missing or invalid.'),
        };
    }
}
