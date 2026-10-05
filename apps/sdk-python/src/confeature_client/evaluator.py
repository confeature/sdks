# SPDX-License-Identifier: MIT
"""ConfigCat-parity flag evaluator (spec 118 — full decision engine).

Ported from the spec-117 TS reference (`packages/sdk-shared/src/evaluator.ts`).
The evaluator consumes a parsed ``config_v6.json`` dict and a
``(key, default, user)`` tuple and returns an :class:`EvaluationResult` carrying
the resolved value, an optional reason string, the variation id, and the matched
targeting rule / percentage option.

Decision flow (mirrors `evaluator.ts::evaluateSetting`):
  1. walk ``setting["r"]`` first-match-wins; each rule's ``c`` conditions are
     AND-grouped (short-circuit); a matched rule serves its fixed value ``s`` or
     buckets into its percentage options ``p``;
  2. no rule matches → setting-level percentage options ``p``;
  3. else → served fallback ``setting["v"]``.

Conditions dispatch to the 36 comparators (`comparators.py`), segment membership
(`segments.py`), and prerequisite flags with bounded circular-dependency
detection (`prerequisites.py`).

Preserved invariants (spec 072 / SC-006 — NON-NEGOTIABLE, Principle II):
  - the existing typed-widening + ``TYPE_MISMATCH`` decision tree (strict
    int/double, the ``bool``-is-``int`` guard) runs UNCHANGED on the resolved
    value envelope, whatever its source (rule / percentage / fallback);
  - fail-closed: the function NEVER raises; any unexpected state (incl. a
    detected prerequisite cycle) resolves to the caller's default with a
    reason-coded error;
  - the rule-less path is byte-identical to the pre-engine behaviour.

No-user / missing-attribute on a rule is NOT an error to the caller — the rule
simply does not match and evaluation continues; an informational reason is
surfaced on :attr:`EvaluationResult.eval_error` (FR-016), while ``error`` stays
``None`` because a value WAS cleanly resolved.
"""

from __future__ import annotations

import dataclasses
import re
from typing import Any, Generic, TypeVar

from .comparators import (
    ARRAY_CONTAINS_ANY_OF,
    ARRAY_NOT_CONTAINS_ANY_OF,
    DATETIME_AFTER,
    DATETIME_BEFORE,
    NUMBER_EQUALS,
    NUMBER_GREATER,
    NUMBER_GREATER_OR_EQUALS,
    NUMBER_LESS,
    NUMBER_LESS_OR_EQUALS,
    NUMBER_NOT_EQUALS,
    SEMVER_GREATER,
    SEMVER_GREATER_OR_EQUALS,
    SEMVER_IS_NOT_ONE_OF,
    SEMVER_IS_ONE_OF,
    SEMVER_LESS,
    SEMVER_LESS_OR_EQUALS,
    SENSITIVE_ARRAY_CONTAINS_ANY_OF,
    SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
    SENSITIVE_TEXT_ENDS_WITH_ANY_OF,
    SENSITIVE_TEXT_EQUALS,
    SENSITIVE_TEXT_IS_NOT_ONE_OF,
    SENSITIVE_TEXT_IS_ONE_OF,
    SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
    SENSITIVE_TEXT_NOT_EQUALS,
    SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
    SENSITIVE_TEXT_STARTS_WITH_ANY_OF,
    TEXT_CONTAINS_ANY_OF,
    TEXT_ENDS_WITH_ANY_OF,
    TEXT_EQUALS,
    TEXT_IS_NOT_ONE_OF,
    TEXT_IS_ONE_OF,
    TEXT_NOT_CONTAINS_ANY_OF,
    TEXT_NOT_ENDS_WITH_ANY_OF,
    TEXT_NOT_EQUALS,
    TEXT_NOT_STARTS_WITH_ANY_OF,
    TEXT_STARTS_WITH_ANY_OF,
    ComparisonValueError,
    ConditionOutcome,
    Error,
    attribute_as_number,
    attribute_as_semver,
    attribute_as_string_array,
    attribute_as_text,
    attribute_as_unix_time_seconds,
    comparison_value_as_number,
    comparison_value_as_semver,
    comparison_value_as_unix_time_seconds,
    evaluate_array_contains_any_of,
    evaluate_datetime_relation,
    evaluate_number_relation,
    evaluate_semver_is_one_of,
    evaluate_semver_relation,
    evaluate_sensitive_array_contains_any_of,
    evaluate_sensitive_text_equals,
    evaluate_sensitive_text_is_one_of,
    evaluate_sensitive_text_slice_equals_any_of,
    evaluate_text_contains_any_of,
    evaluate_text_equals,
    evaluate_text_is_one_of,
    evaluate_text_slice_equals_any_of,
    user_attribute_value_to_string,
)
from .eval_log import (
    EVAL_LOG_EVENT_ID,
    EvaluateLogBuilder,
    match_error,
    match_false,
    match_true,
    setting_value_to_log_string,
)
from .eval_logger import LogLevel, TraceLogger, _TraceLog
from .hash import percentage_bucket
from .prerequisites import (
    CircularDependencyError,
    PrerequisiteReferenceError,
    evaluate_prerequisite_flag_condition,
)
from .segments import (
    SEGMENT_IS_IN,
    SEGMENT_IS_NOT_IN,
    SegmentReferenceError,
    evaluate_segment_condition,
)
from .user import User, get_user_attribute

