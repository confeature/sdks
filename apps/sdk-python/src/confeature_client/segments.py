# SPDX-License-Identifier: MIT
"""Segment-condition resolution (v6 + legacy v5).

Ported from the spec-117 TS reference (`packages/sdk-shared/src/segments.ts`),
itself from common-js ``RolloutEvaluator.evaluateSegmentCondition``.

A segment condition (``{"s": index, "c": comparator}``) references a segment by
index into the config's top-level ``s[]`` (``{"n": name, "r": [...]}``) and a
``SegmentComparator`` (``IsIn`` / ``IsNotIn``). The segment's ``r[]`` entries
are **bare user conditions** (each an ``IUserCondition``), AND-grouped: the user
IS-IN the segment iff every condition matches. The decision is then optionally
negated by ``IsNotIn``.

The **sensitive-comparator context salt is the segment NAME** (``segment["n"]``),
NOT the setting key — the crucial divergence from a user condition; getting it
wrong silently breaks every hashed segment row.

Three-valued outcome: ``True`` (in segment per the comparator), ``False`` (not
in segment), or :class:`~confeature_client.comparators.Error`. An error is
returned **un-negated** — ``IsNotIn`` never flips an error into a match.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .comparators import ConditionOutcome, Error

SEGMENT_IS_IN = 0
SEGMENT_IS_NOT_IN = 1


class SegmentReferenceError(Exception):
    """A malformed segment reference / name — a fatal config error (fail-closed)."""


def evaluate_segment_condition(
    condition: dict[str, Any],
    segments: list[dict[str, Any]],
    has_user: bool,
    surface_missing_user: Callable[[], str],
    evaluate_user_condition: Callable[[dict[str, Any], str], ConditionOutcome],
) -> ConditionOutcome:
    """Resolve one segment condition.

    ``evaluate_user_condition`` is injected (the evaluator owns it) so this
    module has no back-reference to the evaluator. It evaluates one segment
    ``r[]`` user condition with the segment NAME as the context salt.
    """
    # No user → the whole segment condition is the missing-user error (surfaced
    # once per context), exactly like a user condition.
    if not has_user:
        return Error(surface_missing_user())

    index = condition.get("s")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(segments):
        raise SegmentReferenceError("Segment reference is invalid.")
    segment = segments[index]
    segment_name = segment.get("n")
    if not isinstance(segment_name, str) or segment_name == "":
        raise SegmentReferenceError("Segment name is missing.")

    # The segment's `r[]` is an AND-group of BARE user conditions; the context
    # salt is the segment NAME. Short-circuit on the first non-match / error.
    in_segment: ConditionOutcome = True
    for uc in segment.get("r", []):
        in_segment = evaluate_user_condition(uc, segment_name)
        if in_segment is not True:
            break

    # An error is returned un-negated — IsNotIn never converts an error to a
    # match (matches common-js: the comparator switch only runs when the
    # segment result is a clean bool).
    if not isinstance(in_segment, bool):
        return in_segment

    return (not in_segment) if condition.get("c") == SEGMENT_IS_NOT_IN else in_segment
