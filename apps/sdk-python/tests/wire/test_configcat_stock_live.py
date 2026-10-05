# SPDX-License-Identifier: MIT
"""The migration promise, proven with the REAL ConfigCat Python SDK (#802).

"Keep your ConfigCat SDK, change base_url": a stock ``configcat-client``
(``configcatclient``), given a Confeature SDK key and the CDN's address, must
evaluate the flag value Confeature published — not fall back to the default.
Until #802 it could not even be built: ``configcatclient.get`` raises
``Invalid 'sdk_key' value`` for a key that is not ConfigCat-shaped, and the CDN
had no route for the three-segment path such a key produces.

The Python twin of ``apps/sdk-node/tests/wire/configcat-stock.live.test.ts``:
it runs against the live-contract harness (the reference origin of the CDN
read path) and asserts that the harness recorded the request, so it cannot
pass without the SDK having reached the CDN. Run it through the agreed boot::

    node tools/test-harness-live-contract/dist/cli.js --corpus-seed --exec -- \\
      bash -c 'cd apps/sdk-python && \\
        uv run pytest tests/wire/test_configcat_stock_live.py -q'

GATING (fail closed), as ``test_wire_cases_live.py``: skipped only when
``CONFEATURE_LIVE`` is unset — the hermetic run. When it is set without
``LIVE_HARNESS_URL`` the module FAILS at collection; it never skips.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import configcatclient
import httpx
import pytest
from configcatclient.configcatoptions import ConfigCatOptions
from configcatclient.pollingmode import PollingMode

_LIVE = os.environ.get("CONFEATURE_LIVE") == "1"
_HARNESS_URL = os.environ.get("LIVE_HARNESS_URL", "").rstrip("/")

if not _LIVE:
    pytestmark = pytest.mark.skip(reason="hermetic run: CONFEATURE_LIVE is not set")
elif not _HARNESS_URL:
    pytest.fail(
        "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through "
        "`live-contract-harness --corpus-seed --exec -- …`; a live suite must "
        "never pass by skipping",
        pytrace=False,
    )

# tests/wire/<this file> → workspace root is parents[4].
_FIXTURES_DIR = (
    Path(__file__).resolve().parents[4] / "packages" / "test-fixtures-sdk-parity" / "fixtures"
)


def _load(name: str) -> Any:
    return json.loads((_FIXTURES_DIR / name).read_text(encoding="utf-8"))


#: A key in the shape Confeature now mints (``configcat-sdk-1/<22>/<22>``),
#: taken from the one shared list of key shapes — never a local literal.
_KEY: str = next(
    c["key"]
    for c in _load("sdk-key-shapes.json")["valid"]
    if c["key"].startswith("configcat-sdk-1/")
)


@pytest.fixture
def stock_client() -> Iterator[configcatclient.ConfigCatClient]:
    # Building the client is the first thing that failed before #802.
    client = configcatclient.get(
        _KEY,
        ConfigCatOptions(base_url=_HARNESS_URL, polling_mode=PollingMode.manual_poll()),
    )
    try:
        yield client
    finally:
        client.close()


def test_stock_configcat_client_evaluates_the_published_value(
    stock_client: configcatclient.ConfigCatClient,
) -> None:
    seeded = httpx.post(
        f"{_HARNESS_URL}/admin/seed",
        json={"keys": [{"sdkKey": _KEY, "payload": _load("config-v6.boolean.json")}]},
        timeout=10.0,
    )
    assert seeded.status_code == 200, seeded.text

    refresh = stock_client.force_refresh()
    assert refresh.is_success, refresh.error

    # The fixture publishes `feature.dark-mode` = true; the default is False,
    # so a failed fetch cannot pass.
    assert stock_client.get_value("feature.dark-mode", False) is True

    log = httpx.get(f"{_HARNESS_URL}/admin/requests", params={"sdkKey": _KEY}, timeout=10.0)
    log.raise_for_status()
    assert log.json()["requests"], "the harness saw no request from the stock SDK"