T = TypeVar("T")

#: `SettingType` discriminators from `packages/sdk-shared/src/config-json.ts`.
_SETTING_TYPE_BOOL = 0
_SETTING_TYPE_STRING = 1
_SETTING_TYPE_INT = 2
_SETTING_TYPE_DOUBLE = 3

_MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing"


def _missing_user_attribute_error(attr: str) -> str:
    return f"cannot evaluate, the User.{attr} attribute is missing"


class _MalformedConfigError(Exception):
    """Internal: a malformed rule/option config that must fail closed."""


@dataclasses.dataclass(frozen=True)
class EvaluationResult(Generic[T]):
    """Result of `evaluate(...)`. `error` is None on the happy path.

    ``error`` carries the reason-coded fail-closed signal (``KEY_NOT_FOUND``,
    ``TYPE_MISMATCH``, ``EVAL_EXCEPTION`` …) — ``None`` whenever a value was
    cleanly resolved (incl. via a targeting rule, percentage option, or served
    fallback). ``eval_error`` is the informational rule-engine reason (e.g.
    "User Object is missing") surfaced when a rule could not be evaluated but a
    value WAS still resolved (FR-016) — it never changes ``error``.
    """

    value: T
    error: str | None = None
    variation_id: str | None = None
    matched_targeting_rule: dict[str, Any] | None = None
    matched_percentage_option: dict[str, Any] | None = None
    eval_error: str | None = None


@dataclasses.dataclass
class _SettingResult:
    """Raw result of `_evaluate_setting`: the resolved `v` envelope + identity.

    ``value`` is the served ``v`` envelope, read via ``.get("v")`` — which can be
    ``None`` for a malformed config. The caller (``evaluate``) gates on
    ``isinstance(value, dict)`` and returns ``MALFORMED_VALUE`` for any non-dict,
    so the field is typed permissively rather than asserting a dict it cannot
    guarantee.
    """

    value: dict[str, Any] | None
    variation_id: str | None = None
    matched_rule: dict[str, Any] | None = None
    matched_option: dict[str, Any] | None = None


@dataclasses.dataclass
class _EvalState:
    """Mutable evaluation-scoped flags shared across the recursion.

    ``missing_user_object_logged`` dedups the no-user WARN 3001 to once per
    context (common-js parity): a prerequisite flag evaluates in its OWN
    context, so a prereq referenced by N rules logs the WARN N times, but a
    single rule with multiple no-user conditions logs it once.
    """

    eval_error: str | None = None
    missing_user_object_logged: bool = False


@dataclasses.dataclass
class _EvaluateContext:
    """Per-evaluation context threaded through rule / condition / prereq walks.

    ``log`` + ``log_builder`` are the eval-log trace seam (ADR 0003), present
    only when an INFO-enabled :class:`~confeature_client.eval_logger.TraceLogger`
    is attached. Every trace append is guarded by ``if ctx.log_builder is not
    None``, so the no-trace hot path pays nothing. ``log_builder`` is shared
    across the recursion (a prerequisite re-evaluates nested in ``( … )`` on the
    SAME builder).
    """

    key: str
    setting: dict[str, Any]
    settings: dict[str, Any]
    segments: list[dict[str, Any]]
    config_salt: str
    user: User | None
    visited_flags: list[str]
    state: _EvalState
    log: _TraceLog
    log_builder: EvaluateLogBuilder | None = None


def _select_setting_value(value: dict[str, Any] | None, setting_type: int) -> Any:
    """Read the typed value out of a `v` envelope by the setting's `t`.

    Mirrors `evaluator.ts::selectSettingValue`. The key is chosen from ``t``,
    never from the runtime shape of the parsed value.
    """
    if not isinstance(value, dict):
        return None
    if setting_type == _SETTING_TYPE_BOOL:
        return value.get("b")
    if setting_type == _SETTING_TYPE_STRING:
        return value.get("s")
    if setting_type == _SETTING_TYPE_INT:
        return value.get("i")
    if setting_type == _SETTING_TYPE_DOUBLE:
        return value.get("d")
    return None


def evaluate(
    config: dict[str, Any] | None,
    key: str,
    default_value: T,
    user: User | None = None,
) -> EvaluationResult[T]:
    """Resolve `key` against `config`. Fail-closed to `default_value`.

    The function NEVER raises. Any internal exception is converted to a
    fail-closed result with ``error="EVAL_EXCEPTION"``. A detected prerequisite
    cycle is bounded and surfaces the same fail-closed default (FR-007/SC-004).
    """
    return evaluate_traced(config, key, default_value, user, None)


