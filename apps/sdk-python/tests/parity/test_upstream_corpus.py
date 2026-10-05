# SPDX-License-Identifier: MIT
"""ConfigCat conformance — replays the vendored upstream evaluation matrix.

Mirrors the spec-117 TS reference suite
(`packages/sdk-shared/tests/parity-upstream.test.ts`) in Python. The corpus
(`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
`configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is the
oracle: each ``(config, key, user) → expected`` tuple is checked against
``evaluate(...).value`` (and ``.variation_id`` for the variation-id matrix).

Scope = the full conformance surface (SC-001): US1 targeting rules, US2 the 36
comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
multilevel + circular detection) / AND-groups, US5 attribute conversion +
trimming + typed-attribute validation + variationId/matched detail. Structured
value/identity is asserted across the corpus; the textual evaluation-log TRACE
(ADR 0003 / epic #494, Python slice of #501) is additionally asserted
byte-identically against ``parity-evaluationlog.json`` (see
``test_eval_log_trace_fidelity``).

The loaders below port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
faithfully — most critically the Go ``csv.Reader`` ``LazyQuotes`` semantics
(a ``"`` only opens a quoted field at the field start), without which every
JSON-array attribute cell is corrupted.
"""

from __future__ import annotations

import functools
import json
import math
import re
import time
from pathlib import Path
from typing import Any

import pytest

from confeature_client.eval_logger import LogLevel
from confeature_client.evaluator import evaluate, evaluate_traced
from confeature_client.user import User

# tests/parity/test_upstream_corpus.py → repo root is parents[4].
_WORKSPACE_ROOT = Path(__file__).resolve().parents[4]
_UPSTREAM_DIR = _WORKSPACE_ROOT / "packages" / "test-fixtures-sdk-parity" / "fixtures" / "upstream"
_EVAL_LOG_TRACE_PATH = (
    _WORKSPACE_ROOT
    / "packages"
    / "test-fixtures-sdk-parity"
    / "fixtures"
    / "parity-evaluationlog.json"
)

_NULL_TOKEN = "##null##"

# ---------------------------------------------------------------------------
# Matrix → SDK key mapping (verbatim from upstream-corpus.ts MATRIX_TO_SDK_KEY).
# `testmatrix_variationId.csv` is the only `variation`-kind matrix.
# ---------------------------------------------------------------------------

_PKD = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
_JCP = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"
_MATRIX_TO_SDK_KEY: list[dict[str, str]] = [
    {"matrix": "testmatrix.csv", "sdkKey": _PKD + "AG6C1ngVb0CvM07un6JisQ", "kind": "value"},
    {
        "matrix": "testmatrix_semantic.csv",
        "sdkKey": _PKD + "iV8vH2MBakKxkFZylxHmTg",
        "kind": "value",
    },
    {"matrix": "testmatrix_number.csv", "sdkKey": _PKD + "FCWN-k1dV0iBf8QZrDgjdw", "kind": "value"},
    {
        "matrix": "testmatrix_semantic_2.csv",
        "sdkKey": _PKD + "U8nt3zEhDEO5S2ulubCopA",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_sensitive.csv",
        "sdkKey": _PKD + "-0YmVOUNgEGKkgRF-rU65g",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_segments_old.csv",
        "sdkKey": _PKD + "y_ZB7o-Xb0Swxth-ZlMSeA",
        "kind": "value",
    },
    {"matrix": "testmatrix_and_or.csv", "sdkKey": _JCP + "ByMO9yZNn02kXcm72lnY1A", "kind": "value"},
    {
        "matrix": "testmatrix_comparators_v6.csv",
        "sdkKey": _JCP + "OfQqcTjfFUGBwMKqtyEOrQ",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_prerequisite_flag.csv",
        "sdkKey": _JCP + "JoGwdqJZQ0K2xDy7LnbyOg",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_segments.csv",
        "sdkKey": _JCP + "h99HYXWWNE2bH8eWyLAVMA",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_unicode.csv",
        "sdkKey": _JCP + "Da6w8dBbmUeMUBhh0iEeQQ",
        "kind": "value",
    },
    {
        "matrix": "testmatrix_variationId.csv",
        "sdkKey": _PKD + "spQnkRTIPEWVivZkWM84lQ",
        "kind": "variation",
    },
]

# ---------------------------------------------------------------------------
# Config loaders (cached).
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _content_by_key_map() -> dict[str, Any]:
    return json.loads((_UPSTREAM_DIR / "content-by-key.json").read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=1)
