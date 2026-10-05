# SPDX-License-Identifier: MIT
"""Targeting-rule parity (spec 135 / #428, epic #382, US3) — the
``CORPUS_RULES`` corpus injected through the full-config offline override.

Unlike the flat ``parity-corpus`` / ``parity-corpus-typed`` corpora (which
feed a value-only ``overridesMap`` via :class:`MapOverrideDataSource`), the
rule corpus carries the whole ``{p, f, s}`` config and is injected via
:func:`create_flag_overrides_from_config` + ``OverrideBehaviour.LOCAL_ONLY``.
The SDK then resolves targeting rules / segments / % options offline through
the real Python evaluator, exactly as it would against a CDN-served config —
no network round-trip.

Runner contract (mirrors ``apps/sdk-node/tests/parity/parity-rules.test.ts``):
every tuple branches on the config's ``injectionMode``:
  - ``"full-config"`` → capability-probe :func:`create_flag_overrides_from_config`.
    If sdk-python exposes it, build the override and assert the PUBLIC
    ``client.get_value`` returns ``tuple.expected``. If it does NOT, SKIP with a
    reason — NEVER fall back to the flat-map path (SC-004: no ``"full-config"``
    tuple is ever resolved on the map path, and a skip is reported with its
    reason).

sdk-python HAS adopted the full-config path, so every runnable rule tuple
resolves through the real evaluator (no SC-004 skips for missing full-config
support).

Typed attribute CONVERSION (spec 151 / #468, US2): the corpus also carries
attribute-conversion tuples whose ``user.custom`` value is a TYPED value
(number / ``{"$date": epoch-seconds}`` → ``datetime`` / ``string[]``). This
runner decodes the typed-attribute encoding (number→int/float, list→list,
``{"$date":n}``→UTC ``datetime`` from epoch seconds,
``{"$num":"NaN"|"Infinity"|"-Infinity"}``→non-finite ``float`` (#479), str→str)
and builds a typed :class:`~confeature_client.user.User`. All 16 attribute
conversions resolve through the evaluator — including the 6 NaN/±Infinity cases,
which the ``{"$num"}`` tag now carries losslessly (the evaluator renders
``NaN``/``Infinity``/``-Infinity`` from the real float). Never a silent pass /
corpus mutation (AC4).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

import confeature_client
from confeature_client import (
    ConfeatureClient,
    ManualPoll,
    OverrideBehaviour,
    User,
    create_flag_overrides_from_config,
)

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

# Capability probe: does this SDK expose the full-config override factory?
# The full-config path is gated on this — never silently resolved on the
# flat-map path (SC-004 / AC4 of #428).
_HAS_FULL_CONFIG_OVERRIDES = callable(
    getattr(confeature_client, "create_flag_overrides_from_config", None)
)

# apps/sdk-python/tests/parity/test_parity_rules.py → workspace root is
# parents[4] (same resolution the existing rule-less runner uses).
_WORKSPACE_ROOT = Path(__file__).resolve().parents[4]
_FIXTURES_DIR = _WORKSPACE_ROOT / "packages" / "test-fixtures-sdk-parity" / "fixtures"


def _load_json(name: str) -> Any:
    path = _FIXTURES_DIR / name
    if not path.exists():
        raise FileNotFoundError(
            f"Parity fixtures JSON missing at {path}. Run "
            "'pnpm run export:corpus' in packages/test-fixtures-sdk-parity/."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _decode_custom_value(value: Any) -> Any:
    """Decode one typed-attribute-encoded ``user.custom`` value (spec 151 / #468).

    The JSON corpus encodes a ``user.custom`` value by its NATURAL JSON type
    (string→str, number→int/float, bool→bool, string[]→list) with two tagged
    exceptions: a ``Date`` is ``{"$date": <unix-epoch-seconds>}`` (rehydrated to
    a timezone-aware UTC :class:`datetime`, the inverse of the exporter's
    ``getTime() / 1000``); a non-finite number is
    ``{"$num": "NaN" | "Infinity" | "-Infinity"}`` (#479 — JSON cannot represent
    these, rehydrated to the matching Python ``float``). Every other shape
    passes through to the typed Python ``User.custom`` verbatim.
    """
    if isinstance(value, dict) and set(value) == {"$date"}:
        return datetime.fromtimestamp(value["$date"], tz=timezone.utc)
    if isinstance(value, dict) and set(value) == {"$num"}:
        return {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}[
            value["$num"]
        ]
    return value


def _decode_custom(custom: dict[str, Any] | None) -> dict[str, Any] | None:
    """Rehydrate a ``user.custom`` map from the typed-attribute encoding.

    A ``None`` value (a JSON ``null`` custom attribute) is read as ABSENT —
    defensive only; no corpus tuple currently encodes one (non-finite numbers
    now ride the lossless ``{"$num"}`` tag, #479, not a lossy ``null``).
    """
    if custom is None:
        return None
    decoded: dict[str, Any] = {}
    for key, raw in custom.items():
        if raw is None:
            continue
        decoded[key] = _decode_custom_value(raw)
    return decoded


# config_v6 setting-type tag for a DOUBLE (decimal) flag (``setting["t"]``).
_SETTING_TYPE_DOUBLE = 3


def _default_value_for(tuple_data: dict[str, Any], config: dict[str, Any]) -> Any:
    """Type the corpus ``defaultValue`` to the flag's declared numeric kind.

    The corpus encodes ``defaultValue`` in its natural JSON type; for the
    ``decimal`` (DOUBLE) flag that is the JSON int ``-1``. configcat-python —
    like Confeature's port — STRICTLY type-checks the default against the
    setting type (``isinstance(default, float)`` for a DOUBLE setting; an
    ``int`` default returns ``TYPE_MISMATCH``, matching upstream). JS has only
    ``number`` so the corpus default is int-shaped; Python's int/float split
    means a DOUBLE flag needs a ``float`` default to resolve cleanly.

    We read the flag's declared type from the config (``setting["t"] == 3``,
    DOUBLE) — NOT from ``expected``'s Python type, since a whole-numbered
    decimal (e.g. ``0`` / ``1``) parses from JSON as a Python ``int`` and would
    be misread as a non-DOUBLE flag. For a DOUBLE flag we widen a numeric
    ``defaultValue`` to ``float`` (bool checked first — ``isinstance(True, int)``
    is True — so a boolean default is never coerced). This is a default-TYPING
    fix, not a value/comparison weakening: the resolved value is still asserted
    ``==`` against the corpus ``expected`` numerically.
    """
    default = tuple_data["defaultValue"]
    settings = config.get("f")
    setting = settings.get(tuple_data["key"]) if isinstance(settings, dict) else None
    setting_type = setting.get("t") if isinstance(setting, dict) else None
    if (
        setting_type == _SETTING_TYPE_DOUBLE
        and isinstance(default, int)
        and not isinstance(default, bool)
    ):
        return float(default)
    return default


def _make_user(user_dict: dict[str, Any] | None) -> User | None:
    if user_dict is None:
        return None
    return User(
        identifier=user_dict["identifier"],
        email=user_dict.get("email"),
        country=user_dict.get("country"),
        custom=_decode_custom(user_dict.get("custom")),
    )


def _configs_by_id() -> dict[str, dict[str, Any]]:
    configs = _load_json("parity-configs-rules.json")
    assert isinstance(configs, list), "parity-configs-rules.json must be a JSON array"
    return {cfg["id"]: cfg for cfg in configs}


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    """Parametrize ``test_parity_rules_tuple`` from the rules corpus."""
    if "tuple_data" not in metafunc.fixturenames:
        return
    tuples = _load_json("parity-corpus-rules.json")
    assert isinstance(tuples, list), "parity-corpus-rules.json must be a JSON array"
    metafunc.parametrize(
        "tuple_data",
        tuples,
        ids=[t["description"] for t in tuples],
    )


def test_parity_rules_tuple(tuple_data: dict[str, Any]) -> None:
    """Resolve one rule corpus tuple via the PUBLIC ``get_value``.

    Branches on the config's ``injectionMode``:
      - ``"full-config"`` → IF sdk-python exposes the full-config factory,
        build the override + assert ``get_value`` resolves the targeting rule;
        ELSE skip-with-reason (never fall back to the flat map path — SC-004).
    """
    configs = _configs_by_id()
    config_id = tuple_data["configId"]
    config_record = configs.get(config_id)
    assert config_record is not None, (
        f"Rule corpus references unknown configId={config_id!r}; "
        "regenerate fixtures via 'pnpm run export:corpus'."
    )

    injection_mode = config_record["injectionMode"]
    # The rule corpus is full-config only; a flat-map tuple here would mean a
    # corpus regression, never a silent flat-map fallback (SC-004).
    assert injection_mode == "full-config", (
        f"Rule corpus tuple {tuple_data['description']!r} has unexpected "
        f"injectionMode={injection_mode!r}; expected 'full-config'."
    )

    if not _HAS_FULL_CONFIG_OVERRIDES:
        # SC-004: NEVER fall back to the flat-map path — skip with a reason.
        pytest.skip("SDK has not adopted full-config overrides")

    user = _make_user(tuple_data.get("user"))
    default_value = _default_value_for(tuple_data, config_record["config"])
    client = ConfeatureClient(
        sdk_key=_SDK_KEY,
        polling_mode=ManualPoll(),
        flag_overrides=create_flag_overrides_from_config(
            config_record["config"],
            OverrideBehaviour.LOCAL_ONLY,
        ),
    )
    # When the tuple carries an `expectedVariationId` (spec 152 / #475, US2),
    # resolve through the PUBLIC `get_value_details` so the same call yields
    # BOTH the value and the `.variation_id` identity — then assert both. The
    # config drives the full-config override path, so `variation_id` must
    # survive the override→details router (#395 gap class).
    expected_variation_id = tuple_data.get("expectedVariationId")
    try:
        if expected_variation_id is not None:
            details = client.get_value_details(
                tuple_data["key"],
                default_value,
                user,
            )
            actual = details.value
            actual_variation_id = details.variation_id
        else:
            actual = client.get_value(
                tuple_data["key"],
                default_value,
                user,
            )
            actual_variation_id = None
    finally:
        client.close()

    expected = tuple_data["expected"]
    # Numeric values (incl. the decimal tuples: int 0 vs float 0.0 and the
    # precision floats) compare numerically — Python `==` on int/float already
    # does so; this path never stringifies either side.
    assert actual == expected, (
        f"Targeting-rule parity drift on tuple {tuple_data['description']!r}: "
        f"expected={expected!r} actual={actual!r}. "
        "Constitution Principle II NON-NEGOTIABLE — investigate the evaluator / "
        "override router, do NOT mutate the corpus. If this is a real Python "
        "targeting-rule engine gap (not an override-wiring bug), STOP and file a "
        "discrete #382 follow-up — never a corpus or test workaround (AC4)."
    )

    if expected_variation_id is not None:
        assert actual_variation_id == expected_variation_id, (
            f"variationId parity drift on tuple {tuple_data['description']!r}: "
            f"expected={expected_variation_id!r} actual={actual_variation_id!r}. "
            "Constitution Principle II NON-NEGOTIABLE — the PUBLIC "
            "get_value_details must surface the served variationId through the "
            "full-config override path. Investigate the override→details router "
            "(#395 gap class), do NOT mutate the corpus."
        )


def test_full_config_factory_is_exposed() -> None:
    """The full-config override factory is exposed on this SDK (no skips)."""
    assert _HAS_FULL_CONFIG_OVERRIDES, (
        "create_flag_overrides_from_config must be exposed; sdk-python has "
        "adopted the full-config override path (#428)."
    )
