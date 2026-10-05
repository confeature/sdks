# SPDX-License-Identifier: MIT
"""The 36 ConfigCat ``UserComparator`` operations + attribute conversion.

Ported field-for-field from the spec-117 TS reference
(`packages/sdk-shared/src/comparators.ts`), itself verified against common-js
``RolloutEvaluator.ts`` (``configcat-common@9.4.1``).

Each comparator returns a three-valued :data:`ConditionOutcome`: ``True``
(match), ``False`` (no match), or an :class:`Error` (a validation / conversion
failure — bad semver, non-numeric number, non-array array). An error
short-circuits the AND group like ``False`` but is surfaced rather than
silently swallowed (FR-010).

The six families: text (cleartext, case-SENSITIVE, no trim); sensitive text
(SHA-256 SALTED, length-prefixed slice variants); semver (on
:func:`~confeature_client.semver.parse_semver`); number (strict whole-string
parse, ``,``→``.``); datetime (Before/After, Unix seconds); array
(contains/notContains, cleartext + sensitive).

Attribute conversion + the missing-attribute / no-user gates live in the
evaluator's condition dispatch; the functions here receive an already
type-converted operand and apply the operator.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TypeGuard

from .hash import hash_comparison_value, hash_comparison_value_slice
from .semver import SemVer, parse_semver

# UserComparator discriminators (mirror config-json.ts UserComparator).
TEXT_IS_ONE_OF = 0
TEXT_IS_NOT_ONE_OF = 1
TEXT_CONTAINS_ANY_OF = 2
TEXT_NOT_CONTAINS_ANY_OF = 3
SEMVER_IS_ONE_OF = 4
SEMVER_IS_NOT_ONE_OF = 5
SEMVER_LESS = 6
SEMVER_LESS_OR_EQUALS = 7
SEMVER_GREATER = 8
SEMVER_GREATER_OR_EQUALS = 9
NUMBER_EQUALS = 10
NUMBER_NOT_EQUALS = 11
NUMBER_LESS = 12
NUMBER_LESS_OR_EQUALS = 13
NUMBER_GREATER = 14
NUMBER_GREATER_OR_EQUALS = 15
SENSITIVE_TEXT_IS_ONE_OF = 16
SENSITIVE_TEXT_IS_NOT_ONE_OF = 17
DATETIME_BEFORE = 18
DATETIME_AFTER = 19
SENSITIVE_TEXT_EQUALS = 20
SENSITIVE_TEXT_NOT_EQUALS = 21
SENSITIVE_TEXT_STARTS_WITH_ANY_OF = 22
SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF = 23
SENSITIVE_TEXT_ENDS_WITH_ANY_OF = 24
SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF = 25
SENSITIVE_ARRAY_CONTAINS_ANY_OF = 26
SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF = 27
TEXT_EQUALS = 28
TEXT_NOT_EQUALS = 29
TEXT_STARTS_WITH_ANY_OF = 30
TEXT_NOT_STARTS_WITH_ANY_OF = 31
TEXT_ENDS_WITH_ANY_OF = 32
TEXT_NOT_ENDS_WITH_ANY_OF = 33
ARRAY_CONTAINS_ANY_OF = 34
ARRAY_NOT_CONTAINS_ANY_OF = 35


@dataclass(frozen=True)
class Error:
    """A validation / conversion failure outcome (surfaced, not silent)."""

    message: str


#: Three-valued condition outcome: ``True`` / ``False`` / :class:`Error`.
ConditionOutcome = bool | Error

#: A typed user-attribute value (after the User dataclass widening). Mirrors
#: the TS `string | number | boolean | readonly string[] | Date`. Python models
#: `Date` as a native :class:`datetime.datetime` — matching upstream
#: ``configcat-python``, which accepts ``datetime`` custom attributes and
#: converts them to second-based Unix timestamps. A bare epoch-seconds number is
#: also accepted (the Date and the equivalent number resolve identically).
AttributeValue = str | int | float | bool | datetime | list[str]


def datetime_to_seconds_since_epoch(value: datetime) -> float:
    """Convert a ``datetime`` to a second-based Unix timestamp (fractional).

    Mirrors upstream ``configcat-python``'s ``get_seconds_since_epoch``: a naive
    instant (``tzinfo is None``) is treated as UTC, then the delta from the Unix
    epoch is returned as ``total_seconds()`` — fractional seconds preserved
    (e.g. ``datetime(2023, 3, 31, 23, 59, 59, 999000)`` → ``1680307199.999``).
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (value - epoch).total_seconds()


