// SPDX-License-Identifier: MIT

/**
 * Segment-condition resolution (US4, research.md §R5/R6, ported from common-js
 * `RolloutEvaluator.evaluateSegmentCondition`, cross-checked against the PHP
 * reference `RolloutEvaluator::evaluateSegmentCondition`).
 *
 * A segment condition (`ISegmentCondition { s, c }`) references a segment by
 * index into the config's top-level `s[]` (`ISegment { n, r[] }`) and a
 * {@link SegmentComparator} (`IsIn` / `IsNotIn`). The segment's `r[]` entries
 * are **bare user conditions** (an `IUserCondition` each — NOT `ICondition`
 * wrappers), AND-grouped: the user IS-IN the segment iff every condition
 * matches. The membership decision is then optionally negated by `IsNotIn`.
 *
 * Two upstream shapes are supported with no code difference — the config_v6
 * (`testmatrix_segments.csv`) and legacy v5 (`testmatrix_segments_old.csv`)
 * blobs both carry segments as `{ n, r: IUserCondition[] }`, so the same walk
 * serves both (the only difference is the salted-hash operands, transparently
 * handled by the comparator layer).
 *
 * The **sensitive-comparator context salt is the segment NAME** (`segment.n`),
 * not the setting key — this is the crucial divergence from a user condition,
 * and getting it wrong silently breaks every hashed segment row.
 *
 * Three-valued outcome (data-model §3): `true` (in segment per the comparator),
 * `false` (not in segment per the comparator), or `{ error }` (no user /
 * missing attribute). An error is returned **un-negated** — `IsNotIn` does not
 * flip an error into a match (matches common-js: the comparator switch only
 * runs when the segment result is not a string error).
 */

import type { ConditionOutcome } from "./evaluator.ts";
import {
  type ISegment,
  type ISegmentCondition,
  type IUserCondition,
  SegmentComparator,
} from "./config-json.ts";

/**
 * Resolve one segment condition. `evaluateUserCondition` is injected (the
 * evaluator owns it) so this module has no back-reference to the
 * `RolloutEvaluator` class; it receives the segment list + a no-user surfacer
 * and the per-user-condition evaluator.
 *
 * @param condition       the segment condition (`{ s: index, c: comparator }`).
 * @param segments        the config's top-level segment list (`IConfig.s`).
 * @param hasUser         whether a user context is present.
 * @param surfaceMissingUser  surfaces the once-per-context missing-user log.
 * @param evaluateUserCondition  evaluates one segment `r[]` user condition with
 *                               the segment name as the context salt.
 */
export function evaluateSegmentCondition(
  condition: ISegmentCondition,
  segments: readonly ISegment[],
  hasUser: boolean,
  surfaceMissingUser: () => string,
  evaluateUserCondition: (uc: IUserCondition, contextSalt: string) => ConditionOutcome,
): ConditionOutcome {
  // No user → the whole segment condition is the missing-user error (surfaced
  // once per context), exactly like a user condition.
  if (!hasUser) {
    return { error: surfaceMissingUser() };
  }

  const index = condition.s;
  if (typeof index !== "number" || index < 0 || index >= segments.length) {
    // A malformed segment reference is a fatal config error → throw so the
    // outer fail-closed frame returns the default (common-js throws here).
    throw new Error("Segment reference is invalid.");
  }
  const segment = segments[index] as ISegment;
  const segmentName = segment.n;
  if (typeof segmentName !== "string" || segmentName === "") {
    throw new Error("Segment name is missing.");
  }

  // The segment's `r[]` is an AND-group of BARE user conditions; the context
  // salt is the segment NAME. Short-circuit on the first non-match / error.
  let inSegment: ConditionOutcome = true;
  for (const uc of segment.r as readonly IUserCondition[]) {
    inSegment = evaluateUserCondition(uc, segmentName);
    if (inSegment !== true) break;
  }

  // An error (missing attribute, etc.) is returned un-negated — IsNotIn never
  // converts an error into a match.
  if (inSegment !== true && inSegment !== false) return inSegment;

  return condition.c === SegmentComparator.IsNotIn ? !inSegment : inSegment;
}
