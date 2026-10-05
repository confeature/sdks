# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.poll_service`.

Three polling modes, three lifecycles:
  - AutoPollService: spawns a daemon thread on start(), joins on stop().
  - LazyLoadService: only fetches when staleness threshold elapses.
  - ManualPollService: only fetches on explicit force_refresh().
"""

from __future__ import annotations

import time
from collections.abc import Callable

import pytest

from confeature_client.config_fetcher import FetchResult
from confeature_client.poll_service import (
    AutoPoll,
    AutoPollService,
    LazyLoad,
    LazyLoadService,
    ManualPoll,
    ManualPollService,
    RefreshResult,
    make_poll_service,
)


def _success_callback(counter: list[int]) -> Callable[[], FetchResult]:
    def _cb() -> FetchResult:
        counter.append(1)
        return FetchResult(status="fetched", body={"f": {}}, etag='"e"')

    return _cb


def _failure_callback() -> Callable[[], FetchResult]:
    def _cb() -> FetchResult:
        return FetchResult(status="failed", error="BOOM")

    return _cb


class TestAutoPollService:
    def test_start_fires_initial_fetch(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_success_callback(counter))
        try:
            # Eager initial fetch lands on the calling thread.
            assert len(counter) == 1
        finally:
            service.stop(timeout=1.0)

    def test_start_spawns_daemon_thread(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_success_callback(counter))
        try:
            thread = service._thread
            assert thread is not None
            assert thread.daemon is True
            assert thread.is_alive()
        finally:
            service.stop(timeout=1.0)

    def test_stop_joins_thread_within_timeout(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_success_callback(counter))
        thread = service._thread
        assert thread is not None

        service.stop(timeout=2.0)

        assert not thread.is_alive(), "AutoPoll thread did not join within stop() timeout"

    def test_start_is_idempotent(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_success_callback(counter))
        first_thread = service._thread
        # A second start MUST NOT spawn a new thread.
        service.start(_success_callback(counter))
        second_thread = service._thread
        try:
            assert first_thread is second_thread
            # And the callback fired only once (the eager initial fetch).
            assert len(counter) == 1
        finally:
            service.stop(timeout=1.0)

    def test_force_refresh_invokes_callback(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_success_callback(counter))
        try:
            result = service.force_refresh()
            assert result.success is True
            assert len(counter) == 2  # 1 from start() + 1 from force_refresh().
        finally:
            service.stop(timeout=1.0)

    def test_force_refresh_before_start_returns_not_started(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "NOT_STARTED"

    def test_background_poll_fires_on_interval(self) -> None:
        counter: list[int] = []
        # Tight interval to test the background loop without making the
        # test suite slow.
        service = AutoPollService(AutoPoll(poll_interval_seconds=0.05))
        service.start(_success_callback(counter))
        try:
            time.sleep(0.18)  # should fit ~3 ticks plus the initial fetch.
        finally:
            service.stop(timeout=1.0)
        assert len(counter) >= 2, f"Expected ≥ 2 fetches, got {len(counter)}"


class TestLazyLoadService:
    def test_force_refresh_invokes_callback(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=60.0))
        service.start(_success_callback(counter))
        result = service.force_refresh()
        assert result.success is True
        assert len(counter) == 1

    def test_maybe_fetch_fires_first_call(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=60.0))
        service.start(_success_callback(counter))
        # `_last_fetched_at` starts at 0.0 so the first call is always stale.
        service.maybe_fetch_for_get_value()
        assert len(counter) == 1

    def test_maybe_fetch_within_threshold_reuses_cache(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=60.0))
        service.start(_success_callback(counter))
        service.maybe_fetch_for_get_value()  # first call → fetch.
        service.maybe_fetch_for_get_value()  # second call within 60s → no fetch.
        assert len(counter) == 1

    def test_maybe_fetch_past_threshold_refetches(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=0.05))
        service.start(_success_callback(counter))
        service.maybe_fetch_for_get_value()  # first call → fetch.
        time.sleep(0.1)
        service.maybe_fetch_for_get_value()  # past staleness → fetch again.
        assert len(counter) == 2

    def test_force_refresh_before_start_returns_not_started(self) -> None:
        service = LazyLoadService(LazyLoad())
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "NOT_STARTED"

    def test_stop_is_a_noop(self) -> None:
        # LazyLoad has no thread to join; stop() must accept any timeout
        # and return without raising.
        service = LazyLoadService(LazyLoad())
        service.stop(timeout=999.0)


class TestManualPollService:
    def test_force_refresh_invokes_callback(self) -> None:
        counter: list[int] = []
        service = ManualPollService()
        service.start(_success_callback(counter))
        result = service.force_refresh()
        assert result.success is True
        assert len(counter) == 1

    def test_maybe_fetch_for_get_value_does_not_fetch(self) -> None:
        counter: list[int] = []
        service = ManualPollService()
        service.start(_success_callback(counter))
        service.maybe_fetch_for_get_value()
        service.maybe_fetch_for_get_value()
        assert counter == []

    def test_failed_fetch_propagates_to_refresh_result(self) -> None:
        service = ManualPollService()
        service.start(_failure_callback())
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "BOOM"

    def test_force_refresh_before_start_returns_not_started(self) -> None:
        service = ManualPollService()
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "NOT_STARTED"


class TestRefreshResultFromFetch:
    def test_fetched_maps_to_success(self) -> None:
        r = RefreshResult.from_fetch(FetchResult(status="fetched", body={}))
        assert r == RefreshResult(success=True)

    def test_not_modified_maps_to_success(self) -> None:
        r = RefreshResult.from_fetch(FetchResult(status="not_modified"))
        assert r == RefreshResult(success=True)

    def test_failed_maps_to_failure_with_reason(self) -> None:
        r = RefreshResult.from_fetch(FetchResult(status="failed", error="X"))
        assert r == RefreshResult(success=False, error="X")

    def test_failed_without_reason_substitutes_default(self) -> None:
        r = RefreshResult.from_fetch(FetchResult(status="failed"))
        assert r.success is False
        assert r.error == "FETCH_FAILED"


class TestMakePollServiceFactory:
    def test_auto_poll_option(self) -> None:
        service = make_poll_service(AutoPoll())
        assert isinstance(service, AutoPollService)

    def test_lazy_load_option(self) -> None:
        service = make_poll_service(LazyLoad())
        assert isinstance(service, LazyLoadService)

    def test_manual_poll_option(self) -> None:
        service = make_poll_service(ManualPoll())
        assert isinstance(service, ManualPollService)

    def test_unknown_option_raises(self) -> None:
        class Unknown:
            pass

        with pytest.raises(TypeError, match="Unsupported polling mode"):
            make_poll_service(Unknown())  # type: ignore[arg-type]
