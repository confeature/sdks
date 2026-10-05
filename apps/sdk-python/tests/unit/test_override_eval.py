# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.override_eval` — the 7-branch tree.

Each branch of the tree has at least one dedicated test case. The tree
mirrors `packages/sdk-shared/src/override-eval.ts` 1:1.

Branches:
  1. flag_overrides is None → return None (caller falls through).
  2. behaviour is not LocalOnly → return None.
  3. data source has no callable get_overrides_sync → return None.
     3b. get_overrides_sync returns None → return None.
  4. key absent from override map → return default_value.
  5. override slot is empty (ISettingValue with all-None fields) → return default_value.
  6. primitive type of override diverges from type(default_value) → return default_value.
  7. happy path — typed override value.
"""

from __future__ import annotations

from typing import Any

from confeature_client.flag_overrides import (
    FlagOverrides,
    ISettingValue,
    MapOverrideDataSource,
    OverrideBehaviour,
)
from confeature_client.override_eval import evaluate_override_sync


class _NoSyncSource:
    """Override data source that intentionally lacks get_overrides_sync."""

    async def get_overrides(self) -> dict[str, ISettingValue] | None:
        return {}


class _SyncReturnsNoneSource:
    def get_overrides_sync(self) -> dict[str, ISettingValue] | None:
        return None

    async def get_overrides(self) -> dict[str, ISettingValue] | None:
        return None


class _ExplicitSource:
    """Data source backed by a dict the test owns directly."""

    def __init__(self, overrides: dict[str, ISettingValue]) -> None:
        self._overrides = overrides

    def get_overrides_sync(self) -> dict[str, ISettingValue]:
        return self._overrides

    async def get_overrides(self) -> dict[str, ISettingValue]:
        return self._overrides


class TestBranch1NoOverrides:
    def test_returns_none(self) -> None:
        # flag_overrides=None → branch 1 → None.
        assert evaluate_override_sync(None, "any-key", False) is None


class TestBranch2NonLocalOnly:
    def test_local_over_remote_returns_none(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": True}),
            behaviour=OverrideBehaviour.LOCAL_OVER_REMOTE,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is None

    def test_remote_over_local_returns_none(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": True}),
            behaviour=OverrideBehaviour.REMOTE_OVER_LOCAL,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is None


class TestBranch3MissingSyncSource:
    def test_no_sync_method_returns_none(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=_NoSyncSource(),  # type: ignore[arg-type]
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is None

    def test_sync_returning_none_returns_none(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=_SyncReturnsNoneSource(),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is None


class TestBranch4KeyAbsent:
    def test_returns_default(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"present": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        # LocalOnly contract: don't fall through. Caller gets default.
        assert evaluate_override_sync(flag_overrides, "absent", False) is False
        assert evaluate_override_sync(flag_overrides, "absent", True) is True


class TestBranch5EmptyOverrideSlot:
    def test_all_none_slot_returns_default(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=_ExplicitSource({"k": ISettingValue()}),  # type: ignore[arg-type]
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        # Branch 5: every primitive field is None → default wins.
        assert evaluate_override_sync(flag_overrides, "k", False) is False


class TestBranch6TypeMismatch:
    def test_int_override_against_bool_default(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=_ExplicitSource({"k": ISettingValue(i=42)}),  # type: ignore[arg-type]
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        # default is bool; candidate is int → TYPE_MISMATCH → default.
        assert evaluate_override_sync(flag_overrides, "k", False) is False

    def test_str_override_against_bool_default(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=_ExplicitSource({"k": ISettingValue(s="yes")}),  # type: ignore[arg-type]
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is False

    def test_none_default_bypasses_type_check(self) -> None:
        # When default is None, the type check is intentionally skipped
        # (matches configcat-js's `defaultValue !== null` short-circuit).
        flag_overrides = FlagOverrides(
            data_source=_ExplicitSource({"k": ISettingValue(s="hello")}),  # type: ignore[arg-type]
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        # None default → the type check is bypassed and we return the
        # raw candidate.
        default_value: Any = None
        result = evaluate_override_sync(flag_overrides, "k", default_value)
        assert result == "hello"


class TestBranch7HappyPath:
    def test_boolean_override_returns_value(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", False) is True

    def test_string_override_returns_value(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": "hello"}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", "fallback") == "hello"

    def test_int_override_with_int_default_returns_value(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": 7}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", 0) == 7

    def test_float_override_with_float_default_returns_value(self) -> None:
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": 1.5}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", 0.0) == 1.5

    def test_bool_false_returned_not_treated_as_missing(self) -> None:
        # Regression guard: a False override MUST be returned, not
        # treated as a falsy "missing" sentinel.
        flag_overrides = FlagOverrides(
            data_source=MapOverrideDataSource({"k": False}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        )
        assert evaluate_override_sync(flag_overrides, "k", True) is False
