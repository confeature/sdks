# SPDX-License-Identifier: MIT
"""#835 — httpx's per-request INFO line never records the SDK key.

httpx logs ``HTTP Request: GET <url> ...`` at INFO on the ``httpx`` logger,
and the config URL carries the key. With the root logger at INFO, a sync and
an async poll (a redirected one included) must leave no record holding the
key, while the host app's own httpx requests keep their INFO line unchanged.

MUTATION (applied, #835): drop the ``with _httpx_log_guard.sdk_send():``
around either ``get()`` and the matching no-key test goes red.
"""

from __future__ import annotations

import logging
import threading

import httpx
import pytest
from pytest_httpx import HTTPXMock

from confeature_client import _httpx_log_guard
from confeature_client.config_fetcher import ConfigFetcher

from .._key_leak import CapturingLogger, secrets_of

_SDK_KEY = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"
_BASE = "https://cdn.test.confeature.io"
_HOST_URL = "https://host-app.test/orders"
_BODY = {"f": {}}


def _fetcher() -> ConfigFetcher:
    return ConfigFetcher(
        sdk_key=_SDK_KEY,
        version="0.0.0-test",
        logger=CapturingLogger(),
        base_url=_BASE,
        request_timeout_seconds=1.0,
    )


def _leaks(caplog: pytest.LogCaptureFixture) -> list[str]:
    secrets = secrets_of(_SDK_KEY)
    return [r.getMessage() for r in caplog.records if any(s in r.getMessage() for s in secrets)]


def _httpx_info(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage() for r in caplog.records if r.name == "httpx" and r.levelno == logging.INFO
    ]


@pytest.fixture(autouse=True)
def _root_at_info(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)


def test_a_sync_poll_logs_no_record_holding_the_key(
    httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
) -> None:
    httpx_mock.add_response(json=_BODY)
    fetcher = _fetcher()
    assert fetcher.fetch().status == "fetched"
    assert _leaks(caplog) == []
    assert _httpx_info(caplog) == []


async def test_an_async_poll_logs_no_record_holding_the_key(
    httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
) -> None:
    httpx_mock.add_response(json=_BODY)
    fetcher = _fetcher()
    assert (await fetcher.fetch_async()).status == "fetched"
    assert _leaks(caplog) == []
    assert _httpx_info(caplog) == []
    await fetcher.close_async()


def test_every_redirect_hop_of_a_poll_is_silent(
    httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
) -> None:
    fetcher = _fetcher()
    assert fetcher.url is not None
    httpx_mock.add_response(
        url=fetcher.url, status_code=302, headers={"Location": f"{fetcher.url}&hop=2"}
    )
    httpx_mock.add_response(url=f"{fetcher.url}&hop=2", json=_BODY)
    assert fetcher.fetch().status == "fetched"
    assert len(httpx_mock.get_requests()) == 2
    assert _leaks(caplog) == []


def test_the_host_apps_own_httpx_request_logs_as_before(
    httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
) -> None:
    _fetcher()  # the guard is installed
    httpx_mock.add_response(url=_HOST_URL)
    with httpx.Client() as host:
        host.get(_HOST_URL)
    assert _httpx_info(caplog) == [f'HTTP Request: GET {_HOST_URL} "HTTP/1.1 200 OK"']


def test_a_host_request_beside_a_poll_on_another_thread_still_logs(
    httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
) -> None:
    httpx_mock.add_response(url=_HOST_URL, is_reusable=True)
    httpx_mock.add_response(json=_BODY, is_reusable=True)
    fetcher = _fetcher()
    poll = threading.Thread(target=lambda: [fetcher.fetch() for _ in range(20)])
    poll.start()
    with httpx.Client() as host:
        for _ in range(20):
            host.get(_HOST_URL)
    poll.join()
    assert len(_httpx_info(caplog)) == 20
    assert _leaks(caplog) == []


def test_the_guard_is_installed_once_and_changes_nothing_else() -> None:
    target = logging.getLogger("httpx")
    level, handlers, propagate = target.level, list(target.handlers), target.propagate
    _fetcher()
    _fetcher()
    _httpx_log_guard.install()
    guards = [f for f in target.filters if isinstance(f, _httpx_log_guard._DropSdkRequestLine)]
    assert len(guards) == 1
    assert (target.level, target.handlers, target.propagate) == (level, handlers, propagate)
