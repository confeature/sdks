# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.evaluator` — the four-type evaluator.

Covers the four-type decision tree (spec 072, issue #259):
  - happy path: cached bool / str / int / float, matching default → cached value.
  - missing key → default + KEY_NOT_FOUND.
  - mismatched default type → default + TYPE_MISMATCH (strict per-language).
  - genuinely unknown SettingType → default + UNSUPPORTED_TYPE.
  - malformed inputs → default + reason-coded error.
"""

from __future__ import annotations

from typing import Any

from confeature_client.evaluator import evaluate
from confeature_client.user import User


def _config(settings: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {"p": {"u": "https://cdn", "r": 0, "s": "v1"}, "f": settings, "s": []}


class TestHappyPath:
    def test_boolean_cached_true(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": {"b": True}, "i": "var-1", "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is True
        assert result.error is None
        assert result.variation_id == "var-1"

    def test_boolean_cached_false_overrides_true_default(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": {"b": False}, "r": []}})
        result = evaluate(config, "feature.x", True)
        assert result.value is False
        assert result.error is None

    def test_user_argument_accepted_but_ignored(self) -> None:
        # The v1 evaluator ignores user; the field is accepted for API
        # parity with the future targeting-aware evaluator.
        config = _config({"feature.x": {"t": 0, "v": {"b": True}, "r": []}})
        user = User(identifier="alice@example.com", email="a@e.com", country="FR")
        result = evaluate(config, "feature.x", False, user)
        assert result.value is True


class TestMissingKey:
    def test_missing_key_returns_default(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.y", False)
        assert result.value is False
        assert result.error == "KEY_NOT_FOUND"

    def test_empty_settings_returns_default(self) -> None:
        result = evaluate(_config({}), "anything", True)
        assert result.value is True
        assert result.error == "KEY_NOT_FOUND"


class TestTypeMismatch:
    def test_non_boolean_default_returns_default(self) -> None:
        # Setting is boolean but default is a string → TYPE_MISMATCH.
        config = _config({"feature.x": {"t": 0, "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.x", "fallback")
        assert result.value == "fallback"
        assert result.error == "TYPE_MISMATCH"

    def test_int_default_against_bool_setting_returns_default(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.x", 42)
        assert result.value == 42
        assert result.error == "TYPE_MISMATCH"


class TestUnsupportedType:
    def test_genuinely_unknown_setting_type_returns_default(self) -> None:
        # t=99 is not a recognised SettingType — the only remaining
        # path that returns UNSUPPORTED_TYPE after spec 072's widening.
        config = _config({"feature.x": {"t": 99, "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is False
        assert result.error == "UNSUPPORTED_TYPE"

    def test_non_numeric_setting_type_returns_malformed_config(self) -> None:
        # A non-numeric `t` is malformed — predates the widening.
        config = _config({"feature.x": {"t": "bool", "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is False
        assert result.error == "MALFORMED_CONFIG"


class TestTypedString:
    def test_string_setting_resolves_to_native_str(self) -> None:
        config = _config({"feature.x": {"t": 1, "v": {"s": "hello"}, "i": "var-s", "r": []}})
        result = evaluate(config, "feature.x", "fallback")
        assert result.value == "hello"
        assert result.error is None
        assert result.variation_id == "var-s"

    def test_string_setting_with_int_default_returns_type_mismatch(self) -> None:
        config = _config({"feature.x": {"t": 1, "v": {"s": "hello"}, "r": []}})
        result = evaluate(config, "feature.x", 42)
        assert result.value == 42
        assert result.error == "TYPE_MISMATCH"

    def test_string_setting_with_bool_default_returns_type_mismatch(self) -> None:
        # `isinstance(True, str)` is False — bool defaults reject the
        # string-typed setting via TYPE_MISMATCH.
        config = _config({"feature.x": {"t": 1, "v": {"s": "hello"}, "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is False
        assert result.error == "TYPE_MISMATCH"

    def test_string_setting_missing_s_slot_returns_malformed_value(self) -> None:
        config = _config({"feature.x": {"t": 1, "v": {"b": True}, "r": []}})
        result = evaluate(config, "feature.x", "fallback")
        assert result.value == "fallback"
        assert result.error == "MALFORMED_VALUE"


class TestTypedInt:
    def test_int_setting_resolves_to_native_int(self) -> None:
        config = _config({"feature.x": {"t": 2, "v": {"i": 7}, "i": "var-i", "r": []}})
        result = evaluate(config, "feature.x", -1)
        assert result.value == 7
        assert isinstance(result.value, int)
        # Guard against the bool-as-int trap.
        assert not isinstance(result.value, bool)
        assert result.error is None
        assert result.variation_id == "var-i"

    def test_int_setting_with_string_default_returns_type_mismatch(self) -> None:
        config = _config({"feature.x": {"t": 2, "v": {"i": 7}, "r": []}})
        result = evaluate(config, "feature.x", "fallback")
        assert result.value == "fallback"
        assert result.error == "TYPE_MISMATCH"

    def test_int_setting_with_bool_default_returns_type_mismatch(self) -> None:
        # `isinstance(True, int)` is True in Python — the evaluator
        # MUST guard with `not isinstance(default, bool)` to refuse the
        # bool default for a typed-int setting (spec 072 / FR-009).
        config = _config({"feature.x": {"t": 2, "v": {"i": 7}, "r": []}})
        result = evaluate(config, "feature.x", True)
        assert result.value is True
        assert result.error == "TYPE_MISMATCH"

    def test_int_setting_with_float_default_returns_type_mismatch(self) -> None:
        config = _config({"feature.x": {"t": 2, "v": {"i": 7}, "r": []}})
        result = evaluate(config, "feature.x", 1.5)
        assert result.value == 1.5
        assert result.error == "TYPE_MISMATCH"

    def test_int_setting_with_non_int_i_slot_returns_malformed_value(self) -> None:
        # `"i": "seven"` is a string — refuse with MALFORMED_VALUE.
        config = _config({"feature.x": {"t": 2, "v": {"i": "seven"}, "r": []}})
        result = evaluate(config, "feature.x", -1)
        assert result.value == -1
        assert result.error == "MALFORMED_VALUE"


class TestTypedDouble:
    def test_double_setting_resolves_to_native_float(self) -> None:
        config = _config({"feature.x": {"t": 3, "v": {"d": 0.25}, "i": "var-d", "r": []}})
        result = evaluate(config, "feature.x", 0.0)
        assert result.value == 0.25
        assert isinstance(result.value, float)
        assert result.error is None
        assert result.variation_id == "var-d"

    def test_double_setting_with_string_default_returns_type_mismatch(self) -> None:
        config = _config({"feature.x": {"t": 3, "v": {"d": 0.25}, "r": []}})
        result = evaluate(config, "feature.x", "fallback")
        assert result.value == "fallback"
        assert result.error == "TYPE_MISMATCH"

    def test_double_setting_with_int_default_returns_type_mismatch(self) -> None:
        # Python `isinstance(5, float)` is False — int defaults are
        # refused against double settings.
        config = _config({"feature.x": {"t": 3, "v": {"d": 0.25}, "r": []}})
        result = evaluate(config, "feature.x", 5)
        assert result.value == 5
        assert result.error == "TYPE_MISMATCH"

    def test_double_setting_with_bool_default_returns_type_mismatch(self) -> None:
        config = _config({"feature.x": {"t": 3, "v": {"d": 0.25}, "r": []}})
        result = evaluate(config, "feature.x", True)
        assert result.value is True
        assert result.error == "TYPE_MISMATCH"

    def test_double_setting_missing_d_slot_returns_malformed_value(self) -> None:
        config = _config({"feature.x": {"t": 3, "v": {"s": "0.25"}, "r": []}})
        result = evaluate(config, "feature.x", 0.0)
        assert result.value == 0.0
        assert result.error == "MALFORMED_VALUE"


class TestMalformedInputs:
    def test_none_config_returns_default_with_no_config(self) -> None:
        result = evaluate(None, "anything", True)
        assert result.value is True
        assert result.error == "NO_CONFIG"

    def test_config_missing_f_key_returns_malformed(self) -> None:
        result = evaluate({"p": {}}, "anything", False)
        assert result.value is False
        assert result.error == "MALFORMED_CONFIG"

    def test_setting_with_non_dict_value_slot_returns_malformed(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": "not-a-dict", "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is False
        assert result.error == "MALFORMED_VALUE"

    def test_setting_with_non_bool_b_slot_returns_value_not_bool(self) -> None:
        config = _config({"feature.x": {"t": 0, "v": {"b": "yes"}, "r": []}})
        result = evaluate(config, "feature.x", False)
        assert result.value is False
        assert result.error == "VALUE_NOT_BOOL"
