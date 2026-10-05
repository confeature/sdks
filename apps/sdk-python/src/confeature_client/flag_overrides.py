# SPDX-License-Identifier: MIT
"""Flag-override data sources, behaviour enum, and the production map source.

Mirrors `configcat-client` 1:1 (Principle II) and the spec-036 design:
`LOCAL_ONLY` is wired through; `LOCAL_OVER_REMOTE` and `REMOTE_OVER_LOCAL`
are accepted at the type level but raise `NotImplementedError` at
runtime (spec 031 §R8 deferral).
"""

from __future__ import annotations

import dataclasses
import enum
from typing import Any, Protocol, runtime_checkable


class OverrideBehaviour(enum.Enum):
    """How flag overrides interact with the remote config.

    - `LOCAL_ONLY`: only overrides are consulted; remote config is
      ignored entirely. This is the only mode wired in v1.
    - `LOCAL_OVER_REMOTE`: overrides shadow the remote config, falling
      back when a key is absent in the override map. Deferred —
      raises NotImplementedError at eval time.
    - `REMOTE_OVER_LOCAL`: remote config wins; overrides are consulted
      only when the remote config lacks the key. Deferred — raises
      NotImplementedError at eval time.
    """

    LOCAL_ONLY = "local_only"
    LOCAL_OVER_REMOTE = "local_over_remote"
    REMOTE_OVER_LOCAL = "remote_over_local"


@dataclasses.dataclass(frozen=True)
class ISettingValue:
    """One slot of a `config_v6.json` setting value record.

    Exactly one of `b`, `s`, `i`, `d` is non-None for a valid setting.
    The evaluator picks the first non-None field.
    """

    b: bool | None = None
    s: str | None = None
    i: int | None = None
    d: float | None = None


@runtime_checkable
class IOverrideDataSource(Protocol):
    """Override-data-source protocol.

    `get_overrides_sync` is the load-bearing method for snapshot()
    evaluations; a customer implementation that only supplies the async
    flavour falls back gracefully (the override-eval helper treats a
    missing sync method as "no sync data" and returns None).
    """

    def get_overrides_sync(self) -> dict[str, ISettingValue] | None:
        """Synchronous read. None → caller falls through to async path."""
        ...

    async def get_overrides(self) -> dict[str, ISettingValue] | None:
        """Async read. Awaited by the async getValue path."""
        ...


def _to_setting_value(value: bool | str | int | float) -> ISettingValue:
    """Map a primitive override value to its ISettingValue slot.

    Note `bool` is checked before `int` because Python's `bool` is a
    subclass of `int` — without the order, every `True`/`False` would
    land in the `i` slot and break the type-mismatch contract.
    """
    if isinstance(value, bool):
        return ISettingValue(b=value)
    if isinstance(value, int):
        return ISettingValue(i=value)
    if isinstance(value, float):
        return ISettingValue(d=value)
    if isinstance(value, str):
        return ISettingValue(s=value)
    raise TypeError(
        f"Unsupported override value type: {type(value).__name__}. "
        "Supported types are bool, str, int, float."
    )


class MapOverrideDataSource:
    """In-memory dict-backed override source — the production-default.

    Converts each primitive value to an `ISettingValue` slot once at
    construction time and returns the same map on every call (stable
    identity, which the override-eval helper relies on for cheap
    short-circuit checks).
    """

    def __init__(self, overrides: dict[str, bool | str | int | float]) -> None:
        self._map: dict[str, ISettingValue] = {
            key: _to_setting_value(value) for key, value in overrides.items()
        }

    def get_overrides_sync(self) -> dict[str, ISettingValue]:
        return self._map

    async def get_overrides(self) -> dict[str, ISettingValue]:
        return self._map


class ConfigOverrideDataSource:
    """Full-config override source — holds a complete parsed ``config_v6``
    blob (``{p, f, s}``) and routes through the real evaluator offline.

    Spec 135 / #428 (epic #382, US3): the rule-bearing sibling of
    :class:`MapOverrideDataSource`. Where the map source emits value-only
    settings, this source retains the WHOLE ``{p, f, s}`` config — salt
    (``p.s``) + segments (``s``) + rule-bearing settings (``f``) — so the
    Python evaluator can resolve targeting rules / segments / prerequisites
    / percentage options purely from the supplied config, no network fetch.

    Additive extension (Principle II): ConfigCat's official Python SDK only
    exposes a *file-based* full-config override (``LocalFileFlagOverrides``).
    This in-memory form is the runtime-agnostic equivalent, mirroring the JS
    federation's ``ConfigOverrideDataSource`` / ``createFlagOverridesFromConfig``.

    The whole config dict is retained (never just ``f``) — the spec-129
    dropped-salt regression guard (INV-4): percentage bucketing reads ``p.s``
    and segment conditions read ``s``.

    Note this source intentionally does NOT satisfy the value-only
    :class:`IOverrideDataSource` ``get_overrides_sync`` contract (its settings
    are rule-bearing, not flat ``ISettingValue`` envelopes). The override
    router (:func:`override_eval.evaluate_override`) dispatches on the source
    TYPE — a ``ConfigOverrideDataSource`` always routes through the evaluator,
    never the flat-map path — so it is never mis-read as value-only.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config

    @property
    def config(self) -> dict[str, Any]:
        """The full parsed ``config_v6`` blob (``{p, f, s}``)."""
        return self._config

    def get_overrides_sync(self) -> dict[str, Any]:
        """Returns the rule-bearing settings map (``f``), rules intact.

        Exposed so ``get_all_keys`` / ``get_all_values`` can enumerate the
        override's flag keys. Resolution itself never goes through this map —
        the router evaluates the full config through the real evaluator.
        """
        settings = self._config.get("f")
        return settings if isinstance(settings, dict) else {}

    async def get_overrides(self) -> dict[str, Any]:
        return self.get_overrides_sync()


@dataclasses.dataclass(frozen=True)
class FlagOverrides:
    """(data_source, behaviour) pair passed via the client constructor."""

    data_source: IOverrideDataSource
    behaviour: OverrideBehaviour


def create_flag_overrides_from_config(
    config: dict[str, Any],
    behaviour: OverrideBehaviour,
) -> FlagOverrides:
    """Build a :class:`FlagOverrides` from a full ``config_v6`` blob.

    The in-memory, rule-bearing offline-override factory (spec 135 / #428).
    With :attr:`OverrideBehaviour.LOCAL_ONLY`, ``get_value(key, default, user)``
    resolves targeting rules / segments / prerequisites / percentage options
    purely from ``config`` through the real evaluator — no network fetch.

    Additive (Principle II): mirrors the JS federation's
    ``createFlagOverridesFromConfig``. ConfigCat's official Python SDK exposes
    the value-only ``LocalDictionaryFlagOverrides`` + the file-based
    ``LocalFileFlagOverrides``; this is the in-memory full-config equivalent,
    so a customer can drive the full rule engine from a config blob already
    resident in memory (the corpus / test-harness use case) on any runtime.
    """
    return FlagOverrides(
        data_source=ConfigOverrideDataSource(config),
        behaviour=behaviour,
    )