def evaluate_traced(  # noqa: PLR0911, PLR0912 - branches are the typed decision tree.
    config: dict[str, Any] | None,
    key: str,
    default_value: T,
    user: User | None = None,
    logger: TraceLogger | None = None,
) -> EvaluationResult[T]:
    """:func:`evaluate` with an optional :class:`TraceLogger`.

    When the logger is INFO-enabled it drives the ConfigCat byte-identical
    evaluation-log trace: the WARN 3001/3003/3004 + ERROR 1002 lines emitted
    during the walk, and the final INFO 5000 multi-line indented trace (ADR 0003
    / epic #494). A ``None`` logger (the hot path) is zero-cost — identical
    behaviour to :func:`evaluate`.
    """
    # No config yet → silent miss (caller's default wins).
    if config is None:
        return EvaluationResult(value=default_value, error="NO_CONFIG")

    log = _TraceLog(logger)

    try:
        settings = config.get("f") if isinstance(config, dict) else None
        if not isinstance(settings, dict):
            return EvaluationResult(value=default_value, error="MALFORMED_CONFIG")

        setting = settings.get(key)
        if setting is None:
            return EvaluationResult(value=default_value, error="KEY_NOT_FOUND")

        setting_type = setting.get("t")
        # `t` must be an integer discriminator; non-numeric / missing is a
        # malformed config. `isinstance(True, int)` is True, so guard against it.
        if not isinstance(setting_type, int) or isinstance(setting_type, bool):
            return EvaluationResult(value=default_value, error="MALFORMED_CONFIG")

        # Type guard BEFORE evaluating rules (mirrors evaluator.ts): the default
        # must be type-compatible with the setting's declared type. A `None`
        # default bypasses the check (mirrors the TS `defaultValue !== null`
        # guard) — used by the variation-id matrix, which evaluates with a
        # `None` default to read `variation_id` regardless of value type.
        if default_value is not None:
            type_mismatch = _check_default_type(setting_type, default_value)
            if type_mismatch is not None:
                return EvaluationResult(value=default_value, error=type_mismatch)

        # Evaluation-log trace (ADR 0003). Built lazily — only when the logger
        # would emit at INFO. The header is appended here; the
        # `Returning '<value>'.` footer below; the whole multi-line trace is
        # surfaced under event id 5000.
        log_builder: EvaluateLogBuilder | None = None
        if log.enabled(LogLevel.INFO):
            log_builder = EvaluateLogBuilder()
            log_builder.append(f"Evaluating '{key}'")
            if user is not None:
                log_builder.append(f" for User '{_user_attributes_for_log_json(user)}'")

        # Evaluation core (the seam): resolve the setting to a `v` envelope +
        # matched-rule/option identity. For a rule-less config this collapses to
        # the served `setting["v"]`, byte-identical to the pre-engine behaviour.
        raw_segments = config.get("s")
        segments: list[dict[str, Any]] = raw_segments if isinstance(raw_segments, list) else []
        ctx = _EvaluateContext(
            key=key,
            setting=setting,
            settings=settings,
            segments=segments,
            config_salt=_config_salt(config),
            user=user,
            visited_flags=[],
            state=_EvalState(),
            log=log,
            log_builder=log_builder,
        )
        result = _evaluate_setting(ctx)

        value_slot = result.value
        if not isinstance(value_slot, dict):
            return EvaluationResult(value=default_value, error="MALFORMED_VALUE")

        variation_id = result.variation_id
        if variation_id is None and isinstance(setting.get("i"), str):
            variation_id = setting["i"]

        # The typed-widening decision tree runs UNCHANGED on the resolved
        # envelope (rule-served, percentage-served, or static).
        typed = _resolve_typed(
            setting_type,
            value_slot,
            default_value,
            variation_id,
            result,
            ctx.state.eval_error,
        )

        # Footer + emit. The INFO 5000 trace is emitted only when the resolved
        # value is clean (no error); a type/value error fails closed without a
        # footer (matching evaluator.ts, which emits the trace after the value
        # guard).
        if log_builder is not None and typed.error is None:
            log_builder.new_line(f"Returning '{setting_value_to_log_string(typed.value)}'.")
            log.info(EVAL_LOG_EVENT_ID, str(log_builder))

        return typed
    except CircularDependencyError as cycle_err:
        # A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
        # (naming the setting + the chain), not the generic evaluation-error path.
        log.circular_dependency(key, cycle_err.cycle)
        return EvaluationResult(value=default_value, error="EVAL_EXCEPTION")
    except (PrerequisiteReferenceError, SegmentReferenceError):
        # Bounded fail-closed: a malformed reference returns the caller's default
        # with an error reason (FR-007/SC-004).
        return EvaluationResult(value=default_value, error="EVAL_EXCEPTION")
    except Exception:
        return EvaluationResult(value=default_value, error="EVAL_EXCEPTION")


def _user_attributes_for_log_json(user: User) -> str:
    """Render the user's attributes as the eval-log header shows them.

    A Confeature-canonical object ``{Identifier, Email?, Country?, …custom}``
    JSON-serialized to the ``for User '…'`` token (ADR 0003 addendum). This is
    the configcat-js form (the vendored go-sdk oracle's map is transformed to it
    in the corpus so the cross-SDK trace stays byte-identical).

    Insertion order is fixed (Identifier, Email, Country, then custom in the
    order the user's custom dict yields) and the serialization is compact (no
    spaces) with JS-JSON string escaping — mirroring
    ``JSON.stringify(userAttributesForLog(user))``.
    """
    parts: list[str] = ['"Identifier":' + _js_json_string(user.identifier or "")]
    if user.email is not None:
        parts.append('"Email":' + _js_json_string(user.email))
    if user.country is not None:
        parts.append('"Country":' + _js_json_string(user.country))
    if user.custom is not None:
        for name, value in user.custom.items():
            parts.append(
                _js_json_string(name) + ":" + _js_json_string(user_attribute_value_to_string(value))
            )
    return "{" + ",".join(parts) + "}"


