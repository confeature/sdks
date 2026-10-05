# SPDX-License-Identifier: MIT
"""Polling strategies: AutoPoll (daemon thread), LazyLoad, ManualPoll.

Lifecycle:
  - constructor accepts a `fetch_callback: Callable[[], FetchResult]`
    bound to the client's ConfigFetcher.
  - `start()` is idempotent. AutoPollService spawns its daemon thread
    here. LazyLoad / ManualPoll record the callback but spawn nothing.
  - `force_refresh()` invokes the callback synchronously and returns
    a `RefreshResult`.
  - `force_refresh_async()` wraps the synchronous fetch in
    `asyncio.to_thread`.
  - `stop(timeout=5.0)` signals the event and joins the thread (no-op
    for non-AutoPoll modes).

Per research §R5: one concurrency model per polling mode. AutoPoll uses
`threading.Thread(daemon=True)` + `threading.Event` so process shutdown
never hangs on a poll-thread join.
"""

from __future__ import annotations

import abc
import asyncio
import dataclasses
import threading
import time
from collections.abc import Callable

from .config_fetcher import FetchResult


@dataclasses.dataclass(frozen=True)
class RefreshResult:
    """Outcome of a `force_refresh[_async]` call."""

    success: bool
    error: str | None = None

    @classmethod
    def from_fetch(cls, result: FetchResult) -> RefreshResult:
        if result.status in {"fetched", "not_modified"}:
            return cls(success=True)
        return cls(success=False, error=result.error or "FETCH_FAILED")


FetchCallback = Callable[[], FetchResult]


class PollingMode(abc.ABC):  # noqa: B024 — sealed-type marker; concrete subclasses are dataclasses
    """Marker base — subclasses are AutoPoll / LazyLoad / ManualPoll."""


@dataclasses.dataclass(frozen=True)
class AutoPoll(PollingMode):
    poll_interval_seconds: float = 60.0
    max_init_wait_time_seconds: float = 5.0


@dataclasses.dataclass(frozen=True)
class LazyLoad(PollingMode):
    cache_refresh_interval_seconds: float = 60.0


@dataclasses.dataclass(frozen=True)
class ManualPoll(PollingMode):
    pass


class PollService(abc.ABC):
    """Abstract base for polling services."""

    @abc.abstractmethod
    def start(self, fetch_callback: FetchCallback) -> None: ...

    @abc.abstractmethod
    def stop(self, timeout: float = 5.0) -> None: ...

    @abc.abstractmethod
    def force_refresh(self) -> RefreshResult: ...

    async def force_refresh_async(self) -> RefreshResult:
        return await asyncio.to_thread(self.force_refresh)

    @abc.abstractmethod
    def maybe_fetch_for_get_value(self) -> None:
        """Hook for LazyLoad's on-demand staleness-driven fetch.

        AutoPoll + ManualPoll return immediately.
        """

    @abc.abstractmethod
    def set_online(self) -> None:
        """Re-enable HTTP polling. Idempotent.

        Mirrors `configcat-client.ConfigService.set_online()` (spec 090
        / #267 / #264).
        """

    @abc.abstractmethod
    def set_offline(self) -> None:
        """Suspend HTTP polling; serve from the cached config. Idempotent.

        Mirrors `configcat-client.ConfigService.set_offline()`.
        """

    @abc.abstractmethod
    def is_offline(self) -> bool:
        """Return True if HTTP polling is suspended."""


