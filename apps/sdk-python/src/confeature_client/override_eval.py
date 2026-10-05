# SPDX-License-Identifier: MIT
"""Synchronous override evaluation — Python port of `evaluateOverrideSync`.

Byte-identical 7-branch decision tree from
`packages/sdk-shared/src/override-eval.ts`. The TS canonical reference
was introduced by spec 036 to fix snapshot's blind spot around flag
overrides; the Python SDK inherits the fixed behaviour from day one
(no `waitFor` workaround, no async-only override path).

The helper is intentionally pure: no logger access, no SDK-key access,
no I/O. Pure data in → typed override or sentinel-None out.

Returns:
    - the typed override value when overrides + LocalOnly + key match
      (Branch 7);
    - the supplied `default_value` on TYPE_MISMATCH / missing key /
      null override slot (Branches 4-6: LocalOnly contract — don't
      fall through to the cache);
    - `None` when overrides are absent, behaviour is non-LocalOnly, or
      no synchronous data source is available (Branches 1-3: caller
      falls through to the normal cache-driven eval).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Generic, TypeVar

from .flag_overrides import ConfigOverrideDataSource, FlagOverrides, OverrideBehaviour

if TYPE_CHECKING:
    from .user import User

T = TypeVar("T")


class _OverrideDetails(Generic[T]):
    """Value + identity of a full-config override resolution (spec 152 / #475).

    The details sibling of :func:`evaluate_full_config_override_sync`'s
    value-only return: carries the served ``variation_id`` alongside the value
    so the PUBLIC ``get_value_details`` can surface the override's identity
    (the #395 gap class — variationId dropped on the override→details path).
    """

    __slots__ = ("error", "value", "variation_id")

    def __init__(
        self,
        value: T,
        variation_id: str | None,
        error: str | None,
    ) -> None:
        self.value = value
        self.variation_id = variation_id
        self.error = error


def evaluate_override_sync(  # noqa: PLR0911, PLR0912 — branches are the 7-branch tree.
    flag_overrides: FlagOverrides | None,
    key: str,
    default_value: T,
) -> T | None:
    """Resolve `key` synchronously against `flag_overrides`.

    The 7-branch decision tree (spec 037's data model, override-eval
    section) mirrors `packages/sdk-shared/src/override-eval.ts`.
    Behaviour is bit-identical across TS and Python — the parity corpus
    is the canonical gate.
    """
    # Branch 1: no overrides configured → caller falls through.
    if flag_overrides is None:
        return None

    # Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
    if flag_overrides.behaviour is not OverrideBehaviour.LOCAL_ONLY:
        return None

    # Branch 3: no synchronous data source available → fall through.
    get_overrides_sync = getattr(flag_overrides.data_source, "get_overrides_sync", None)
    if get_overrides_sync is None or not callable(get_overrides_sync):
        return None
    overrides_map = get_overrides_sync()
    if overrides_map is None:
        return None

    # From here we are committed to the LocalOnly contract: NEVER fall
    # through to the cache — return either the typed override or the
    # supplied default.

    # Branch 4: key absent → return default.
    raw = overrides_map.get(key)
    if raw is None:
        return default_value

    # Branch 5: override slot empty → return default.
    # ISettingValue is `{ b?: bool, s?: str, i?: int, d?: float }`.
    # Pick the first non-None field. `bool` is intentionally checked
    # before `int`-style slots — the dataclass already separates them.
    candidate: bool | str | int | float | None
    if raw.b is not None:
        candidate = raw.b
    elif raw.s is not None:
        candidate = raw.s
    elif raw.i is not None:
        candidate = raw.i
    elif raw.d is not None:
        candidate = raw.d
    else:
        candidate = None
    if candidate is None:
        return default_value

    # Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
    # `None` default_value intentionally bypasses the check (matches
    # configcat-js semantics: `defaultValue !== null` in the TS port).
    # `bool` must be type-checked separately from `int` because
    # `isinstance(True, int)` is True in Python.
    if default_value is not None:
        candidate_type = type(candidate)
        default_type = type(default_value)
        if candidate_type is not default_type:
            return default_value

    # Branch 7: happy path — typed override value.
    return candidate  # type: ignore[return-value]


def evaluate_full_config_override_sync(
    flag_overrides: FlagOverrides | None,
    key: str,
    default_value: T,
    user: User | None,
) -> T | None:
    """Full-config override resolution — Python port of
    ``evaluateFullConfigOverrideSync`` (spec 135 / #428).

    When the override source is a :class:`ConfigOverrideDataSource`, resolve
    ``key`` through the real Python evaluator so targeting rules / segments /
    prerequisites / percentage options apply offline — the rule-bearing
    sibling of :func:`evaluate_override_sync`'s flat lookup.

    Returns:
        - the rule-resolved typed value, when overrides + LocalOnly + a
          ``ConfigOverrideDataSource`` apply (LocalOnly: never fall through to
          the cache — the evaluator already returns ``default_value`` for any
          non-clean resolution, so this preserves the contract);
        - ``None`` when overrides are absent, behaviour is non-LocalOnly, or
          the source is NOT a full-config source (caller falls through to the
          flat-map helper / normal eval).

    INV-4: the evaluator receives the FULL config dict (``{p, f, s}``) — salt
    (``p.s``) + segments (``s``), never just ``f`` (the spec-129 dropped-salt
    regression class).
    """
    if flag_overrides is None:
        return None
    if flag_overrides.behaviour is not OverrideBehaviour.LOCAL_ONLY:
        return None

    data_source = flag_overrides.data_source
    if not isinstance(data_source, ConfigOverrideDataSource):
        return None

    # Local import to avoid a module-load cycle (evaluator imports nothing
    # from here, but keep the override-eval helper import-light).
    from .evaluator import evaluate as evaluator_evaluate  # noqa: PLC0415

    # Pass the FULL config dict (salt + segments + f), never just `f` (INV-4).
    result = evaluator_evaluate(data_source.config, key, default_value, user)
    return result.value


def evaluate_full_config_override_details_sync(
    flag_overrides: FlagOverrides | None,
    key: str,
    default_value: T,
    user: User | None,
) -> _OverrideDetails[T] | None:
    """Details-returning sibling of :func:`evaluate_full_config_override_sync`.

    Resolves ``key`` through the real evaluator (spec 152 / #475, US2) and
    returns BOTH the value and the served ``variation_id`` so the PUBLIC
    ``get_value_details`` surfaces the override's identity. Closes the #395 gap
    class: the snapshot's LocalOnly details branch previously routed a
    ``ConfigOverrideDataSource`` through the value-only flat-map helper (which
    cannot read rule-bearing settings and never carries a ``variation_id``).

    Returns ``None`` when overrides are absent, behaviour is non-LocalOnly, or
    the source is NOT a full-config source — the caller then falls through to
    the flat-map details branch (unchanged value-only override semantics).
    """
    if flag_overrides is None:
        return None
    if flag_overrides.behaviour is not OverrideBehaviour.LOCAL_ONLY:
        return None

    data_source = flag_overrides.data_source
    if not isinstance(data_source, ConfigOverrideDataSource):
        return None

    from .evaluator import evaluate as evaluator_evaluate  # noqa: PLC0415

    # Pass the FULL config dict (salt + segments + f), never just `f` (INV-4).
    result = evaluator_evaluate(data_source.config, key, default_value, user)
    return _OverrideDetails(
        value=result.value,
        variation_id=result.variation_id,
        error=result.error,
    )


def evaluate_override(
    flag_overrides: FlagOverrides | None,
    key: str,
    default_value: T,
    user: User | None,
) -> T | None:
    """Shared override router — Python port of ``evaluateOverride``
    (spec 135 / #428).

    Dispatches between the flat-map path and the full-config path so the
    ``get_value`` call site changes minimally: a :class:`ConfigOverrideDataSource`
    routes through the real evaluator; every other source (map / custom) keeps
    the existing byte-identical flat-map resolution.

    Returns the resolved override value, or ``None`` when no override applies
    (the caller then falls through to the normal cache-driven eval). Preserves
    the LocalOnly no-fall-through contract on both paths.
    """
    # Full-config source → ALWAYS resolve through the evaluator; NEVER fall
    # through to the flat-map path (which would mis-read rule-bearing settings
    # as value-only). Dispatch on the source TYPE, not the resolved value, so a
    # full-config source whose evaluator returns the default still stays on the
    # rule path.
    if (
        flag_overrides is not None
        and flag_overrides.behaviour is OverrideBehaviour.LOCAL_ONLY
        and isinstance(flag_overrides.data_source, ConfigOverrideDataSource)
    ):
        return evaluate_full_config_override_sync(flag_overrides, key, default_value, user)
    # Every other source (map / custom) keeps the byte-identical flat-map path.
    return evaluate_override_sync(flag_overrides, key, default_value)