def _js_json_string(s: str) -> str:
    """Serialize a string exactly as ECMAScript ``JSON.stringify`` of a string.

    Wrapped in double quotes, with ``"``, ``\\``, and the C0 control characters
    escaped (``\\"``, ``\\\\``, ``\\b``, ``\\t``, ``\\n``, ``\\f``, ``\\r``, else
    ``\\u00XX``), all other code points (incl. ``/`` and non-ASCII) verbatim.
    """
    out: list[str] = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\r":
            out.append("\\r")
        elif ch < "\x20":
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _config_salt(config: dict[str, Any]) -> str:
    prefs = config.get("p")
    if isinstance(prefs, dict):
        salt = prefs.get("s")
        if isinstance(salt, str):
            return salt
    return ""


def _check_default_type(setting_type: int, default_value: Any) -> str | None:
    """Return a TYPE_MISMATCH reason code if the default type is wrong, else None."""
    if setting_type == _SETTING_TYPE_BOOL:
        if not isinstance(default_value, bool):
            return "TYPE_MISMATCH"
    elif setting_type == _SETTING_TYPE_STRING:
        if not isinstance(default_value, str):
            return "TYPE_MISMATCH"
    elif setting_type == _SETTING_TYPE_INT:
        # `isinstance(True, int)` is True — refuse bool defaults.
        if isinstance(default_value, bool) or not isinstance(default_value, int):
            return "TYPE_MISMATCH"
    elif setting_type == _SETTING_TYPE_DOUBLE:
        if not isinstance(default_value, float) or isinstance(default_value, bool):
            return "TYPE_MISMATCH"
    return None


def _resolve_typed(  # noqa: PLR0911 — one branch per SettingType.
    setting_type: int,
    value_slot: dict[str, Any],
    default_value: T,
    variation_id: str | None,
    result: _SettingResult,
    eval_error: str | None,
) -> EvaluationResult[T]:
    """Read the typed primitive from the resolved envelope (spec-072 widening)."""

    def ok(raw: Any) -> EvaluationResult[T]:
        return EvaluationResult(
            value=raw,
            variation_id=variation_id,
            matched_targeting_rule=result.matched_rule,
            matched_percentage_option=result.matched_option,
            eval_error=eval_error,
        )

    if setting_type == _SETTING_TYPE_BOOL:
        raw = value_slot.get("b")
        if not isinstance(raw, bool):
            return EvaluationResult(value=default_value, error="VALUE_NOT_BOOL")
        return ok(raw)

    if setting_type == _SETTING_TYPE_STRING:
        raw = value_slot.get("s")
        if not isinstance(raw, str):
            return EvaluationResult(value=default_value, error="MALFORMED_VALUE")
        return ok(raw)

    if setting_type == _SETTING_TYPE_INT:
        raw = value_slot.get("i")
        if isinstance(raw, bool) or not isinstance(raw, int):
            return EvaluationResult(value=default_value, error="MALFORMED_VALUE")
        return ok(raw)

    if setting_type == _SETTING_TYPE_DOUBLE:
        raw = value_slot.get("d")
        # JSON numbers without a fractional part decode as int; ConfigCat
        # double settings legitimately carry integral doubles (e.g. 5.0 → 5).
        if isinstance(raw, bool):
            return EvaluationResult(value=default_value, error="MALFORMED_VALUE")
        if isinstance(raw, int):
            raw = float(raw)
        if not isinstance(raw, float):
            return EvaluationResult(value=default_value, error="MALFORMED_VALUE")
        return ok(raw)

    # Genuinely unknown `t` — fail-closed.
    return EvaluationResult(value=default_value, error="UNSUPPORTED_TYPE")


# ---------------------------------------------------------------------------
# Evaluation core — rule walk / conditions / percentage (port evaluator.ts)
# ---------------------------------------------------------------------------


def _evaluate_setting(ctx: _EvaluateContext) -> _SettingResult:
    """Resolve a setting to its `v` envelope + matched-rule/option identity."""
    setting = ctx.setting

    # 1. Targeting rules — first-match-wins (US1).
    rules = setting.get("r") or []
    if rules:
        rule_result = _evaluate_targeting_rules(rules, ctx)
        if rule_result is not None:
            return rule_result

    # 2. Setting-level percentage options (US3).
    options = setting.get("p") or []
    if options:
        option_result = _evaluate_percentage_options(options, None, ctx)
        if option_result is not None:
            return option_result

    # 3. Served fallback `setting["v"]`.
    return _SettingResult(value=setting.get("v"), variation_id=setting.get("i"))


def _evaluate_targeting_rules(
    rules: list[dict[str, Any]],
    ctx: _EvaluateContext,
) -> _SettingResult | None:
    """Walk rules in document order; return the first whose conditions all match."""
    lb = ctx.log_builder
    if lb is not None:
        lb.new_line("Evaluating targeting rules and applying the first match if any:")
    for rule in rules:
        outcome = _evaluate_conditions(rule.get("c") or [], ctx.key, ctx, rule)
        if outcome is not True:
            # A rule whose conditions ERRORED (missing user/attr) is ignored and
            # evaluation continues — ConfigCat emits this trace line. A rule that
            # merely did NOT match (False) just continues, with no such line.
            if lb is not None and isinstance(outcome, Error):
                lb.increase_indent().new_line(
                    "The current targeting rule is ignored and the evaluation continues "
                    "with the next rule."
                ).decrease_indent()
            continue

        served = rule.get("s")
        if served is not None:
            return _SettingResult(
                value=served.get("v"),
                variation_id=served.get("i"),
                matched_rule=rule,
            )
        # A rule serving % options: the block is traced one level deeper (under
        # the rule). If the options can't resolve (no user / missing keying attr)
        # the rule is ignored and evaluation continues.
        options = rule.get("p") or []
        if lb is not None:
            lb.increase_indent()
        option_result = _evaluate_percentage_options(options, rule, ctx)
        if option_result is not None:
            if lb is not None:
                lb.decrease_indent()
            return option_result
        if lb is not None:
            lb.new_line(
                "The current targeting rule is ignored and the evaluation continues "
                "with the next rule."
            ).decrease_indent()
        # % options weren't resolvable (no user / missing attr) → ignore the
        # rule and continue with the next.
    return None