# ---------------------------------------------------------------------------
# Attribute conversion helpers (common-js RolloutEvaluator.ts)
# ---------------------------------------------------------------------------


def is_string_array(value: object) -> TypeGuard[list[str]]:
    """True iff every element of ``value`` is a string (common-js `isStringArray`)."""
    return isinstance(value, list) and all(isinstance(e, str) for e in value)


def _number_to_canonical_string(value: float) -> str:
    """Stringify a number as ConfigCat's canonical string (common-js `+""`).

    Mirrors JavaScript ``Number.prototype.toString`` (ECMAScript
    ``Number::toString``): ``NaN`` / ``±Infinity`` print as ``"NaN"`` /
    ``"Infinity"`` / ``"-Infinity"``; otherwise fixed-point unless the
    magnitude warrants exponential (integer part ≥ 1e21 or a fraction with
    exponent < -6), with the SHORTEST round-tripping digit sequence.

    The corpus conversion cases (``numberToStringConversion*``) hinge on exact
    parity with this — e.g. ``-1.23456789e+96`` must NOT expand to its full
    integer form.
    """
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    return _js_number_to_string(value)


def number_to_canonical_string(value: float) -> str:
    """Public alias for :func:`_number_to_canonical_string` (eval-log reuse).

    The eval-log trace builder (``eval_log.py``) and the #509 comparison-value
    validators render numeric operands through ConfigCat's canonical
    ``Number.prototype.toString`` form; exposing the helper keeps the single
    implementation here (no duplicate formatter).
    """
    return _number_to_canonical_string(value)


def _js_number_to_string(value: float) -> str:
    """Render a finite non-zero float exactly as ECMAScript ``Number::toString``.

    Uses Python's shortest round-tripping ``repr`` to obtain the significant
    digits + decimal exponent, then formats per the ECMAScript algorithm
    (steps 5-10 of 7.1.12.1): fixed-point for ``-6 <= n <= 21`` (where ``n`` is
    the position of the decimal point relative to the first significant digit),
    exponential otherwise.
    """
    sign = "-" if value < 0 else ""
    av = abs(value)
    # Shortest digit string + decimal-point position `n` (the ECMAScript `n`):
    # the decimal point sits after `n` digits counting from the first
    # significant one. Derive from Python's shortest round-tripping repr.
    shortest = repr(av)
    digits, point = _shortest_digits_and_point(shortest)
    k = len(digits)
    n = point  # number of integer-part digits implied (can be <=0 or >k).

    if k <= n <= 21:
        # Fixed, no fraction: digits followed by (n-k) zeros.
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    # Exponential notation.
    e = n - 1
    exp_sign = "+" if e >= 0 else "-"
    mant = digits[0] if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mant}e{exp_sign}{abs(e)}"


def _shortest_digits_and_point(shortest: str) -> tuple[str, int]:
    """Decompose Python's shortest ``repr(abs_float)`` into (digits, point).

    Returns the significant-digit string (no point, no leading/trailing
    structural zeros beyond significance) and ``point`` = the count of digits
    before the decimal point in normalized form (the ECMAScript ``n``).
    """
    if "e" in shortest or "E" in shortest:
        mant, _, exp = shortest.replace("E", "e").partition("e")
        exp_val = int(exp)
    else:
        mant = shortest
        exp_val = 0
    if "." in mant:
        int_part, frac_part = mant.split(".")
    else:
        int_part, frac_part = mant, ""
    raw = int_part + frac_part
    # Decimal point originally sits after len(int_part) digits, shifted by exp.
    point = len(int_part) + exp_val
    # Strip leading zeros (adjusting point), then trailing zeros.
    lead = 0
    while lead < len(raw) - 1 and raw[lead] == "0":
        lead += 1
        point -= 1
    raw = raw[lead:]
    raw = raw.rstrip("0") or "0"
    return raw, point


