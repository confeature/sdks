# SPDX-License-Identifier: MIT
"""Prerequisite-flag condition resolution + circular-dependency detection.

Ported from the spec-117 TS reference (`packages/sdk-shared/src/prerequisites.ts`),
itself from common-js ``RolloutEvaluator.evaluatePrerequisiteFlagCondition``.

A prerequisite condition (``{"f": key, "c": comparator, "v": envelope}``) is
resolved by **re-evaluating the prerequisite flag** in a child context (same
config / user, SHARED ``visited_flags`` list), then comparing its resolved
value to the expected ``v`` via the comparator (``Equals`` / ``NotEquals``).
Both the resolved value and ``v`` are read through the prerequisite flag's own
declared ``SettingType``.

**Cycle detection** uses the shared ``visited_flags`` list: append the CURRENT
key, check whether the prerequisite key is already on the list BEFORE recursing
— if so, append the prerequisite key too and raise
:class:`CircularDependencyError`. The outer ``evaluate`` try/except turns that
into a fail-closed fallback + error, so a cycle is **bounded** (the key set is
finite; the second visit raises) — never a hang, never a ``RecursionError``
escape (FR-007, SC-004). On the non-cycle path the current key is popped after
the child evaluation returns, restoring the list for sibling prerequisites.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

PREREQUISITE_EQUALS = 0
PREREQUISITE_NOT_EQUALS = 1


class CircularDependencyError(Exception):
    """Raised on a detected prerequisite cycle (caught by ``evaluate``'s frame).

    ``cycle`` is the ``->``-joined chain (e.g. ``key1 -> key1``) the evaluator's
    distinct ERROR 1002 trace line names (ADR 0003 / #494); it is additive and
    leaves the human-readable exception ``message`` unchanged.
    """

    def __init__(self, message: str, cycle: str = "") -> None:
        super().__init__(message)
        self.cycle = cycle


class PrerequisiteReferenceError(Exception):
    """A missing / invalid prerequisite flag — a fatal config error (fail-closed)."""


def evaluate_prerequisite_flag_condition(
    condition: dict[str, Any],
    current_key: str,
    visited_flags: list[str],
    prereq_type: Callable[[str], int | None],
    evaluate_prereq_flag: Callable[[str], dict[str, Any] | None],
    select_value: Callable[[dict[str, Any] | None, int], Any],
) -> bool:
    """Resolve one prerequisite-flag condition.

    The setting re-evaluator + value selector are injected so this module has no
    back-reference to the evaluator.

    Returns the comparison result (``True`` / ``False``). Raises
    :class:`CircularDependencyError` on a detected cycle or
    :class:`PrerequisiteReferenceError` on a missing prerequisite flag (the
    outer fail-closed frame converts the raise to fallback + error).
    """
    prereq_key = condition.get("f")
    if not isinstance(prereq_key, str):
        raise PrerequisiteReferenceError("Prerequisite flag key is missing or invalid.")
    declared_type = prereq_type(prereq_key)
    if declared_type is None:
        raise PrerequisiteReferenceError("Prerequisite flag is missing or invalid.")

    # The expected comparison value `v`, read through the prereq flag's type.
    comparison_value = select_value(condition.get("v"), declared_type)

    # Cycle detection: push current key, detect a revisit BEFORE recursing.
    visited_flags.append(current_key)
    if prereq_key in visited_flags:
        visited_flags.append(prereq_key)
        cycle = " -> ".join(visited_flags)
        raise CircularDependencyError(
            f"Circular dependency detected between the following depending flags: {cycle}.",
            cycle=cycle,
        )

    resolved_envelope = evaluate_prereq_flag(prereq_key)
    # Restore the list for sibling prerequisites (common-js pops here).
    visited_flags.pop()

    resolved_value = select_value(resolved_envelope, declared_type)

    if condition.get("c") == PREREQUISITE_EQUALS:
        return bool(resolved_value == comparison_value)
    if condition.get("c") == PREREQUISITE_NOT_EQUALS:
        return bool(resolved_value != comparison_value)
    raise PrerequisiteReferenceError("Comparison operator is missing or invalid.")