def _evaluate_percentage_options(
    options: list[dict[str, Any]],
    matched_rule: dict[str, Any] | None,
    ctx: _EvaluateContext,
) -> _SettingResult | None:
    """Resolve a percentage-option list to its bucket (US3, SHA-1 unsalted).

    Returns ``None`` (skip) when there is no user or the keying attribute is
    missing — never raises on a skippable condition. Mirrors common-js.
    """
    lb = ctx.log_builder
    if ctx.user is None:
        _surface_missing_user(ctx)
        if lb is not None:
            lb.new_line("Skipping % options because the User Object is missing.")
        return None

    attr_name = ctx.setting.get("a")
    if attr_name is None:
        attr_name = "Identifier"
        attr_value: Any = ctx.user.identifier if ctx.user.identifier is not None else ""
    else:
        attr_value = get_user_attribute(ctx.user, attr_name)
    if attr_value is None:
        if ctx.state.eval_error is None:
            ctx.state.eval_error = _missing_user_attribute_error(attr_name)
        ctx.log.user_object_attribute_is_missing_for_percentage(ctx.key, attr_name)
        if lb is not None:
            lb.new_line(f"Skipping % options because the User.{attr_name} attribute is missing.")
        return None

    hash_value = percentage_bucket(ctx.key, user_attribute_value_to_string(attr_value))

    if lb is not None:
        lb.new_line(f"Evaluating % options based on the User.{attr_name} attribute:")
        lb.new_line(
            f"- Computing hash in the [0..99] range from User.{attr_name} => {hash_value} "
            "(this value is sticky and consistent across all SDKs)"
        )

    setting_type = ctx.setting.get("t")
    bucket = 0
    for index, option in enumerate(options):
        width = option.get("p", 0)
        bucket += width
        if hash_value >= bucket:
            continue
        value = option.get("v")
        if lb is not None and isinstance(setting_type, int) and not isinstance(setting_type, bool):
            selected = _select_setting_value(value, setting_type)
            lb.new_line(
                f"- Hash value {hash_value} selects % option {index + 1} ({width}%), "
                f"'{setting_value_to_log_string(selected)}'."
            )
        return _SettingResult(
            value=value,
            variation_id=option.get("i"),
            matched_rule=matched_rule,
            matched_option=option,
        )
    # Sum of widths < 100 — a malformed config. Raise so the outer fail-closed
    # frame returns the default (common-js throws here too).
    raise _MalformedConfigError("Sum of percentage option percentages is less than 100.")


def _evaluate_conditions(  # noqa: PLR0912 — condition dispatch + trace rendering.
    conditions: list[dict[str, Any]],
    context_salt: str,
    ctx: _EvaluateContext,
    rule: dict[str, Any] | None = None,
) -> ConditionOutcome:
    """Evaluate an AND-grouped condition list, short-circuiting on first non-match.

    ``rule`` is the owning targeting rule when this is a rule's condition list
    (``None`` for a bare segment's condition list). When present and tracing is
    on, the rule's THEN consequence (`` THEN 'Dog' => MATCH, applying rule`` etc.)
    is appended after the AND group, mirroring ``evaluator.ts::evaluateConditions``.
    """
    lb = ctx.log_builder
    if lb is not None:
        lb.new_line("- ")
    result: ConditionOutcome = True
    for i, condition in enumerate(conditions):
        if lb is not None:
            if i == 0:
                lb.append("IF ").increase_indent()
            else:
                lb.increase_indent().new_line("AND ")
        if condition.get("u") is not None:
            result = _evaluate_user_condition(condition["u"], context_salt, ctx)
        elif condition.get("p") is not None:
            result = _evaluate_prerequisite_condition(condition["p"], ctx)
        elif condition.get("s") is not None:
            result = _evaluate_segment_condition(condition["s"], ctx)
        else:
            result = Error("empty condition")
        if lb is not None:
            # The go-sdk oracle always shows the per-condition consequence (even
            # for a single-condition rule). A clean match is True; anything else
            # (no-match or surfaced error) renders the `=> false, skipping…` form.
            lb.append_condition_consequence(result is True)
            lb.decrease_indent()
        if result is not True:
            break

    # Append the rule's THEN consequence (rule-owned condition list only). The go
    # oracle newlines THEN when the rule has conditions.
    if rule is not None and lb is not None:
        then_value, has_then = _rule_then_value(rule, ctx)
        if result is True:
            outcome = match_true()
        elif isinstance(result, Error):
            outcome = match_error(result.message)
        else:
            outcome = match_false()
        lb.append_targeting_rule_consequence(
            then_value if has_then else None, outcome, len(conditions) > 0
        )
    return result