def user_attribute_value_to_string(value: AttributeValue) -> str:
    """Stringify a user-attribute value (common-js `userAttributeValueToString`).

    ``str`` verbatim; ``bool`` → ``"true"``/``"false"`` (JS lowercase);
    ``datetime`` → its second-based Unix timestamp rendered as a canonical
    number (e.g. ``1680307199.999``); string array → ``JSON.stringify``
    (compact, comma+colon separators, JS escaping); number → JS canonical
    string; else ``str(value)``.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    # `datetime` → epoch seconds → canonical number string. Checked before the
    # int/float branch so a `Date` renders as its timestamp (upstream parity).
    if isinstance(value, datetime):
        return _number_to_canonical_string(datetime_to_seconds_since_epoch(value))
    if is_string_array(value):
        # JS JSON.stringify: no spaces after separators, ensure_ascii=False.
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, (int, float)):
        return _number_to_canonical_string(value)
    return str(value)


def parse_float_strict(value: str) -> float:
    """Strict whole-string float parse (common-js `parseFloatStrict`).

    Rejects empty / all-whitespace and a leading ``0`` followed by a
    non-digit/non-``.``/non-``e`` (octal / hex). Returns ``nan`` on rejection.
    JS's ``parseFloat`` is too forgiving (prefix parse), so ``"12abc"`` is NaN.
    """
    if not value or re.match(r"^\s*$|^\s*0[^\d.eE]", value):
        return math.nan
    try:
        return float(value)
    except ValueError:
        # JS `+value` yields NaN for non-numeric; mirror that (no raise).
        return math.nan


# ---------------------------------------------------------------------------
# Text — cleartext (case-sensitive, no trim)
# ---------------------------------------------------------------------------


def evaluate_text_equals(text: str, comparison_value: str, negate: bool) -> bool:
    return (text == comparison_value) != negate


def evaluate_text_is_one_of(text: str, comparison_values: list[str], negate: bool) -> bool:
    return (text in comparison_values) != negate


def evaluate_text_contains_any_of(text: str, comparison_values: list[str], negate: bool) -> bool:
    for item in comparison_values:
        if item in text:
            return not negate
    return negate


def evaluate_text_slice_equals_any_of(
    text: str,
    comparison_values: list[str],
    starts_with: bool,
    negate: bool,
) -> bool:
    """Cleartext startsWith/endsWith-any-of. Items longer than text are skipped."""
    for item in comparison_values:
        if len(text) < len(item):
            continue
        result = text.startswith(item) if starts_with else text.endswith(item)
        if result:
            return not negate
    return negate


# ---------------------------------------------------------------------------
# Text — sensitive (SHA-256 salted)
# ---------------------------------------------------------------------------


def evaluate_sensitive_text_equals(
    text: str,
    comparison_value: str,
    config_json_salt: str,
    context_salt: str,
    negate: bool,
) -> bool:
    h = hash_comparison_value(text, config_json_salt, context_salt)
    return (h == comparison_value) != negate


def evaluate_sensitive_text_is_one_of(
    text: str,
    comparison_values: list[str],
    config_json_salt: str,
    context_salt: str,
    negate: bool,
) -> bool:
    h = hash_comparison_value(text, config_json_salt, context_salt)
    return (h in comparison_values) != negate


def evaluate_sensitive_text_slice_equals_any_of(
    text: str,
    comparison_values: list[str],
    config_json_salt: str,
    context_salt: str,
    starts_with: bool,
    negate: bool,
) -> bool:
    """Sensitive startsWith/endsWith-any-of.

    Each operand is ``"<byteLen>_<hash>"``; the SDK hashes the matching-length
    BYTE prefix/suffix of the attribute and compares to ``<hash>``. Slicing is
    over the UTF-8 byte sequence (not code points), matching common-js.
    """
    text_utf8 = text.encode("utf-8")
    for item in comparison_values:
        index = item.find("_")
        if index < 0:
            continue
        try:
            slice_length = int(item[:index])
        except ValueError:
            continue
        if len(text_utf8) < slice_length:
            continue
        slice_utf8 = (
            text_utf8[:slice_length] if starts_with else text_utf8[len(text_utf8) - slice_length :]
        )
        h = hash_comparison_value_slice(slice_utf8, config_json_salt, context_salt)
        if h == item[index + 1 :]:
            return not negate
    return negate


# ---------------------------------------------------------------------------
# Semver
# ---------------------------------------------------------------------------


def evaluate_semver_is_one_of(
    version: SemVer,
    comparison_values: list[str],
    negate: bool,
) -> bool:
    """Semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5).

    Each operand is trimmed first; an operand that is empty AFTER trimming
    (incl. whitespace-only) is skipped — matching ConfigCat, which trims before
    the empty check. A non-empty but unparseable operand makes the whole
    comparator ``False`` (backward-compat). Iterates ALL operands (no early-out
    on match) to match upstream's "none invalid" requirement.
    """
    result = False
    for item in comparison_values:
        trimmed = item.strip()
        if not trimmed:
            continue
        version2 = parse_semver(trimmed)
        if version2 is None:
            return False
        if not result and version.compare(version2) == 0:
            result = True
    return result != negate


def evaluate_semver_relation(
    version: SemVer,
    comparator: int,
    comparison_value: str,
) -> bool:
    """Semver relations (comparators 6-9). Unparseable operand -> ``False``."""
    version2 = parse_semver(comparison_value.strip())
    if version2 is None:
        return False
    cmp = version.compare(version2)
    if comparator == SEMVER_LESS:
        return cmp < 0
    if comparator == SEMVER_LESS_OR_EQUALS:
        return cmp <= 0
    if comparator == SEMVER_GREATER:
        return cmp > 0
    if comparator == SEMVER_GREATER_OR_EQUALS:
        return cmp >= 0
    return False


# ---------------------------------------------------------------------------
# Number
# ---------------------------------------------------------------------------


def evaluate_number_relation(  # noqa: PLR0911 - one return per relational operator.
    num: float, comparator: int, comparison_value: float
) -> bool:
    if comparator == NUMBER_EQUALS:
        return num == comparison_value
    if comparator == NUMBER_NOT_EQUALS:
        return num != comparison_value
    if comparator == NUMBER_LESS:
        return num < comparison_value
    if comparator == NUMBER_LESS_OR_EQUALS:
        return num <= comparison_value
    if comparator == NUMBER_GREATER:
        return num > comparison_value
    if comparator == NUMBER_GREATER_OR_EQUALS:
        return num >= comparison_value
    return False


# ---------------------------------------------------------------------------
# Datetime (Unix seconds)
# ---------------------------------------------------------------------------


def evaluate_datetime_relation(seconds: float, comparison_value: float, before: bool) -> bool:
    return seconds < comparison_value if before else seconds > comparison_value


# ---------------------------------------------------------------------------
# Array (cleartext + sensitive)
# ---------------------------------------------------------------------------


def evaluate_array_contains_any_of(
    array: list[str],
    comparison_values: list[str],
    negate: bool,
) -> bool:
    for item in array:
        if item in comparison_values:
            return not negate
    return negate


def evaluate_sensitive_array_contains_any_of(
    array: list[str],
    comparison_values: list[str],
    config_json_salt: str,
    context_salt: str,
    negate: bool,
) -> bool:
    for item in array:
        h = hash_comparison_value(item, config_json_salt, context_salt)
        if h in comparison_values:
            return not negate
    return negate


# ---------------------------------------------------------------------------
# Attribute → typed value, with three-valued error outcome (FR-010)
# ---------------------------------------------------------------------------


def _invalid_attr(attr: str, reason: str) -> Error:
    return Error(f"cannot evaluate, the User.{attr} attribute is invalid ({reason})")


def attribute_as_text(value: AttributeValue) -> str:
    """Attribute → text (string verbatim; else stringified — never errors)."""
    return value if isinstance(value, str) else user_attribute_value_to_string(value)


def attribute_as_semver(attr: str, value: AttributeValue) -> SemVer | Error:
    """Attribute → semver, or a validation error."""
    if isinstance(value, str):
        version = parse_semver(value.strip())
        if version is not None:
            return version
    return _invalid_attr(
        attr, f"'{user_attribute_value_to_string(value)}' is not a valid semantic version"
    )


def attribute_as_number(attr: str, value: AttributeValue) -> float | Error:
    """Attribute → number, or a validation error."""
    # A `datetime` resolves to its second-based Unix timestamp (upstream
    # converts numeric/datetime attributes through the same path).
    if isinstance(value, datetime):
        return datetime_to_seconds_since_epoch(value)
    # `isinstance(True, int)` is True — bools are not numbers here.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        num = parse_float_strict(value.replace(",", "."))
        if not math.isnan(num) or value.strip() == "NaN":
            return num
    return _invalid_attr(
        attr, f"'{user_attribute_value_to_string(value)}' is not a valid decimal number"
    )


def attribute_as_unix_time_seconds(attr: str, value: AttributeValue) -> float | Error:
    """Attribute → Unix seconds, or a validation error.

    A ``datetime`` is converted to its second-based Unix timestamp (naive →
    UTC); a numeric attribute is already seconds; a string is parsed strictly.
    """
    if isinstance(value, datetime):
        return datetime_to_seconds_since_epoch(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        num = parse_float_strict(value.replace(",", "."))
        if not math.isnan(num) or value.strip() == "NaN":
            return num
    return _invalid_attr(
        attr,
        f"'{user_attribute_value_to_string(value)}' is not a valid Unix timestamp "
        "(number of seconds elapsed since Unix epoch)",
    )


def attribute_as_string_array(attr: str, value: AttributeValue) -> list[str] | Error:
    """Attribute → string array, or a validation error.

    A string attribute is JSON-parsed; the result must be a string array.
    """
    arr: object = value
    if isinstance(arr, str):
        try:
            arr = json.loads(arr)
        except (ValueError, TypeError):
            # A non-JSON string is simply not a valid array (matches common-js
            # no-op catch); falls through to the validation error below.
            arr = value
    if is_string_array(arr):
        return list(arr)
    return _invalid_attr(
        attr, f"'{user_attribute_value_to_string(value)}' is not a valid string array"
    )


# ---------------------------------------------------------------------------
# Comparison-value validation (#509) — config operand validated BEFORE the user
# attribute for the semver-relation / number / datetime comparators.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ComparisonValueError:
    """A malformed CONFIG comparison value (#509).

    configcat-common validates the operand BEFORE the user attribute for the
    semver relations, number relations, and datetime comparators; a malformed
    operand surfaces this distinct ``comparison value '<v>' is invalid
    (<reason>)`` outcome (NO "please check the User.<attr>…" suffix — the fault
    is in the config, not the user) which wins even when the attribute is ALSO
    malformed. It short-circuits the AND group like ``False``.
    """

    message: str


def _invalid_comparison_value(value: str, reason: str) -> ComparisonValueError:
    return ComparisonValueError(f"comparison value '{value}' is invalid ({reason})")


def comparison_value_as_semver(value: str) -> SemVer | ComparisonValueError:
    """Config semver operand → semver, or a comparison-value error.

    The operand is trimmed before parsing (parity with
    :func:`evaluate_semver_relation`); the error reports the UNTRIMMED operand.
    """
    version = parse_semver(value.strip())
    if version is not None:
        return version
    return _invalid_comparison_value(value, f"'{value}' is not a valid semantic version")


def _comparison_value_number_string(value: float | None) -> str:
    """Render a numeric operand for the comparison-value error message.

    Mirrors TS's ``String(value)``: an absent operand prints ``"undefined"``,
    otherwise the canonical number string.
    """
    if value is None:
        return "undefined"
    return _number_to_canonical_string(value)


def comparison_value_as_number(value: float | None) -> float | ComparisonValueError:
    """Config number operand → number, or a comparison-value error.

    ``value`` is the condition's ``d`` slot (``None`` when absent).
    """
    if value is not None and not math.isnan(value):
        return value
    s = _comparison_value_number_string(value)
    return _invalid_comparison_value(s, f"'{s}' is not a valid decimal number")


def comparison_value_as_unix_time_seconds(value: float | None) -> float | ComparisonValueError:
    """Config datetime operand → Unix seconds, or a comparison-value error."""
    if value is not None and not math.isnan(value):
        return value
    s = _comparison_value_number_string(value)
    return _invalid_comparison_value(
        s,
        f"'{s}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)",
    )
