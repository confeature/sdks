<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Segment-condition resolution (v6 + legacy v5). Ported from the spec-117 TS
 * reference (`packages/sdk-shared/src/segments.ts`), cross-checked against
 * the spec-118/119/120 ports, itself from common-js
 * `RolloutEvaluator.evaluateSegmentCondition`.
 *
 * A segment condition (`['s' => index, 'c' => comparator]`) references a
 * segment by index into the config's top-level `s[]`
 * (`['n' => name, 'r' => [...]]`) and a comparator (`IsIn` / `IsNotIn`). The
 * segment's `r[]` entries are **bare user conditions**, AND-grouped: the user
 * IS-IN the segment iff every condition matches. The decision is then
 * optionally negated by `IsNotIn`.
 *
 * The **sensitive-comparator context salt is the segment NAME** (`n`), NOT
 * the setting key — the crucial divergence from a user condition; getting it
 * wrong silently breaks every hashed segment row.
 *
 * Three-valued outcome: `true` (in segment per the comparator), `false` (not
 * in segment), or a {@link ValidationError}. An error is returned
 * **un-negated** — `IsNotIn` never flips an error into a match.
 */
final class Segments
{
    public const SEGMENT_IS_IN = 0;
    public const SEGMENT_IS_NOT_IN = 1;

    private function __construct()
    {
    }

    /**
     * Resolve one segment condition. `$evaluateUserCondition` is injected (the
     * evaluator owns it) so this module has no back-reference to the
     * evaluator; it evaluates one segment `r[]` user condition with the
     * segment NAME as the context salt.
     *
     * @param array<string, mixed>             $condition
     * @param list<array<string, mixed>>       $segments
     * @param callable():string                $surfaceMissingUser
     * @param callable(array<string,mixed>, string):(bool|ValidationError) $evaluateUserCondition
     */
    public static function evaluateSegmentCondition(
        array $condition,
        array $segments,
        bool $hasUser,
        callable $surfaceMissingUser,
        callable $evaluateUserCondition,
    ): bool|ValidationError {
        // No user → the whole segment condition is the missing-user error
        // (surfaced once per context), exactly like a user condition.
        if (!$hasUser) {
            return Comparators::error($surfaceMissingUser());
        }

        $index = $condition['s'] ?? null;
        if (!\is_int($index) || $index < 0 || $index >= \count($segments)) {
            throw new MalformedConfigException('Segment reference is invalid.');
        }

        $segment = $segments[$index];
        $segmentName = \is_array($segment) ? ($segment['n'] ?? null) : null;
        if (!\is_string($segmentName) || $segmentName === '') {
            throw new MalformedConfigException('Segment name is missing.');
        }

        // The segment's `r[]` is an AND-group of BARE user conditions; the
        // context salt is the segment NAME. Short-circuit on first non-match.
        $rules = $segment['r'] ?? [];
        $inSegment = true;
        if (\is_array($rules)) {
            foreach ($rules as $uc) {
                if (!\is_array($uc)) {
                    throw new MalformedConfigException('Segment condition is invalid.');
                }
                $inSegment = $evaluateUserCondition($uc, $segmentName);
                if ($inSegment !== true) {
                    break;
                }
            }
        }

        // An error is returned un-negated — IsNotIn never converts an error
        // into a match (matches common-js: the comparator switch only runs
        // when the segment result is a clean bool).
        if (!\is_bool($inSegment)) {
            return $inSegment;
        }

        return ($condition['c'] ?? null) === self::SEGMENT_IS_NOT_IN ? !$inSegment : $inSegment;
    }
}