def _rule_then_value(rule: dict[str, Any], ctx: _EvaluateContext) -> tuple[str | None, bool]:
    """A rule's formatted served value (e.g. ``Dog``) for a fixed-value rule.

    Returns ``(value, True)`` for a fixed-value rule, ``(None, False)`` for a
    rule serving ``% options``.
    """
    served = rule.get("s")
    if not isinstance(served, dict):
        return None, False
    setting_type = ctx.setting.get("t")
    if not isinstance(setting_type, int) or isinstance(setting_type, bool):
        return None, False
    value = _select_setting_value(served.get("v"), setting_type)
    return setting_value_to_log_string(value), True


_INVALID_ATTR_RE = re.compile(r"^cannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)$")


def _evaluate_user_condition(
    condition: dict[str, Any],
    context_salt: str,
    ctx: _EvaluateContext,
) -> ConditionOutcome:
    """Dispatch one user condition to its comparator (US2)."""
    if ctx.log_builder is not None:
        ctx.log_builder.append_user_condition(condition)
    if ctx.user is None:
        _surface_missing_user(ctx)
        return Error(_MISSING_USER_OBJECT_ERROR)

    raw_attr_name = condition.get("a")
    attr_name = raw_attr_name if isinstance(raw_attr_name, str) else None
    attr_value = get_user_attribute(ctx.user, attr_name) if attr_name is not None else None
    if attr_name is None or attr_value is None or attr_value == "":
        msg = _missing_user_attribute_error(str(raw_attr_name))
        if ctx.state.eval_error is None:
            ctx.state.eval_error = msg
        # ConfigCat logs a WARN 3003 per targeting rule whose attribute is
        # missing (not deduped — AND short-circuit means one per rule).
        ctx.log.user_object_attribute_is_missing(ctx.key, str(raw_attr_name))
        return Error(msg)

    result = _dispatch_user_comparator(condition, attr_name, attr_value, context_salt, ctx)
    if isinstance(result, Error):
        # Surface + log the typed validation / malformed-operand outcomes the
        # trace replays. An attribute-invalid error → WARN 3004
        # (user_object_attribute_is_invalid); a malformed config operand (#509)
        # → WARN 3004 (comparison_value_is_invalid). Both also feed
        # state.eval_error (FR-016) the way the missing paths do.
        if ctx.state.eval_error is None:
            ctx.state.eval_error = result.message
        m = _INVALID_ATTR_RE.match(result.message)
        if m is not None:
            ctx.log.user_object_attribute_is_invalid(ctx.key, m.group(1), m.group(2))
        elif result.message.startswith("comparison value '"):
            ctx.log.comparison_value_is_invalid(ctx.key, result.message)
    return result


