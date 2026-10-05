# SPDX-License-Identifier: MIT
"""ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494).

Python port of the spec-117 TS reference
(``packages/sdk-shared/src/eval-log.ts`` ``EvaluateLogBuilder``) and the Go port
(``apps/sdk-go/internal/evaluator/eval_log.go``). Produces the byte-identical
indented textual trace ConfigCat's SDKs emit during flag evaluation — its
``evaluationlog/`` corpus (replayed via
``packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json``) is the
byte-oracle. This builder is the analogue of the TS class line-for-line so the
federation ports stay consistent.

The trace is emitted via the trace logger at INFO under event id 5000
(ConfigCat's verbosity contract) — see ``evaluator.evaluate_traced``.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

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
    number_to_canonical_string,
)
from .prerequisites import PREREQUISITE_NOT_EQUALS
from .segments import SEGMENT_IS_NOT_IN

#: ConfigCat's event id for the "config evaluated" INFO log line. Captured as
#: ``... [5000] ...``, matching the upstream oracle.
EVAL_LOG_EVENT_ID = "5000"

#: ConfigCat indents each nested eval-log line by two spaces per level.
_INDENT_UNIT = "  "

# Placeholders ConfigCat substitutes for malformed condition parts (parity with
# configcat-common's EvaluateLogBuilder).
_INVALID_VALUE_PLACEHOLDER = "<invalid value>"
_INVALID_NAME_PLACEHOLDER = "<invalid name>"
_INVALID_OPERATOR_PLACEHOLDER = "<invalid operator>"

#: Max IS-ONE-OF / list items rendered before truncation (configcat parity).
_STRING_LIST_MAX_LENGTH = 10

# Condition-value kind: "l"=list, "s"=string, "n"=number, "dt"=datetime.
# Per-comparator eval-log metadata (configcat-common parity), as
# ``(token, kind, sensitive)`` — ``token`` is the operator rendering, ``kind``
# selects the condition value slot, ``sensitive`` masks the value as
# ``<hashed value>``. One table drives the condition rendering, mirroring
# eval-log.ts COMPARATOR_META.
_COMPARATOR_META: dict[int, tuple[str, str, bool]] = {
    TEXT_IS_ONE_OF: ("IS ONE OF", "l", False),
    TEXT_IS_NOT_ONE_OF: ("IS NOT ONE OF", "l", False),
    TEXT_CONTAINS_ANY_OF: ("CONTAINS ANY OF", "l", False),
    TEXT_NOT_CONTAINS_ANY_OF: ("NOT CONTAINS ANY OF", "l", False),
    SEMVER_IS_ONE_OF: ("IS ONE OF", "l", False),
    SEMVER_IS_NOT_ONE_OF: ("IS NOT ONE OF", "l", False),
    SEMVER_LESS: ("<", "s", False),
    SEMVER_LESS_OR_EQUALS: ("<=", "s", False),
    SEMVER_GREATER: (">", "s", False),
    SEMVER_GREATER_OR_EQUALS: (">=", "s", False),
    NUMBER_EQUALS: ("=", "n", False),
    NUMBER_NOT_EQUALS: ("!=", "n", False),
    NUMBER_LESS: ("<", "n", False),
    NUMBER_LESS_OR_EQUALS: ("<=", "n", False),
    NUMBER_GREATER: (">", "n", False),
    NUMBER_GREATER_OR_EQUALS: (">=", "n", False),
    SENSITIVE_TEXT_IS_ONE_OF: ("IS ONE OF", "l", True),
    SENSITIVE_TEXT_IS_NOT_ONE_OF: ("IS NOT ONE OF", "l", True),
    DATETIME_BEFORE: ("BEFORE", "dt", False),
    DATETIME_AFTER: ("AFTER", "dt", False),
    SENSITIVE_TEXT_EQUALS: ("EQUALS", "s", True),
    SENSITIVE_TEXT_NOT_EQUALS: ("NOT EQUALS", "s", True),
    SENSITIVE_TEXT_STARTS_WITH_ANY_OF: ("STARTS WITH ANY OF", "l", True),
    SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF: ("NOT STARTS WITH ANY OF", "l", True),
    SENSITIVE_TEXT_ENDS_WITH_ANY_OF: ("ENDS WITH ANY OF", "l", True),
    SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF: ("NOT ENDS WITH ANY OF", "l", True),
    SENSITIVE_ARRAY_CONTAINS_ANY_OF: ("ARRAY CONTAINS ANY OF", "l", True),
    SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF: ("ARRAY NOT CONTAINS ANY OF", "l", True),
    TEXT_EQUALS: ("EQUALS", "s", False),
    TEXT_NOT_EQUALS: ("NOT EQUALS", "s", False),
    TEXT_STARTS_WITH_ANY_OF: ("STARTS WITH ANY OF", "l", False),
    TEXT_NOT_STARTS_WITH_ANY_OF: ("NOT STARTS WITH ANY OF", "l", False),
    TEXT_ENDS_WITH_ANY_OF: ("ENDS WITH ANY OF", "l", False),
    TEXT_NOT_ENDS_WITH_ANY_OF: ("NOT ENDS WITH ANY OF", "l", False),
    ARRAY_CONTAINS_ANY_OF: ("ARRAY CONTAINS ANY OF", "l", False),
    ARRAY_NOT_CONTAINS_ANY_OF: ("ARRAY NOT CONTAINS ANY OF", "l", False),
}


def format_user_comparator(comparator: int) -> str:
    """Render a ``UserComparator`` as ConfigCat's eval-log operator token."""
    meta = _COMPARATOR_META.get(comparator)
    return meta[0] if meta is not None else _INVALID_OPERATOR_PLACEHOLDER


