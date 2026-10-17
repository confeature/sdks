# SPDX-License-Identifier: MIT
"""sdk-python live wire-cases (#783).

sdk-python's own ``ConfigFetcher`` — its real httpx stack — against a RUNNING
live-contract harness serving the reference origin of the CDN read path.
Every seeded wire-case is replayed and judged by ``assert_wire_case``, the
SAME function the hermetic suite (``test_wire_cases.py``) applies to a
mocked transport.
Nothing is hand-built here and no admin write is made:

- the case set comes from the running harness (``GET /admin/state`` →
  ``keys``), never recomputed from the corpus and the seeds directory;
- the request each case sent is read back from the harness
  (``GET /admin/requests``), so ``If-None-Match`` is asserted on the wire,
  and each fetch must add exactly one entry to that log;
- US4: one unseeded key reaches the Worker's OWN unknown-key answer
  (ConfigCat's 403 since #785) — the one path the corpus seeds shield.

Run it through the harness wrapper, the one agreed boot::

    node tools/test-harness-live-contract/dist/cli.js --corpus-seed \\
      --exec -- uv run pytest tests/wire/test_wire_cases_live.py

GATING (fail closed): skipped only when ``CONFEATURE_LIVE`` is unset — the
hermetic run. When it is set without a reachable ``LIVE_HARNESS_URL`` the
module FAILS at collection; it never skips.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
import pytest

from confeature_client.config_fetcher import ConfigFetcher

from ._wire_case_assertions import (
    CapturedRequest,
    SilentLogger,
    assert_wire_case,
    load_corpus,
    mark_for,
    python_error_to_class,
)

_SDK_VERSION = "0.0.0-live-wire"
_LIVE = os.environ.get("CONFEATURE_LIVE") == "1"
_HARNESS_URL = os.environ.get("LIVE_HARNESS_URL", "").rstrip("/")

if not _LIVE:
    pytestmark = pytest.mark.skip(reason="hermetic run: CONFEATURE_LIVE is not set")
    _STATE: dict[str, Any] = {"keys": [], "faults": {}}
elif not _HARNESS_URL:
    pytest.fail(
        "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through "
        "`live-contract-harness --corpus-seed --exec -- …`; a live suite must "
        "never pass by skipping",
        pytrace=False,
    )
else:
    _state_response = httpx.get(f"{_HARNESS_URL}/admin/state", timeout=10.0)
    _state_response.raise_for_status()
    _STATE = _state_response.json()

_CORPUS = {case["id"]: case for case in load_corpus()}
_CASE_IDS: list[str] = sorted(_STATE["keys"])


def _fetcher(sdk_key: str, timeout_seconds: float = 10.0) -> ConfigFetcher:
    return ConfigFetcher(
        sdk_key=sdk_key,
        version=_SDK_VERSION,
        logger=SilentLogger(),
        base_url=_HARNESS_URL,
        request_timeout_seconds=timeout_seconds,
    )


def _requests_for(sdk_key: str) -> list[dict[str, Any]]:
    response = httpx.get(f"{_HARNESS_URL}/admin/requests", params={"sdkKey": sdk_key}, timeout=10.0)
    response.raise_for_status()
    return response.json()["requests"]


def test_the_harness_serves_a_non_empty_seeded_set() -> None:
    assert _CASE_IDS, "the harness reports no seeded case — an empty run checks nothing"
    unknown = [case_id for case_id in _CASE_IDS if case_id not in _CORPUS]
    assert not unknown, f"seeded keys missing from the corpus: {unknown}"


@pytest.mark.parametrize(
    "case_id", [pytest.param(case_id, marks=mark_for(case_id)) for case_id in _CASE_IDS]
)
def test_live_wire_case(case_id: str) -> None:
    case = _CORPUS[case_id]
    timeout_seconds = 10.0
    hold_ms: float | None = None
    if case["server"].get("behavior") == "timeout":
        # The SDK's deadline is derived from the harness's hold (#783 A8).
        fault = _STATE["faults"].get(case_id, {})
        hold_ms = fault.get("ms") if isinstance(fault, dict) else None
        assert hold_ms, f"{case_id} is seeded without a timeout fault"
        timeout_seconds = hold_ms / 4 / 1000

    before = len(_requests_for(case_id))
    started = time.monotonic()
    fetcher = _fetcher(case_id, timeout_seconds)
    try:
        result = fetcher.fetch(etag=case["given"]["previousEtag"])
    finally:
        fetcher.close()
    elapsed_ms = (time.monotonic() - started) * 1000

    log = _requests_for(case_id)
    # Exactly one request per fetch: a retrying SDK, or a request logged by an
    # earlier run, must not stand in for the one under test.
    assert len(log) - before == 1, f"{case_id}: one fetch sent {len(log) - before} requests"
    if hold_ms is not None:
        # The SDK's own deadline ended the fetch, not the harness releasing it.
        assert elapsed_ms < hold_ms, f"{case_id}: took {elapsed_ms:.0f} ms, hold is {hold_ms} ms"
    last = log[-1]
    assert_wire_case(
        case,
        result,
        CapturedRequest(url=last["url"], if_none_match=last["ifNoneMatch"]),
        case_id,
        _SDK_VERSION,
    )


def test_unseeded_key_reaches_the_worker_and_reports_invalid_sdk_key() -> None:
    """US4: no seed, no fault — the CDN's own unknown-key answer, which is
    ConfigCat's 403 since #785, classed like a 404 as ``invalidSdkKey``."""
    fetcher = _fetcher("never-seeded-783")
    try:
        result = fetcher.fetch()
    finally:
        fetcher.close()
    assert result.status == "failed"
    assert python_error_to_class(result.error) == "invalidSdkKey", result.error


# PROOF (#918, FR-013): a deliberately wrong live expectation. This pull request is closed unmerged.
def test_proof_918() -> None:
    assert os.environ.get("LIVE_HARNESS_URL", "") == "proof/918"