def _dispatch_user_comparator(  # noqa: PLR0911, PLR0912 — comparator dispatch.
    condition: dict[str, Any],
    attr_name: str,
    attr_value: Any,
    context_salt: str,
    ctx: _EvaluateContext,
) -> ConditionOutcome:
    """Run the 36-way comparator switch for an already-validated attribute.

    Split out from :func:`_evaluate_user_condition` so the latter can centralise
    the trace-side WARN 3004 logging on a returned validation / comparison-value
    error. A malformed config operand (#509) is validated BEFORE the user
    attribute for the semver-relation / number / datetime comparators, surfaced
    as a :class:`ComparisonValueError` (rendered with the same ``message``).
    """
    config_salt = ctx.config_salt
    cmp = condition.get("c")
    operand_list = condition.get("l") or []
    sv = condition.get("s") or ""
    dv = condition.get("d") or 0
    raw_dv = condition.get("d")

    if cmp in (TEXT_EQUALS, TEXT_NOT_EQUALS):
        return evaluate_text_equals(attribute_as_text(attr_value), sv, cmp == TEXT_NOT_EQUALS)
    if cmp in (SENSITIVE_TEXT_EQUALS, SENSITIVE_TEXT_NOT_EQUALS):
        return evaluate_sensitive_text_equals(
            attribute_as_text(attr_value),
            sv,
            config_salt,
            context_salt,
            cmp == SENSITIVE_TEXT_NOT_EQUALS,
        )
    if cmp in (TEXT_IS_ONE_OF, TEXT_IS_NOT_ONE_OF):
        return evaluate_text_is_one_of(
            attribute_as_text(attr_value), operand_list, cmp == TEXT_IS_NOT_ONE_OF
        )
    if cmp in (SENSITIVE_TEXT_IS_ONE_OF, SENSITIVE_TEXT_IS_NOT_ONE_OF):
        return evaluate_sensitive_text_is_one_of(
            attribute_as_text(attr_value),
            operand_list,
            config_salt,
            context_salt,
            cmp == SENSITIVE_TEXT_IS_NOT_ONE_OF,
        )
    if cmp in (TEXT_STARTS_WITH_ANY_OF, TEXT_NOT_STARTS_WITH_ANY_OF):
        return evaluate_text_slice_equals_any_of(
            attribute_as_text(attr_value),
            operand_list,
            True,
            cmp == TEXT_NOT_STARTS_WITH_ANY_OF,
        )
    if cmp in (SENSITIVE_TEXT_STARTS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF):
        return evaluate_sensitive_text_slice_equals_any_of(
            attribute_as_text(attr_value),
            operand_list,
            config_salt,
            context_salt,
            True,
            cmp == SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
        )
    if cmp in (TEXT_ENDS_WITH_ANY_OF, TEXT_NOT_ENDS_WITH_ANY_OF):
        return evaluate_text_slice_equals_any_of(
            attribute_as_text(attr_value),
            operand_list,
            False,
            cmp == TEXT_NOT_ENDS_WITH_ANY_OF,
        )
    if cmp in (SENSITIVE_TEXT_ENDS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF):
        return evaluate_sensitive_text_slice_equals_any_of(
            attribute_as_text(attr_value),
            operand_list,
            config_salt,
            context_salt,
            False,
            cmp == SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
        )
    if cmp in (TEXT_CONTAINS_ANY_OF, TEXT_NOT_CONTAINS_ANY_OF):
        return evaluate_text_contains_any_of(
            attribute_as_text(attr_value), operand_list, cmp == TEXT_NOT_CONTAINS_ANY_OF
        )
    if cmp in (SEMVER_IS_ONE_OF, SEMVER_IS_NOT_ONE_OF):
        r = attribute_as_semver(attr_name, attr_value)
        if isinstance(r, Error):
            return r
        return evaluate_semver_is_one_of(r, operand_list, cmp == SEMVER_IS_NOT_ONE_OF)
    if cmp in (SEMVER_LESS, SEMVER_LESS_OR_EQUALS, SEMVER_GREATER, SEMVER_GREATER_OR_EQUALS):
        # configcat-common validates the CONFIG comparison value BEFORE the user
        # attribute (#509): a malformed operand wins even when the attribute is
        # also malformed.
        cv = comparison_value_as_semver(sv)
        if isinstance(cv, ComparisonValueError):
            return Error(cv.message)
        r = attribute_as_semver(attr_name, attr_value)
        if isinstance(r, Error):
            return r
        return evaluate_semver_relation(r, cmp, sv)
    if cmp in (
        NUMBER_EQUALS,
        NUMBER_NOT_EQUALS,
        NUMBER_LESS,
        NUMBER_LESS_OR_EQUALS,
        NUMBER_GREATER,
        NUMBER_GREATER_OR_EQUALS,
    ):
        cvn = comparison_value_as_number(float(raw_dv) if raw_dv is not None else None)
        if isinstance(cvn, ComparisonValueError):
            return Error(cvn.message)
        rn = attribute_as_number(attr_name, attr_value)
        if isinstance(rn, Error):
            return rn
        return evaluate_number_relation(rn, cmp, float(dv))
    if cmp in (DATETIME_BEFORE, DATETIME_AFTER):
        cvd = comparison_value_as_unix_time_seconds(float(raw_dv) if raw_dv is not None else None)
        if isinstance(cvd, ComparisonValueError):
            return Error(cvd.message)
        rn = attribute_as_unix_time_seconds(attr_name, attr_value)
        if isinstance(rn, Error):
            return rn
        return evaluate_datetime_relation(rn, float(dv), cmp == DATETIME_BEFORE)
    if cmp in (ARRAY_CONTAINS_ANY_OF, ARRAY_NOT_CONTAINS_ANY_OF):
        ra = attribute_as_string_array(attr_name, attr_value)
        if isinstance(ra, Error):
            return ra
        return evaluate_array_contains_any_of(ra, operand_list, cmp == ARRAY_NOT_CONTAINS_ANY_OF)
    if cmp in (SENSITIVE_ARRAY_CONTAINS_ANY_OF, SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF):
        ra = attribute_as_string_array(attr_name, attr_value)
        if isinstance(ra, Error):
            return ra
        return evaluate_sensitive_array_contains_any_of(
            ra,
            operand_list,
            config_salt,
            context_salt,
            cmp == SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
        )
    return Error(f"unknown comparator {cmp}")


def _evaluate_prerequisite_condition(
    condition: dict[str, Any],
    ctx: _EvaluateContext,
) -> ConditionOutcome:
    """Resolve a prerequisite-flag condition (US4) — child context, shared stack."""

    lb = ctx.log_builder

    def prereq_type(prereq_key: str) -> int | None:
        s = ctx.settings.get(prereq_key)
        if isinstance(s, dict):
            t = s.get("t")
            if isinstance(t, int) and not isinstance(t, bool):
                return t
        return None

    # Trace the `Flag 'X' EQUALS 'Y'` condition before recursing (the comparison
    # value is read through the prereq flag's own declared type).
    if lb is not None:
        prereq_key = condition.get("f")
        cmp_text = ""
        if isinstance(prereq_key, str):
            pt = prereq_type(prereq_key)
            if pt is not None:
                cmp_val = _select_setting_value(condition.get("v"), pt)
                if cmp_val is not None:
                    cmp_text = setting_value_to_log_string(cmp_val)
        cmp = condition.get("c")
        lb.append_prerequisite_flag_condition(
            prereq_key if isinstance(prereq_key, str) else "",
            cmp if isinstance(cmp, int) and not isinstance(cmp, bool) else -1,
            cmp_text,
        )

    def evaluate_prereq_flag(prereq_key: str) -> dict[str, Any] | None:
        prereq_setting = ctx.settings.get(prereq_key)
        if not isinstance(prereq_setting, dict):
            raise PrerequisiteReferenceError("Prerequisite flag is missing or invalid.")
        # A prerequisite flag evaluates in its OWN context (configcat
        # forPrerequisiteFlag): the no-user WARN dedups per flag, so a prereq
        # referenced by N rules logs it N times — hence a fresh state that
        # carries forward the already-surfaced eval_error (FR-016).
        child_state = _EvalState(eval_error=ctx.state.eval_error)
        child = _EvaluateContext(
            key=prereq_key,
            setting=prereq_setting,
            settings=ctx.settings,
            segments=ctx.segments,
            config_salt=ctx.config_salt,
            user=ctx.user,
            visited_flags=ctx.visited_flags,
            state=child_state,
            log=ctx.log,
            log_builder=lb,
        )
        # The trace re-enters the full evaluation nested in `( … )` — the child
        # appends its own "Evaluating '<key>' …" header + "Returning '…'.".
        if lb is not None:
            lb.new_line("(").increase_indent().new_line(f"Evaluating '{prereq_key}'")
            if ctx.user is not None:
                lb.append(f" for User '{_user_attributes_for_log_json(ctx.user)}'")
        resolved = _evaluate_setting(child)
        # Bubble up any eval_error the child surfaced (FR-016).
        if ctx.state.eval_error is None and child_state.eval_error is not None:
            ctx.state.eval_error = child_state.eval_error
        if lb is not None:
            declared_type = prereq_type(prereq_key)
            child_value = (
                _select_setting_value(resolved.value, declared_type)
                if declared_type is not None
                else None
            )
            lb.new_line(
                f"Returning '{setting_value_to_log_string(child_value)}'."
            ).decrease_indent().new_line(")")
        return resolved.value

    return evaluate_prerequisite_flag_condition(
        condition,
        ctx.key,
        ctx.visited_flags,
        prereq_type,
        evaluate_prereq_flag,
        _select_setting_value,
    )