def _format_string_list(items: list[str], max_length: int) -> str:
    """Format a string list exactly as configcat-common's ``formatStringList``.

    ``'a', 'b'`` joined by ``", "``, with an optional truncation appendix once
    ``max_length`` is exceeded.
    """
    if not items:
        return ""
    appendix = ""
    shown = items
    if max_length > 0 and len(items) > max_length:
        shown = items[:max_length]
        count = len(items) - max_length
        word = "value" if count == 1 else "values"
        appendix = f", ... <{count} more {word}>"
    return "'" + "', '".join(shown) + "'" + appendix


def setting_value_to_log_string(value: Any) -> str:
    """Format a resolved SETTING value for the eval log (ConfigCat parity).

    ``bool`` → ``true``/``false`` (lowercase), ``str`` → verbatim, number → its
    decimal string. Mirrors the ``'<value>'`` token in ConfigCat's
    ``Returning '<value>'.`` footer (eval-log.ts ``settingValueToString``).
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return number_to_canonical_string(float(value))
    return ""


def _bool_to_log_string(value: bool) -> str:
    """Render a boolean as the lowercase ``true``/``false`` the oracle uses."""
    return "true" if value else "false"


def _unix_seconds_to_iso(seconds: float) -> str | None:
    """Render a Unix-seconds value as ConfigCat's eval-log datetime suffix.

    JS ``new Date(value*1000).toISOString()``, e.g. ``2023-04-01T00:00:00.000Z``
    (always millisecond precision, UTC). Returns ``None`` for non-finite values
    (NaN / ±Inf), matching the JS ``isNaN(date)`` guard.
    """
    if math.isnan(seconds) or math.isinf(seconds):
        return None
    ms = round(seconds * 1000)
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    # Always millisecond precision with a trailing 'Z' (JS toISOString form).
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}" + "Z"


class _MatchOrError:
    """Three-valued THEN consequence (MATCH / no match / error string).

    Mirrors TS's ``boolean | string``. ``kind`` is ``"true"`` / ``"false"`` /
    ``"error"``; ``err_text`` carries the reason for the error case.
    """

    __slots__ = ("err_text", "kind")

    def __init__(self, kind: str, err_text: str = "") -> None:
        self.kind = kind
        self.err_text = err_text


def match_true() -> _MatchOrError:
    return _MatchOrError("true")


def match_false() -> _MatchOrError:
    return _MatchOrError("false")


def match_error(text: str) -> _MatchOrError:
    return _MatchOrError("error", text)


class EvaluateLogBuilder:
    """Python analogue of eval-log.ts ``EvaluateLogBuilder``.

    indent/new_line/append primitives + the condition-rendering helpers. ``eol``
    defaults to ``"\n"`` — the byte the upstream oracle uses.
    """

    def __init__(self, eol: str = "\n") -> None:
        self._chunks: list[str] = []
        self._indent_level = 0
        self._eol = eol

    def append(self, text: str) -> EvaluateLogBuilder:
        """Append text to the current line."""
        self._chunks.append(text)
        return self

    def new_line(self, text: str | None = None) -> EvaluateLogBuilder:
        """Break to a new line at the current indent, then optionally append text."""
        self._chunks.append(self._eol + _INDENT_UNIT * self._indent_level)
        if text is not None:
            self._chunks.append(text)
        return self

    def increase_indent(self) -> EvaluateLogBuilder:
        self._indent_level += 1
        return self

    def decrease_indent(self) -> EvaluateLogBuilder:
        if self._indent_level > 0:
            self._indent_level -= 1
        return self

    # ---- condition formatting ------------------------------------------------

    def _append_user_condition_core(
        self, attr: str, comparator: int, value: str
    ) -> EvaluateLogBuilder:
        if value == "":
            value = _INVALID_VALUE_PLACEHOLDER
        return self.append(f"User.{attr} {format_user_comparator(comparator)} '{value}'")

    def _append_user_condition_string(
        self, attr: str, comparator: int, value: str | None, is_sensitive: bool
    ) -> EvaluateLogBuilder:
        if not isinstance(value, str):
            return self._append_user_condition_core(attr, comparator, "")
        if is_sensitive:
            return self._append_user_condition_core(attr, comparator, "<hashed value>")
        return self._append_user_condition_core(attr, comparator, value)

    def _append_user_condition_string_list(
        self, attr: str, comparator: int, values: list[str] | None, is_sensitive: bool
    ) -> EvaluateLogBuilder:
        if not isinstance(values, list):
            return self._append_user_condition_core(attr, comparator, "")
        comparator_text = format_user_comparator(comparator)
        if is_sensitive:
            word = "value" if len(values) == 1 else "values"
            return self.append(f"User.{attr} {comparator_text} [<{len(values)} hashed {word}>]")
        list_text = _format_string_list(values, _STRING_LIST_MAX_LENGTH)
        return self.append(f"User.{attr} {comparator_text} [{list_text}]")

    def _append_user_condition_number(
        self, attr: str, comparator: int, value: float | None, is_datetime: bool
    ) -> EvaluateLogBuilder:
        if value is None:
            return self._append_user_condition_core(attr, comparator, "")
        comparator_text = format_user_comparator(comparator)
        value_text = number_to_canonical_string(value)
        if is_datetime:
            iso = _unix_seconds_to_iso(value)
            if iso is not None:
                return self.append(f"User.{attr} {comparator_text} '{value_text}' ({iso} UTC)")
        return self.append(f"User.{attr} {comparator_text} '{value_text}'")

    def append_user_condition(  # noqa: PLR0911 — value-slot dispatch by kind.
        self, condition: dict[str, Any]
    ) -> EvaluateLogBuilder:
        """Render one user condition (``User.<attr> <COMP> <value>``).

        The compact ``IUserCondition`` carries the value in ``l`` (list), ``s``
        (string / sensitive-equals), or ``d`` (number / datetime), selected by
        the comparator kind.
        """
        raw_attr = condition.get("a")
        attr = raw_attr if isinstance(raw_attr, str) else _INVALID_NAME_PLACEHOLDER
        c = condition.get("c")
        if not isinstance(c, int) or isinstance(c, bool):
            c = -1
        meta = _COMPARATOR_META.get(c)
        if meta is None:
            # Unknown comparator: fall back to the first present value slot.
            sv = condition.get("s")
            if isinstance(sv, str):
                return self._append_user_condition_core(attr, c, sv)
            dv = condition.get("d")
            if dv is not None:
                return self._append_user_condition_core(
                    attr, c, number_to_canonical_string(float(dv))
                )
            lv = condition.get("l")
            if isinstance(lv, list) and lv:
                return self._append_user_condition_core(attr, c, str(lv[0]))
            return self._append_user_condition_core(attr, c, "")
        _, kind, sensitive = meta
        if kind == "l":
            lv = condition.get("l")
            return self._append_user_condition_string_list(
                attr, c, lv if isinstance(lv, list) else None, sensitive
            )
        if kind == "s":
            sv = condition.get("s")
            return self._append_user_condition_string(attr, c, sv, sensitive)
        if kind == "n":
            dv = condition.get("d")
            return self._append_user_condition_number(
                attr, c, float(dv) if dv is not None else None, False
            )
        # kind == "dt"
        dv = condition.get("d")
        return self._append_user_condition_number(
            attr, c, float(dv) if dv is not None else None, True
        )

    def append_condition_consequence(self, result: bool) -> EvaluateLogBuilder:
        """Append a single condition's boolean result (`` => true`` / `` => false, …``)."""
        self.append(f" => {_bool_to_log_string(result)}")
        if result:
            return self
        return self.append(", skipping the remaining AND conditions")

    def append_targeting_rule_consequence(
        self,
        then_value: str | None,
        match_kind: _MatchOrError,
        new_line: bool,
    ) -> EvaluateLogBuilder:
        """Append a targeting rule's THEN consequence.

        ``then_value`` is the rule's formatted served value (e.g. ``Dog``) for a
        fixed-value rule, or ``None`` for a rule serving ``% options``.
        ``match_kind`` is MATCH / no match / an error string.
        """
        self.increase_indent()
        if new_line:
            self.new_line()
        else:
            self.append(" ")
        self.append("THEN")
        self.append(f" '{then_value}'" if then_value is not None else " % options")
        self.append(" => ")
        if match_kind.kind == "true":
            self.append("MATCH, applying rule")
        elif match_kind.kind == "false":
            self.append("no match")
        else:
            self.append(match_kind.err_text)
        return self.decrease_indent()

    def append_prerequisite_flag_condition(
        self, prereq_key: str, comparator: int, comparison_value: str
    ) -> EvaluateLogBuilder:
        """Append a prerequisite-flag condition (``Flag 'X' EQUALS 'Y'``)."""
        op = "NOT EQUALS" if comparator == PREREQUISITE_NOT_EQUALS else "EQUALS"
        return self.append(f"Flag '{prereq_key}' {op} '{comparison_value}'")

    def append_segment_condition(self, segment_name: str, comparator: int) -> EvaluateLogBuilder:
        """Append a segment condition (``User IS [NOT] IN SEGMENT 'X'``)."""
        op = "IS NOT IN SEGMENT" if comparator == SEGMENT_IS_NOT_IN else "IS IN SEGMENT"
        return self.append(f"User {op} '{segment_name}'")

    def append_condition_result(self, result: bool) -> EvaluateLogBuilder:
        """Append a bare boolean condition result (``true`` / ``false``)."""
        return self.append(_bool_to_log_string(result))

    def __str__(self) -> str:
        return "".join(self._chunks)
