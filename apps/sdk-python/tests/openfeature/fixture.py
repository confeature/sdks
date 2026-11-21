# SPDX-License-Identifier: MIT
"""Guard real HTTPX transports for the Python tests and installed-wheel probe."""

from collections.abc import Iterator
from contextlib import contextmanager
from os import environ
from re import fullmatch
from threading import Event, Lock
from typing import Any
from unittest.mock import patch

import httpx

TARGETED_FLAG = "stringIsInDogDefaultCat"
REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class FixtureHTTP:
    def __init__(self, origin: str, key: str) -> None:
        if not fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", origin):
            raise ValueError("Expected the bound HTTP loopback fixture origin.")
        self._port = int(origin.rsplit(":", 1)[1])
        if self._port > 65535:
            raise ValueError("Expected the bound HTTP loopback fixture origin.")
        self.origin = origin
        self.key = key
        self._lock = Lock()
        self._count = 0
        self._blocked = 0
        self._pause: tuple[Event, Event] | None = None

    @property
    def count(self) -> int:
        with self._lock:
            return self._count

    @property
    def blocked(self) -> int:
        with self._lock:
            return self._blocked

    @contextmanager
    def pause_next_request(self) -> Iterator[Event]:
        """Keep a native refresh in flight until the async caller can make progress."""
        entered, release = Event(), Event()
        with self._lock:
            self._pause = (entered, release)
        try:
            yield entered
        finally:
            release.set()

    def check_request(self, request: httpx.Request) -> None:
        url = request.url
        with self._lock:
            if (url.scheme, url.host, url.port) != ("http", "127.0.0.1", self._port) or (
                url.username or url.password
            ):
                self._blocked += 1
                raise RuntimeError("Fixture request refused outside the bound origin.")
            if not url.path.startswith("/configuration-files/"):
                return
            self._count += 1
            pause, self._pause = self._pause, None
        if pause is not None:
            entered, release = pause
            entered.set()
            if not release.wait(5):
                raise RuntimeError("Fixture request was not released.")

    def record_redirect(self) -> None:
        with self._lock:
            self._blocked += 1

    def clear_fault(self) -> None:
        self.fault("none")

    def fault(self, fault: str | dict[str, object]) -> None:
        with httpx.Client(timeout=3) as client:
            client.post(
                f"{self.origin}/admin/inject-fault", json={"sdkKey": self.key, "fault": fault}
            ).raise_for_status()

    def served(self) -> int:
        with httpx.Client(timeout=3) as client:
            response = client.get(
                f"{self.origin}/admin/requests", params={"sdkKey": self.key}
            ).raise_for_status()
            return len(response.json()["requests"])


class _SyncLoopback(httpx.HTTPTransport):
    def __init__(self, guard: FixtureHTTP) -> None:
        super().__init__(trust_env=False)
        self._guard = guard

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self._guard.check_request(request)
        response = super().handle_request(request)
        if response.status_code in REDIRECT_STATUSES:
            self._guard.record_redirect()
            response.close()
            raise RuntimeError("Fixture redirect refused.")
        return response


class _AsyncLoopback(httpx.AsyncHTTPTransport):
    def __init__(self, guard: FixtureHTTP) -> None:
        super().__init__(trust_env=False)
        self._guard = guard

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self._guard.check_request(request)
        response = await super().handle_async_request(request)
        if response.status_code in REDIRECT_STATUSES:
            self._guard.record_redirect()
            await response.aclose()
            raise RuntimeError("Fixture redirect refused.")
        return response


@contextmanager
def guarded_http() -> Iterator[FixtureHTTP]:
    if environ.get("CONFEATURE_LIVE") != "1" or not environ.get("OPENFEATURE_PYTHON_FIXTURE_KEY"):
        raise ValueError("Run the Python provider case through its seeded harness.")
    guard = FixtureHTTP(
        environ.get("LIVE_HARNESS_URL", ""), environ["OPENFEATURE_PYTHON_FIXTURE_KEY"]
    )
    sync_init = httpx.Client.__init__
    async_init = httpx.AsyncClient.__init__

    def overrides(kwargs: dict[str, Any]) -> None:
        if any(option in kwargs for option in ("proxy", "mounts", "transport")):
            raise RuntimeError("Fixture transport and proxy overrides are disabled.")
        kwargs.update(trust_env=False, follow_redirects=False)

    def bind_sync(client: httpx.Client, **kwargs: Any) -> None:
        overrides(kwargs)
        sync_init(client, transport=_SyncLoopback(guard), **kwargs)

    def bind_async(client: httpx.AsyncClient, **kwargs: Any) -> None:
        overrides(kwargs)
        async_init(client, transport=_AsyncLoopback(guard), **kwargs)

    with (
        patch.object(httpx.Client, "__init__", bind_sync),
        patch.object(httpx.AsyncClient, "__init__", bind_async),
    ):
        yield guard