def _evaluate_segment_condition(  # noqa: PLR0912 — traced segment block rendering.
    condition: dict[str, Any],
    ctx: _EvaluateContext,
) -> ConditionOutcome:
    """Resolve a segment condition (US4) — segment name as the context salt.

    On the no-trace hot path this delegates to ``segments.evaluate_segment_
    condition`` unchanged. When tracing is on it ports ``evaluator.ts::
    evaluateSegmentCondition`` incl. its nested ``( … )`` block: the segment's
    ``r[]`` is an AND-group of bare user conditions routed through
    :func:`_evaluate_conditions` so the trace renders the IF/AND structure (the
    segment NAME is the sensitive-comparator context salt).
    """
    lb = ctx.log_builder
    if lb is None:
        # Hot path — behaviour identical to before the trace seam existed.
        def surface() -> str:
            _surface_missing_user(ctx)
            return _MISSING_USER_OBJECT_ERROR

        return evaluate_segment_condition(
            condition,
            ctx.segments,
            ctx.user is not None,
            surface,
            lambda uc, salt: _evaluate_user_condition(uc, salt, ctx),
        )

    # Traced path (mirrors Go's evaluateSegmentCond). Resolve the segment name
    # first so the `User IS [NOT] IN SEGMENT 'X'` line is appended before the
    # no-user / reference guards, exactly like the oracle.
    index = condition.get("s")
    segment: dict[str, Any] | None = None
    if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(ctx.segments):
        candidate = ctx.segments[index]
        if isinstance(candidate, dict):
            segment = candidate
    segment_name = ""
    if segment is not None and isinstance(segment.get("n"), str):
        segment_name = segment["n"]
    cmp = condition.get("c")
    cmp_int = cmp if isinstance(cmp, int) and not isinstance(cmp, bool) else SEGMENT_IS_IN
    lb.append_segment_condition(segment_name, cmp_int)

    if ctx.user is None:
        _surface_missing_user(ctx)
        return Error(_MISSING_USER_OBJECT_ERROR)
    if segment is None or segment_name == "":
        raise SegmentReferenceError("Segment reference is invalid.")

    lb.new_line("(").increase_indent().new_line(f"Evaluating segment '{segment_name}':")

    wrapped = [{"u": uc} for uc in segment.get("r", [])]
    in_segment = _evaluate_conditions(wrapped, segment_name, ctx, None)
    errored = isinstance(in_segment, Error)

    # IsNotIn negates a clean boolean outcome; an errored segment is surfaced
    # un-negated — IsNotIn never flips an error into a match.
    result: ConditionOutcome = in_segment
    if not errored and cmp_int == SEGMENT_IS_NOT_IN:
        result = not in_segment

    lb.new_line("Segment evaluation result: ")
    if errored:
        lb.append(ctx.state.eval_error or "")
    elif in_segment is True:
        lb.append("User IS IN SEGMENT")
    else:
        lb.append("User IS NOT IN SEGMENT")
    lb.append(".")
    lb.new_line("Condition (").append_segment_condition(segment_name, cmp_int).append(")")
    if errored:
        lb.append(" failed to evaluate")
    else:
        lb.append(" evaluates to ").append_condition_result(bool(result))
    lb.append(".").decrease_indent().new_line(")")

    if errored:
        return Error(ctx.state.eval_error or _MISSING_USER_OBJECT_ERROR)
    return result


def _surface_missing_user(ctx: _EvaluateContext) -> None:
    """Surface the "User Object is missing" reason once per context (FR-016).

    Also logs the WARN 3001 once per context (common-js parity).
    """
    if ctx.state.eval_error is None:
        ctx.state.eval_error = _MISSING_USER_OBJECT_ERROR
    if not ctx.state.missing_user_object_logged:
        ctx.log.user_object_is_missing(ctx.key)
        ctx.state.missing_user_object_logged = True
