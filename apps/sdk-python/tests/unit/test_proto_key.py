# SPDX-License-Identifier: MIT
"""#826 — a flag keyed ``__proto__`` survives from config_v6 to ``get_value``.

ConfigCat reserves no key names, so the api serves ``__proto__`` as an
ordinary key of ``f``. A JS SDK once dropped it by copying settings into a
plain object; this suite holds the Python SDK to the same contract, for the
served config and for a local override keyed ``__proto__``.
"""

from __future__ import annotations

from pathlib import Path

from pytest_httpx import HTTPXMock

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    ManualPoll,
    MapOverrideDataSource,
    OverrideBehaviour,
)

_SDK_KEY = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"
_BASE = "https://cdn.test.confeature.io"
_SERVED = (
    b'{"p":{"u":"https://cdn.test.confeature.io","r":0,"s":"salt"},'
    b'"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}'
)


def test_a_served_proto_flag_returns_its_served_value(
    httpx_mock: HTTPXMock, tmp_path: Path
) -> None:
    httpx_mock.add_response(content=_SERVED)
    client = ConfeatureClient(
        sdk_key=_SDK_KEY, polling_mode=ManualPoll(), base_url=_BASE, cache_dir=tmp_path
    )
    try:
        client.force_refresh()
        assert client.get_value("__proto__", False) is True
        details = client.get_value_details("__proto__", False)
        assert details.is_default_value is False
        assert details.variation_id == "v-proto"
    finally:
        client.close()


def test_a_local_only_override_keyed_proto_returns_the_override(tmp_path: Path) -> None:
    client = ConfeatureClient(
        sdk_key=_SDK_KEY,
        polling_mode=ManualPoll(),
        cache_dir=tmp_path,
        flag_overrides=FlagOverrides(
            data_source=MapOverrideDataSource({"__proto__": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    )
    try:
        assert client.get_value("__proto__", False) is True
        assert client.get_value("constructor", False) is False
    finally:
        client.close()