def _eval_log_configs_map() -> dict[str, Any]:
    path = _UPSTREAM_DIR / "evaluationlog" / "_configs-by-key.json"
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port).
# ---------------------------------------------------------------------------


def _parse_csv_line(line: str) -> list[str]:
    """Parse one CSV line under upstream conventions (LazyQuotes).

    A ``"`` only opens a quoted field when it is the FIRST char of the field;
    anywhere else it is a literal quote. So ``["read","execute"]`` parses to the
    literal string (quotes preserved). Getting this wrong corrupts every
    JSON-array attribute.
    """
    fields: list[str] = []
    field = ""
    in_quotes = False
    field_start = True
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and line[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                field += ch
        elif ch == '"' and field_start:
            in_quotes = True
            field_start = False
        elif ch == ";":
            fields.append(field)
            field = ""
            field_start = True
        else:
            field += ch
            field_start = False
        i += 1
    fields.append(field)
    return fields


_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _parse_cell(s: str) -> bool | int | float | str:
    """Parse a CSV cell to its primitive (mirrors upstream `parseCell`)."""
    if _INT_RE.match(s):
        try:
            n = int(s)
            if abs(n) <= 9007199254740991:
                return n
        except ValueError:
            pass
    if _FLOAT_RE.match(s):
        try:
            return float(s)
        except ValueError:
            pass
    if s == "True":
        return True
    if s == "False":
        return False
    return s


def _user_from_row(line: list[str], custom_key: str) -> User | None:
    """Build a User from the first four CSV columns (port `userFromRow`)."""
    if not line or line[0] == _NULL_TOKEN:
        return None

    def set_or_none(v: str | None) -> str | None:
        return None if v is None or v in ("", _NULL_TOKEN) else v

    identifier = line[0] if len(line) > 0 and line[0] else ""
    email = set_or_none(line[1] if len(line) > 1 else None)
    country = set_or_none(line[2] if len(line) > 2 else None)
    custom_val = set_or_none(line[3] if len(line) > 3 else None)
    custom = {custom_key: custom_val} if custom_val is not None else None
    return User(identifier=identifier, email=email, country=country, custom=custom)


def _load_matrix(matrix: str) -> list[dict[str, Any]]:
    entry = next((m for m in _MATRIX_TO_SDK_KEY if m["matrix"] == matrix), None)
    if entry is None:
        raise ValueError(f"Unknown testmatrix file: {matrix}")
    config = _content_by_key_map().get(entry["sdkKey"])
    if config is None:
        raise ValueError(f"No config for matrix {matrix} (sdkKey {entry['sdkKey']})")

    text = (_UPSTREAM_DIR / matrix).read_text(encoding="utf-8")
    lines = [ln for ln in re.split(r"\r?\n", text) if len(ln) > 0]
    header = _parse_csv_line(lines[0])
    custom_key = header[3]
    setting_keys = header[4:]

    tuples: list[dict[str, Any]] = []
    for r in range(1, len(lines)):
        cols = _parse_csv_line(lines[r])
        user = _user_from_row(cols, custom_key)
        for c, key in enumerate(setting_keys):
            raw = cols[c + 4] if c + 4 < len(cols) else ""
            expected: Any = _parse_cell(raw) if entry["kind"] == "value" else raw
            tuples.append(
                {
                    "matrix": matrix,
                    "key": key,
                    "user": user,
                    "kind": entry["kind"],
                    "expected": expected,
                    "config": config,
                }
            )
    return tuples


# ---------------------------------------------------------------------------
# evaluationlog/<scenario> (port loadEvalLogScenario).
# ---------------------------------------------------------------------------


def _eval_log_user(raw: dict[str, Any] | None) -> User | None:
    if not raw:
        return None
    identifier = ""
    email = None
    country = None
    custom: dict[str, Any] = {}
    for k, v in raw.items():
        val = str(v)
        if k == "Identifier":
            identifier = val
        elif k == "Email":
            email = val
        elif k == "Country":
            country = val
        else:
            custom[k] = val
    return User(
        identifier=identifier,
        email=email,
        country=country,
        custom=custom or None,
    )


def _eval_log_config(suite: dict[str, Any]) -> Any:
    json_override = suite.get("jsonOverride")
    if json_override:
        return json.loads(
            (_UPSTREAM_DIR / "evaluationlog" / "_overrides" / json_override).read_text(
                encoding="utf-8"
            )
        )
    sdk_key = suite.get("sdkKey")
    if sdk_key:
        config = _content_by_key_map().get(sdk_key) or _eval_log_configs_map().get(sdk_key)
        if config is None:
            raise ValueError(f"No config for eval-log sdkKey {sdk_key}")
        return config
    raise ValueError("Eval-log suite has neither jsonOverride nor sdkKey")


def _load_eval_log_scenario(scenario: str) -> list[dict[str, Any]]:
    suite = json.loads(
        (_UPSTREAM_DIR / "evaluationlog" / f"{scenario}.json").read_text(encoding="utf-8")
    )
    config = _eval_log_config(suite)
    out: list[dict[str, Any]] = []
    for t in suite["tests"]:
        out.append(
            {
                "scenario": scenario,
                "key": t["key"],
                "defaultValue": t.get("defaultValue"),
                "user": _eval_log_user(t.get("user")),
                "expectedValue": t["returnValue"],
                "config": config,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Assertion helpers (port assertMatrixTuple / assertEvalLogValue).
# ---------------------------------------------------------------------------


def _setting_type(config: dict[str, Any], key: str) -> int | None:
    settings = config.get("f")
    if isinstance(settings, dict):
        setting = settings.get(key)
        if isinstance(setting, dict):
            t = setting.get("t")
            if isinstance(t, int) and not isinstance(t, bool):
                return t
    return None


def _default_for(expected: Any, setting_type: int | None) -> Any:
    """Type-appropriate default matching the resolved primitive type.

    Python's strict evaluator distinguishes int (``t=2``) from double (``t=3``),
    so the default must be the SAME numeric kind the setting type expects (a
    ``0`` int default against a double setting would be TYPE_MISMATCH). Mirrors
    the TS ``defaultFor`` (JS has one number type, so it returns ``0`` for both).
    """
    if isinstance(expected, bool):
        return False
    if isinstance(expected, (int, float)):
        return 0.0 if setting_type == 3 else 0
    return "__default__"


def _coerce_default(default: Any, setting_type: int | None) -> Any:
    """Cast a JSON-decoded eval-log default to the type implied by ``t``."""
    if isinstance(default, bool):
        return default
    if setting_type == 3 and isinstance(default, int):
        return float(default)
    if setting_type == 2 and isinstance(default, float):
        return int(default)
    return default


def _assert_matrix_tuple(t: dict[str, Any]) -> None:
    config = t["config"]
    user = t["user"]
    label = f"{t['matrix']} {t['key']} user={_user_repr(user)}"
    if t["kind"] == "variation":
        result = evaluate(config, t["key"], None, user)
        assert result.variation_id == t["expected"], label
    else:
        expected = t["expected"]
        default = _default_for(expected, _setting_type(config, t["key"]))
        result = evaluate(config, t["key"], default, user)
        _assert_value_equal(result.value, expected, label)


def _assert_eval_log_value(t: dict[str, Any]) -> None:
    expected = t["expectedValue"]
    setting_type = _setting_type(t["config"], t["key"])
    if t["defaultValue"] is not None:
        default = _coerce_default(t["defaultValue"], setting_type)
    else:
        default = _default_for(expected, setting_type)
    label = f"{t['scenario']} {t['key']} user={_user_repr(t['user'])}"
    result = evaluate(t["config"], t["key"], default, t["user"])
    _assert_value_equal(result.value, expected, label)


def _assert_value_equal(actual: Any, expected: Any, label: str) -> None:
    """Numeric-tolerant equality (5 == 5.0); exact otherwise."""
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        if isinstance(actual, (int, float)) and not isinstance(actual, bool):
            if isinstance(expected, float) and math.isnan(expected):
                assert isinstance(actual, float) and math.isnan(actual), label
                return
            assert actual == expected, f"{label}: actual={actual!r} expected={expected!r}"
            return
    assert actual == expected, f"{label}: actual={actual!r} expected={expected!r}"
    # Booleans must not be silently equated with ints (True == 1 in Python).
    if isinstance(expected, bool) or isinstance(actual, bool):
        assert isinstance(actual, bool) == isinstance(expected, bool), (
            f"{label}: bool/int type drift actual={actual!r} expected={expected!r}"
        )


def _user_repr(user: User | None) -> str:
    if user is None:
        return "None"
    return (
        f"id={user.identifier!r} email={user.email!r} "
        f"country={user.country!r} custom={user.custom!r}"
    )


# ---------------------------------------------------------------------------
# US1/US2/US3 — comparator + value matrices
# ---------------------------------------------------------------------------

_VALUE_MATRICES = [
    "testmatrix.csv",
    "testmatrix_comparators_v6.csv",
    "testmatrix_semantic.csv",
    "testmatrix_semantic_2.csv",
    "testmatrix_number.csv",
    "testmatrix_sensitive.csv",
    "testmatrix_unicode.csv",
]


@pytest.mark.parametrize("matrix", _VALUE_MATRICES)
def test_value_matrices(matrix: str) -> None:
    tuples = _load_matrix(matrix)
    assert tuples, f"{matrix} produced no tuples"
    for t in tuples:
        _assert_matrix_tuple(t)


# ---------------------------------------------------------------------------
# US1 — targeting-rule eval-log scenarios
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scenario", ["1_targeting_rule", "2_targeting_rules", "simple_value"])
def test_targeting_rule_scenarios(scenario: str) -> None:
    for t in _load_eval_log_scenario(scenario):
        _assert_eval_log_value(t)


def test_matched_targeting_rule_is_reported() -> None:
    cases = _load_eval_log_scenario("1_targeting_rule")
    matching = next(c for c in cases if c["expectedValue"] == "Dog")
    result = evaluate(matching["config"], matching["key"], "default", matching["user"])
    assert result.value == "Dog"
    assert result.matched_targeting_rule is not None
    assert result.matched_percentage_option is None
    # The served value's variation id is surfaced (FR-011).
    assert result.variation_id == "d0cd8f06"


def test_no_user_serves_fallback_with_reason_no_raise() -> None:
    no_user = next(c for c in _load_eval_log_scenario("1_targeting_rule") if c["user"] is None)
    result = evaluate(no_user["config"], no_user["key"], "default", None)
    assert result.value == "Cat"  # fallback
    assert result.error is None  # a value was cleanly resolved
    assert result.eval_error is not None and "User Object is missing" in result.eval_error
    assert result.matched_targeting_rule is None


# ---------------------------------------------------------------------------
# US3 — percentage rollout
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    [
        "options_based_on_user_id",
        "options_based_on_custom_attr",
        "options_after_targeting_rule",
        "options_within_targeting_rule",
    ],
)
def test_percentage_scenarios(scenario: str) -> None:
    for t in _load_eval_log_scenario(scenario):
        _assert_eval_log_value(t)


def test_percentage_bucketing_is_deterministic() -> None:
    cases = _load_eval_log_scenario("options_based_on_user_id")
    with_user = next(c for c in cases if c["user"] is not None)
    config, key, user = with_user["config"], with_user["key"], with_user["user"]
    first = evaluate(config, key, "default", user)
    for _ in range(20):
        again = evaluate(config, key, "default", user)
        assert again.value == first.value
        assert again.variation_id == first.variation_id
    assert first.value == with_user["expectedValue"]
    assert first.matched_percentage_option is not None


# ---------------------------------------------------------------------------
# US4 — segments / prerequisites / AND-OR matrices
# ---------------------------------------------------------------------------

_US4_MATRICES = [
    "testmatrix_and_or.csv",
    "testmatrix_segments.csv",
    "testmatrix_segments_old.csv",
    "testmatrix_prerequisite_flag.csv",
]


@pytest.mark.parametrize("matrix", _US4_MATRICES)
def test_us4_matrices(matrix: str) -> None:
    tuples = _load_matrix(matrix)
    assert tuples, f"{matrix} produced no tuples"
    for t in tuples:
        _assert_matrix_tuple(t)


# ---------------------------------------------------------------------------
# US4 — segment / prerequisite / AND eval-log scenarios
# ---------------------------------------------------------------------------

# `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob was
# NOT captured by the spec-117 vendoring (the multilevel chain is served from a
# different, unvendored config). The engine's multilevel-prerequisite logic IS
# exercised by the 3-level circular_dep chain + the reconstructed-chain unit
# test below — this is a vendoring DATA gap, not an engine gap. Excluded LOUDLY
# here (same marker the TS reference uses), never silently skipped.
_UNVENDORED_EVAL_LOG_KEYS = frozenset({"dependentFeatureMultipleLevels"})


@pytest.mark.parametrize("scenario", ["segment", "prerequisite_flag", "and_rules"])
def test_us4_eval_log_scenarios(scenario: str) -> None:
    for t in _load_eval_log_scenario(scenario):
        if t["key"] in _UNVENDORED_EVAL_LOG_KEYS:
            continue
        _assert_eval_log_value(t)


def test_multilevel_prerequisite_resolves_through_reconstructed_chain() -> None:
    # Reconstructed from evaluationlog/prerequisite_flag (its config blob was not
    # vendored, see above). Proves the engine recurses A → B → C correctly.
    config = {
        "p": {"u": "", "r": 0, "s": "salt"},
        "s": [],
        "f": {
            "mainFeatureWithoutUserCondition": {"t": 0, "v": {"b": True}, "i": "main", "r": []},
            "intermediateFeature": {
                "t": 0,
                "v": {"b": False},
                "i": "inter",
                "r": [
                    {
                        "c": [
                            {
                                "p": {
                                    "f": "mainFeatureWithoutUserCondition",
                                    "c": 0,
                                    "v": {"b": True},
                                }
                            },
                            {
                                "p": {
                                    "f": "mainFeatureWithoutUserCondition",
                                    "c": 0,
                                    "v": {"b": True},
                                }
                            },
                        ],
                        "s": {"v": {"b": True}, "i": "interT"},
                    }
                ],
            },
            "dependentFeatureMultipleLevels": {
                "t": 1,
                "v": {"s": "Cat"},
                "i": "dep",
                "r": [
                    {
                        "c": [{"p": {"f": "intermediateFeature", "c": 0, "v": {"b": True}}}],
                        "s": {"v": {"s": "Dog"}, "i": "depDog"},
                    }
                ],
            },
        },
    }
    result = evaluate(config, "dependentFeatureMultipleLevels", "default", None)
    assert result.value == "Dog"
    assert result.matched_targeting_rule is not None


# ---------------------------------------------------------------------------
# US4 — circular-dependency termination (SC-004)
# ---------------------------------------------------------------------------


def test_circular_dep_scenarios_bounded_fallback() -> None:
    for t in _load_eval_log_scenario("circular_dep"):
        start = time.monotonic()
        result = evaluate(t["config"], t["key"], "default", t["user"])
        # Bounded: a cycle must NOT hang.
        assert time.monotonic() - start < 1.0, f"{t['key']} took too long"
        assert result.value == t["expectedValue"] == "default", t["key"]
        # Fail-closed: the cycle raise is caught and surfaced as the default.
        assert result.error is not None, t["key"]


def test_direct_two_flag_cycle_terminates() -> None:
    config = {
        "p": {"u": "", "r": 0, "s": "salt"},
        "s": [],
        "f": {
            "flagA": {
                "t": 1,
                "v": {"s": "A"},
                "i": "a",
                "r": [
                    {
                        "c": [{"p": {"f": "flagB", "c": 0, "v": {"b": True}}}],
                        "s": {"v": {"s": "AA"}, "i": "aa"},
                    }
                ],
            },
            "flagB": {
                "t": 1,
                "v": {"s": "B"},
                "i": "b",
                "r": [
                    {
                        "c": [{"p": {"f": "flagA", "c": 0, "v": {"b": True}}}],
                        "s": {"v": {"s": "BB"}, "i": "bb"},
                    }
                ],
            },
        },
    }
    result = evaluate(config, "flagA", "default", None)
    assert result.value == "default"
    assert result.error is not None


# ---------------------------------------------------------------------------
# US5 — normalization / conversion / trimming (comparison_*.json drivers)
# ---------------------------------------------------------------------------

# Drivers ported verbatim from upstream-corpus.ts (the typed-attribute cases the
# vendored comparison_*.json fixtures are designed to exercise).
_ATTRIBUTE_CONVERSION_DRIVER: list[dict[str, Any]] = [
    {"key": "numberToStringConversion", "custom1": 0.12345, "expected": "1"},
    {"key": "numberToStringConversionInt", "custom1": 125, "expected": "4"},
    {"key": "numberToStringConversionPositiveExp", "custom1": -1.23456789e96, "expected": "2"},
    {"key": "numberToStringConversionNegativeExp", "custom1": -12345.6789e-100, "expected": "4"},
    {"key": "numberToStringConversionNaN", "custom1": math.nan, "expected": "3"},
    {"key": "numberToStringConversionPositiveInf", "custom1": math.inf, "expected": "4"},
    {"key": "numberToStringConversionNegativeInf", "custom1": -math.inf, "expected": "3"},
    {"key": "dateToStringConversion", "custom1": 1680307199.999, "expected": "3"},
    {"key": "dateToStringConversionNaN", "custom1": math.nan, "expected": "3"},
    {"key": "dateToStringConversionPositiveInf", "custom1": math.inf, "expected": "1"},
    {"key": "dateToStringConversionNegativeInf", "custom1": -math.inf, "expected": "5"},
    {
        "key": "stringArrayToStringConversion",
        "custom1": ["read", "Write", " eXecute "],
        "expected": "4",
    },
    {"key": "stringArrayToStringConversionEmpty", "custom1": [], "expected": "5"},
    {
        "key": "stringArrayToStringConversionSpecialChars",
        "custom1": ["+<>%\"'\\/\t\r\n"],
        "expected": "3",
    },
    {
        "key": "stringArrayToStringConversionUnicode",
        "custom1": ["äöüÄÖÜçéèñışğâ¢™✓😀"],
        "expected": "2",
    },
]

_ATTRIBUTE_TRIMMING_DRIVER: list[dict[str, str]] = [
    {"key": "isoneof", "expected": "no trim"},
    {"key": "isnotoneof", "expected": "no trim"},
    {"key": "isoneofhashed", "expected": "no trim"},
    {"key": "isnotoneofhashed", "expected": "no trim"},
    {"key": "equalshashed", "expected": "no trim"},
    {"key": "notequalshashed", "expected": "no trim"},
    {"key": "arraycontainsanyofhashed", "expected": "no trim"},
    {"key": "arraynotcontainsanyofhashed", "expected": "no trim"},
    {"key": "equals", "expected": "no trim"},
    {"key": "notequals", "expected": "no trim"},
    {"key": "startwithanyof", "expected": "no trim"},
    {"key": "notstartwithanyof", "expected": "no trim"},
    {"key": "endswithanyof", "expected": "no trim"},
    {"key": "notendswithanyof", "expected": "no trim"},
    {"key": "arraycontainsanyof", "expected": "no trim"},
    {"key": "arraynotcontainsanyof", "expected": "no trim"},
    {"key": "startwithanyofhashed", "expected": "no trim"},
    {"key": "notstartwithanyofhashed", "expected": "no trim"},
    {"key": "endswithanyofhashed", "expected": "no trim"},
    {"key": "notendswithanyofhashed", "expected": "no trim"},
    {"key": "semverisoneof", "expected": "4 trim"},
    {"key": "semverisnotoneof", "expected": "5 trim"},
    {"key": "semverless", "expected": "6 trim"},
    {"key": "semverlessequals", "expected": "7 trim"},
    {"key": "semvergreater", "expected": "8 trim"},
    {"key": "semvergreaterequals", "expected": "9 trim"},
    {"key": "numberequals", "expected": "10 trim"},
    {"key": "numbernotequals", "expected": "11 trim"},
    {"key": "numberless", "expected": "12 trim"},
    {"key": "numberlessequals", "expected": "13 trim"},
    {"key": "numbergreater", "expected": "14 trim"},
    {"key": "numbergreaterequals", "expected": "15 trim"},
    {"key": "datebefore", "expected": "18 trim"},
    {"key": "dateafter", "expected": "19 trim"},
    {"key": "containsanyof", "expected": "no trim"},
    {"key": "notcontainsanyof", "expected": "no trim"},
]

_VALUE_TRIMMING_DRIVER: list[dict[str, str]] = [
    {"key": "isoneof", "expected": "no trim"},
    {"key": "isnotoneof", "expected": "no trim"},
    {"key": "containsanyof", "expected": "no trim"},
    {"key": "notcontainsanyof", "expected": "no trim"},
    {"key": "isoneofhashed", "expected": "no trim"},
    {"key": "isnotoneofhashed", "expected": "no trim"},
    {"key": "equalshashed", "expected": "no trim"},
    {"key": "notequalshashed", "expected": "no trim"},
    {"key": "arraycontainsanyofhashed", "expected": "no trim"},
    {"key": "arraynotcontainsanyofhashed", "expected": "no trim"},
    {"key": "equals", "expected": "no trim"},
    {"key": "notequals", "expected": "no trim"},
    {"key": "startwithanyof", "expected": "no trim"},
    {"key": "notstartwithanyof", "expected": "no trim"},
    {"key": "endswithanyof", "expected": "no trim"},
    {"key": "notendswithanyof", "expected": "no trim"},
    {"key": "arraycontainsanyof", "expected": "no trim"},
    {"key": "arraynotcontainsanyof", "expected": "no trim"},
    {"key": "startwithanyofhashed", "expected": "no trim"},
    {"key": "notstartwithanyofhashed", "expected": "no trim"},
    {"key": "endswithanyofhashed", "expected": "no trim"},
    {"key": "notendswithanyofhashed", "expected": "no trim"},
    {"key": "semverisoneof", "expected": "4 trim"},
    {"key": "semverisnotoneof", "expected": "5 trim"},
    {"key": "semverless", "expected": "6 trim"},
    {"key": "semverlessequals", "expected": "7 trim"},
    {"key": "semvergreater", "expected": "8 trim"},
    {"key": "semvergreaterequals", "expected": "9 trim"},
]


def _comparison_config(fixture: str) -> Any:
    return json.loads((_UPSTREAM_DIR / f"{fixture}.json").read_text(encoding="utf-8"))


def test_comparison_attribute_conversion() -> None:
    config = _comparison_config("comparison_attribute_conversion")
    for c in _ATTRIBUTE_CONVERSION_DRIVER:
        user = User(identifier="12345", custom={"Custom1": c["custom1"]})
        result = evaluate(config, c["key"], "default", user)
        assert result.value == c["expected"], (
            f"attribute_conversion {c['key']} custom1={c['custom1']!r}: "
            f"actual={result.value!r} expected={c['expected']!r}"
        )


def test_comparison_attribute_trimming() -> None:
    config = _comparison_config("comparison_attribute_trimming")
    for c in _ATTRIBUTE_TRIMMING_DRIVER:
        user = User(
            identifier=" 12345 ",
            country='[" USA "]',
            custom={"Version": " 1.0.0 ", "Number": " 3 ", "Date": " 1705253400 "},
        )
        result = evaluate(config, c["key"], "default", user)
        assert result.value == c["expected"], (
            f"attribute_trimming {c['key']}: actual={result.value!r} expected={c['expected']!r}"
        )


def test_comparison_value_trimming() -> None:
    config = _comparison_config("comparison_value_trimming")
    for c in _VALUE_TRIMMING_DRIVER:
        user = User(
            identifier="12345",
            country='["USA"]',
            custom={"Version": "1.0.0", "Number": "3", "Date": "1705253400"},
        )
        result = evaluate(config, c["key"], "default", user)
        assert result.value == c["expected"], (
            f"value_trimming {c['key']}: actual={result.value!r} expected={c['expected']!r}"
        )


# ---------------------------------------------------------------------------
# US5 — typed-attribute validation outcomes (FR-010) + list truncation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    ["semver_validation", "number_validation", "epoch_date_validation", "list_truncation"],
)
def test_validation_scenarios(scenario: str) -> None:
    for t in _load_eval_log_scenario(scenario):
        _assert_eval_log_value(t)


# ---------------------------------------------------------------------------
# US5 — variationId + matched rule/option detail (FR-011)
# ---------------------------------------------------------------------------


def test_variation_id_matrix() -> None:
    tuples = _load_matrix("testmatrix_variationId.csv")
    assert tuples
    for t in tuples:
        _assert_matrix_tuple(t)


def test_segment_matched_flag_reports_value_and_variation_id() -> None:
    cases = _load_eval_log_scenario("segment")
    match = next(
        c for c in cases if c["key"] == "featureWithSegmentTargeting" and c["user"] is not None
    )
    result = evaluate(match["config"], match["key"], False, match["user"])
    assert result.value is True
    assert result.matched_targeting_rule is not None
    assert result.variation_id is not None


# ---------------------------------------------------------------------------
# Evaluation-log TRACE fidelity (ADR 0003 / epic #494, Python slice of #501)
# ---------------------------------------------------------------------------
#
# Replays `parity-evaluationlog.json` — each scenario tuple carries an
# `expectedTrace` byte-string — and asserts the federated Python evaluator emits
# the byte-identical textual trace. Mirrors the Go reference
# `parity_evallog_trace_test.go` + the TS reference `assertEvalLogTrace`: a
# capturing logger records every (level, eventId, message) the evaluator emits
# during the walk (the WARN 3001/3003/3004 + ERROR 1002 lines, then the INFO 5000
# multi-line trace); each call is rendered "<LEVEL>: [<eventId>] <message>" and
# joined with "\n". `expectedTrace` is already Confeature-canonical, so this is
# the same byte-string every native runner replays.

# The 14 scenarios that carry an `expectedTrace` (the others assert value only).
_TRACE_SCENARIOS = frozenset(
    {
        "simple_value",
        "1_targeting_rule",
        "2_targeting_rules",
        "and_rules",
        "options_based_on_user_id",
        "options_based_on_custom_attr",
        "options_after_targeting_rule",
        "options_within_targeting_rule",
        "list_truncation",
        "number_validation",
        "circular_dep",
        "prerequisite_flag",
        "semver_validation",
        "epoch_date_validation",
    }
)

_LEVEL_LABEL = {
    LogLevel.ERROR: "ERROR",
    LogLevel.WARN: "WARN",
    LogLevel.INFO: "INFO",
    LogLevel.DEBUG: "DEBUG",
}


class _CaptureLogger:
    """Records each emitted (level, eventId, message) for the capture string.

    Mirrors the Go/TS tests' inline logger. ``level()`` reports ``INFO`` so the
    evaluator builds the trace; ``log`` appends each emitted line.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[LogLevel, str, str]] = []

    def level(self) -> LogLevel:
        return LogLevel.INFO

    def log(self, level: LogLevel, event_id: str, message: str) -> None:
        self.calls.append((level, event_id, message))


@functools.lru_cache(maxsize=1)
def _load_eval_log_trace_tuples() -> list[dict[str, Any]]:
    return json.loads(_EVAL_LOG_TRACE_PATH.read_text(encoding="utf-8"))


def _trace_user(raw: dict[str, Any] | None) -> User | None:
    """Build a User from the tuple's lowercase user object (port `traceUser`).

    ``{identifier, email?, country?, custom?}``. Custom values are fed
    un-stringified so the typed-attribute conversion cases are exercised
    faithfully.
    """
    if not raw:
        return None
    identifier = raw.get("identifier")
    email = raw.get("email")
    country = raw.get("country")
    custom = raw.get("custom")
    return User(
        identifier=identifier if isinstance(identifier, str) else "",
        email=email if isinstance(email, str) else None,
        country=country if isinstance(country, str) else None,
        custom=custom if isinstance(custom, dict) and custom else None,
    )


def _trace_default(default: Any, config: dict[str, Any], key: str) -> Any:
    """Coerce the JSON-decoded default to the type the setting expects.

    JSON decodes every integral number to ``int``; the strict evaluator wants a
    ``float`` for a double setting (``t=3``). Matching it keeps the happy path
    clean (a wrong-kind numeric default would TYPE_MISMATCH before the trace).
    """
    if isinstance(default, bool) or not isinstance(default, (int, float)):
        return default
    if _setting_type(config, key) == 3:
        return float(default)
    return int(default)


def _assert_eval_log_trace(t: dict[str, Any]) -> None:
    expected = t.get("expectedTrace")
    if expected is None:
        return
    logger = _CaptureLogger()
    user = _trace_user(t.get("user"))
    default = _trace_default(t.get("defaultValue"), t["config"], t["key"])
    evaluate_traced(t["config"], t["key"], default, user, logger)
    lines = [
        f"{_LEVEL_LABEL[level]}: [{event_id}] {message}"
        for level, event_id, message in logger.calls
    ]
    actual = "\n".join(lines)
    assert actual == expected, (
        f"trace mismatch for {t['scenario']}/{t['key']}\n"
        f"--- want ---\n{expected}\n--- got ---\n{actual}"
    )


def test_eval_log_trace_fidelity() -> None:
    tuples = _load_eval_log_trace_tuples()
    assert tuples, "parity-evaluationlog.json produced no tuples"
    seen: dict[str, int] = {}
    for t in tuples:
        if t.get("expectedTrace") is None or t["scenario"] not in _TRACE_SCENARIOS:
            continue
        seen[t["scenario"]] = seen.get(t["scenario"], 0) + 1
        _assert_eval_log_trace(t)
    # Every trace-bearing scenario must have been asserted (guards a silently
    # shrinking oracle / a renamed scenario).
    for scenario in _TRACE_SCENARIOS:
        assert seen.get(scenario, 0) > 0, f"trace scenario {scenario!r} carried no asserted tuples"
