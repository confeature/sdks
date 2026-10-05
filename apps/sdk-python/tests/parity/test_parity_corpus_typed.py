# SPDX-License-Identifier: MIT
"""Spec 072 US2 typed-parity gate — 13/13 byte-identical to ConfigCat.

Sibling to `test_parity_corpus.py`. Loads the 13-tuple typed corpus
+ the typed configs from `packages/test-fixtures-sdk-parity/fixtures/`,
parametrizes one test per tuple via `pytest_generate_tests`, and
asserts that the widened Python evaluator resolves each tuple to its
`expected` value.

The corpus encodes default and expected values via JSON so a `double`
setting's default arrives as `int(1)` when the source JSON says `1`.
The driver normalises default + expected + the override map to the
native Python type implied by each setting's `t` discriminator
(`float` for `t=3`, `int` for `t=2`), mirroring sdk-go's typed driver
(spec 071).

Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST pass.
If a tuple drifts, STOP and investigate the evaluator code — never
mutate the corpus to make the test green.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    ManualPoll,
    MapOverrideDataSource,
    OverrideBehaviour,
    User,
)

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

# Setting-type discriminators (mirror evaluator._SETTING_TYPE_*).
_SETTING_TYPE_INT = 2
_SETTING_TYPE_DOUBLE = 3


def _make_user(user_dict: dict[str, Any] | None) -> User | None:
    if user_dict is None:
        return None
    return User(
        identifier=user_dict["identifier"],
        email=user_dict.get("email"),
        country=user_dict.get("country"),
        custom=user_dict.get("custom"),
    )


def _setting_types_by_key(config_record: dict[str, Any]) -> dict[str, int]:
    """Extract the per-key `t` discriminator from a typed config blob."""
    out: dict[str, int] = {}
    settings = config_record.get("config", {}).get("f")
    if not isinstance(settings, dict):
        return out
    for key, setting in settings.items():
        if isinstance(setting, dict):
            t = setting.get("t")
            if isinstance(t, int) and not isinstance(t, bool):
                out[key] = t
    return out


def _normalise_for_setting_type(value: Any, setting_type: int) -> Any:
    """Rehydrate a JSON-decoded primitive against the per-key SettingType.

    JSON has one numeric type; Python's strict evaluator distinguishes
    `int` (`t=2`) and `float` (`t=3`). The corpus's source-of-truth is
    each setting's discriminator — we cast accordingly. Bools, strings,
    and other shapes pass through untouched so TYPE_MISMATCH tuples
    still surface the mismatch through the evaluator.
    """
    # `isinstance(True, int)` is True — preserve bools as-is.
    if isinstance(value, bool):
        return value
    if setting_type == _SETTING_TYPE_INT:
        if isinstance(value, float):
            return int(value)
        return value
    if setting_type == _SETTING_TYPE_DOUBLE:
        if isinstance(value, int):
            return float(value)
        return value
    return value


def _normalise_overrides(
    overrides: dict[str, Any],
    setting_types: dict[str, int],
) -> dict[str, Any]:
    """Cast each override value to the native type implied by `t`."""
    out: dict[str, Any] = {}
    for key, value in overrides.items():
        st = setting_types.get(key)
        if st is None:
            out[key] = value
        else:
            out[key] = _normalise_for_setting_type(value, st)
    return out


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    """Parametrize `test_parity_tuple_typed` from the typed JSON corpus."""
    if "tuple_data" not in metafunc.fixturenames:
        return

    workspace_root = Path(__file__).resolve().parents[4]
    corpus_path = (
        workspace_root
        / "packages"
        / "test-fixtures-sdk-parity"
        / "fixtures"
        / "parity-corpus-typed.json"
    )
    if not corpus_path.exists():
        raise FileNotFoundError(
            f"Typed parity corpus missing at {corpus_path}. Run "
            "'pnpm run export:corpus' in packages/test-fixtures-sdk-parity/."
        )
    tuples = json.loads(corpus_path.read_text(encoding="utf-8"))
    metafunc.parametrize(
        "tuple_data",
        tuples,
        ids=[t["description"] for t in tuples],
    )


def test_typed_corpus_has_thirteen_tuples(
    parity_corpus_typed: list[dict[str, Any]],
) -> None:
    """Sentinel guard — the spec 072 typed corpus is exactly 13 tuples."""
    assert len(parity_corpus_typed) == 13, (
        f"Expected 13 typed corpus tuples, got {len(parity_corpus_typed)} — "
        "regenerate via 'pnpm run export:corpus' in "
        "packages/test-fixtures-sdk-parity/."
    )


def test_parity_tuple_typed(
    tuple_data: dict[str, Any],
    parity_configs_typed_by_id: dict[str, dict[str, Any]],
) -> None:
    """Resolve one typed corpus tuple via `ConfeatureClient.get_value`.

    The override map is normalised to the per-key setting type so that
    `feature.zero-threshold: 0` (loaded as `int(0)` from JSON) lands in
    the `d` slot rather than the `i` slot — mirroring the cached
    `config_v6.json` semantics.
    """
    config_id = tuple_data["configId"]
    config_record = parity_configs_typed_by_id.get(config_id)
    assert config_record is not None, (
        f"Typed corpus references unknown configId={config_id!r}; "
        "regenerate fixtures via 'pnpm run export:corpus'."
    )

    setting_types = _setting_types_by_key(config_record)
    overrides_map = _normalise_overrides(config_record["overridesMap"], setting_types)

    default_value: Any = tuple_data["defaultValue"]
    expected: Any = tuple_data["expected"]
    setting_type = setting_types.get(tuple_data["key"])
    if setting_type is not None:
        default_value = _normalise_for_setting_type(default_value, setting_type)
        expected = _normalise_for_setting_type(expected, setting_type)

    client = ConfeatureClient(
        sdk_key=_SDK_KEY,
        polling_mode=ManualPoll(),
        flag_overrides=FlagOverrides(
            data_source=MapOverrideDataSource(overrides_map),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    )
    try:
        actual = client.get_value(
            tuple_data["key"],
            default_value,
            _make_user(tuple_data.get("user")),
        )
    finally:
        client.close()

    assert actual == expected, (
        f"Typed parity drift on tuple {tuple_data['description']!r}: "
        f"expected={expected!r} ({type(expected).__name__}) "
        f"actual={actual!r} ({type(actual).__name__}). "
        "Constitution Principle II NON-NEGOTIABLE — investigate the "
        "evaluator / override-eval code, do NOT mutate the corpus."
    )
    # Type-strict guard — `5 == 5.0` is True in Python, but a regression
    # that flips int↔float would still slip through `==`. Enforce
    # exact-type equality for the typed tier (the boolean tier uses `==`
    # for backwards compatibility).
    assert type(actual) is type(expected), (
        f"Typed parity TYPE drift on {tuple_data['description']!r}: "
        f"expected type={type(expected).__name__} "
        f"actual type={type(actual).__name__}."
    )