class AutoPollService(PollService):
    """Daemon-thread-driven background polling.

    On `start()`, kicks off a single fetch on the calling thread (so
    the first `get_value` from the customer's code hits a populated
    config when `max_init_wait_time_seconds` allows it), then spawns a
    daemon thread that sleeps for `poll_interval_seconds` and re-fetches.

    The thread sleeps via `event.wait(timeout=interval)` so `stop()`
    can interrupt the wait without waiting out the remaining interval.
    """

    def __init__(self, options: AutoPoll) -> None:
        self._options = options
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._callback: FetchCallback | None = None
        self._started = False
        self._offline = False
        self._lock = threading.Lock()

    def start(self, fetch_callback: FetchCallback) -> None:
        with self._lock:
            if self._started:
                return
            self._callback = fetch_callback
            self._started = True
            if not self._offline:
                # Eager initial fetch so first get_value lands on real config.
                try:
                    fetch_callback()
                except Exception:
                    # The callback wraps ConfigFetcher.fetch which already
                    # fail-closes; this guard is a belt-and-braces.
                    pass
            self._thread = threading.Thread(
                target=self._run,
                name="confeature-autopoll",
                daemon=True,
            )
            self._thread.start()

    def _run(self) -> None:
        # The first tick was already executed in start(); from here we
        # wait the configured interval before each subsequent fetch.
        while not self._stop_event.is_set():
            if self._stop_event.wait(timeout=self._options.poll_interval_seconds):
                return
            if self._offline:
                continue
            cb = self._callback
            if cb is None:
                return
            try:
                cb()
            except Exception:
                # Loop continues; logger lives inside the callback path.
                continue

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        thread = self._thread
        self._thread = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)

    def force_refresh(self) -> RefreshResult:
        if self._offline:
            return RefreshResult(success=False, error="OFFLINE_MODE")
        cb = self._callback
        if cb is None:
            return RefreshResult(success=False, error="NOT_STARTED")
        return RefreshResult.from_fetch(cb())

    def maybe_fetch_for_get_value(self) -> None:
        # AutoPoll fetches on a schedule; no on-demand work.
        return None

    def set_online(self) -> None:
        with self._lock:
            self._offline = False

    def set_offline(self) -> None:
        with self._lock:
            self._offline = True

    def is_offline(self) -> bool:
        return self._offline


class LazyLoadService(PollService):
    """Fetch lazily on the first get_value past the staleness threshold."""

    def __init__(self, options: LazyLoad) -> None:
        self._options = options
        self._callback: FetchCallback | None = None
        self._last_fetched_at: float = 0.0
        self._offline = False
        self._lock = threading.Lock()

    def start(self, fetch_callback: FetchCallback) -> None:
        with self._lock:
            self._callback = fetch_callback

    def stop(self, timeout: float = 5.0) -> None:
        # Nothing to join — no thread.
        _ = timeout

    def force_refresh(self) -> RefreshResult:
        if self._offline:
            return RefreshResult(success=False, error="OFFLINE_MODE")
        cb = self._callback
        if cb is None:
            return RefreshResult(success=False, error="NOT_STARTED")
        result = RefreshResult.from_fetch(cb())
        if result.success:
            self._last_fetched_at = time.time()
        return result

    def maybe_fetch_for_get_value(self) -> None:
        if self._offline:
            return None
        cb = self._callback
        if cb is None:
            return None
        if time.time() - self._last_fetched_at < self._options.cache_refresh_interval_seconds:
            return None
        try:
            cb()
            self._last_fetched_at = time.time()
        except Exception:
            return None
        return None

    def set_online(self) -> None:
        with self._lock:
            self._offline = False

    def set_offline(self) -> None:
        with self._lock:
            self._offline = True

    def is_offline(self) -> bool:
        return self._offline


class ManualPollService(PollService):
    """Fetches only when the customer calls force_refresh()."""

    def __init__(self) -> None:
        self._callback: FetchCallback | None = None
        self._offline = False

    def start(self, fetch_callback: FetchCallback) -> None:
        self._callback = fetch_callback

    def stop(self, timeout: float = 5.0) -> None:
        _ = timeout

    def force_refresh(self) -> RefreshResult:
        if self._offline:
            return RefreshResult(success=False, error="OFFLINE_MODE")
        cb = self._callback
        if cb is None:
            return RefreshResult(success=False, error="NOT_STARTED")
        return RefreshResult.from_fetch(cb())

    def maybe_fetch_for_get_value(self) -> None:
        return None

    def set_online(self) -> None:
        self._offline = False

    def set_offline(self) -> None:
        self._offline = True

    def is_offline(self) -> bool:
        return self._offline


def make_poll_service(mode: PollingMode) -> PollService:
    """Factory: build the service matching the supplied polling-mode option."""
    if isinstance(mode, AutoPoll):
        return AutoPollService(mode)
    if isinstance(mode, LazyLoad):
        return LazyLoadService(mode)
    if isinstance(mode, ManualPoll):
        return ManualPollService()
    raise TypeError(
        f"Unsupported polling mode: {type(mode).__name__}. "
        "Use AutoPoll(), LazyLoad(), or ManualPoll()."
    )
