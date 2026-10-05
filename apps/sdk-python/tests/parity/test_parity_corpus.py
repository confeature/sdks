# SPDX-License-Identifier: MIT
"""Spec 037 US1 parity gate — 58/58 byte-identical to ConfigCat.

Loads the TS-generated parity corpus + canonical configs from
`packages/test-fixtures-sdk-parity/fixtures/`, parametrizes one test
per tuple via `pytest_generate_tests`, and asserts that the Python
`ConfeatureClient` resolves each tuple to its `expected` value.

Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST pass.
If a tuple drifts, STOP and investigate the override-eval / evaluator
code — never mutate the corpus to make the test green.
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


def _make_user(user_dict: dict[str, Any] | None) -> User | None:
    if user_dict is None:
        return None
    return User(
        identifier=user_dict["identifier"],
        email=user_dict.get("email"),
        country=user_dict.get("country"),
        custom=user_dict.get("custom"),
    )


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    """Parametrize `test_parity_tuple` from the JSON corpus.

    Doing this at collection time (rather than via a regular fixture)
    gives the corpus tuples individual test IDs in the report, so a
    drift surfaces by its `description` field.
    """
    if "tuple_data" not in metafunc.fixturenames:
        return

    # apps/sdk-python/tests/parity/test_parity_corpus.py → workspace
    # root is parents[3].parent? No — parents[3] IS the workspace root.
    # parents[0]=parity, [1]=tests, [2]=sdk-python, [3]=apps, [4]=repo.
    # Use the path resolution from conftest.py for consistency.
    workspace_root = Path(__file__).resolve().parents[4]
    corpus_path = (
        workspace_root / "packages" / "test-fixtures-sdk-parity" / "fixtures" / "parity-corpus.json"
    )
    if not corpus_path.exists():
        raise FileNotFoundError(
            f"Parity corpus missing at {corpus_path}. Run "
            "'pnpm run export:corpus' in packages/test-fixtures-sdk-parity/."
        )
    tuples = json.loads(corpus_path.read_text(encoding="utf-8"))
    metafunc.parametrize(
        "tuple_data",
        tuples,
        ids=[t["description"] for t in tuples],
    )


def test_parity_tuple(
    tuple_data: dict[str, Any],
    parity_configs_by_id: dict[str, dict[str, Any]],
) -> None:
    """Resolve one corpus tuple via `ConfeatureClient.get_value`.

    The override map is seeded from the canonical config's
    `overridesMap` (which mirrors the cached `config_v6.json` for v1
    boolean settings). `ManualPoll` + `LOCAL_ONLY` keeps the test
    offline — no daemon thread, no httpx call.
    """
    config_id = tuple_data["configId"]
    config_record = parity_configs_by_id.get(config_id)
    assert config_record is not None, (
        f"Corpus references unknown configId={config_id!r}; "
        "regenerate fixtures via 'pnpm run export:corpus'."
    )

    overrides_map = config_record["overridesMap"]
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
            tuple_data["defaultValue"],
            _make_user(tuple_data.get("user")),
        )
    finally:
        client.close()

    expected = tuple_data["expected"]
    assert actual == expected, (
        f"Parity drift on tuple {tuple_data['description']!r}: "
        f"expected={expected!r} actual={actual!r}. "
        "Constitution Principle II NON-NEGOTIABLE — investigate the "
        "evaluator / override-eval code, do NOT mutate the corpus."
    )
