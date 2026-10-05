# SPDX-License-Identifier: MIT
"""Unit tests for the online/offline triplet (spec 090 / #267).

Covers:
  - PollService level: AutoPoll, LazyLoad, ManualPoll honour the
    offline flag (no callback fires while offline, resume on flip).
  - ConfeatureClient level: closed + LocalOnly + happy-path delegation
    semantics.
  - force_refresh while offline returns a non-success RefreshResult.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    MapOverrideDataSource,
    OverrideBehaviour,
)
from confeature_client.config_fetcher import FetchResult
from confeature_client.poll_service import (
    AutoPoll,
    AutoPollService,
    LazyLoad,
    LazyLoadService,
    ManualPollService,
)

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


def _counting_callback(counter: list[int]) -> Callable[[], FetchResult]:
    def _cb() -> FetchResult:
        counter.append(1)
        return FetchResult(status="fetched", body={"f": {}}, etag='"e"')

    return _cb


def _local_only_client() -> ConfeatureClient:
    return ConfeatureClient(
        sdk_key=_SDK_KEY,
        flag_overrides=FlagOverrides(
            data_source=MapOverrideDataSource({"a": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    )


class TestAutoPollServiceOnlineOffline:
    def test_default_is_online(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        assert service.is_offline() is False

    def test_set_offline_flips_flag(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.set_offline()
        assert service.is_offline() is True

    def test_set_online_resets_flag(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.set_offline()
        service.set_online()
        assert service.is_offline() is False

    def test_set_offline_is_idempotent(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.set_offline()
        service.set_offline()
        assert service.is_offline() is True

    def test_set_online_is_idempotent(self) -> None:
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.set_online()
        service.set_online()
        assert service.is_offline() is False

    def test_offline_before_start_skips_eager_initial_fetch(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.set_offline()
        service.start(_counting_callback(counter))
        try:
            time.sleep(0.05)
            assert counter == [], "Eager initial fetch fired while service was offline."
        finally:
            service.stop(timeout=2.0)

    def test_daemon_skips_fetch_while_offline(self) -> None:
        counter: list[int] = []
        # Very short poll interval so the daemon wakes inside the test.
        service = AutoPollService(AutoPoll(poll_interval_seconds=0.05))
        service.start(_counting_callback(counter))
        try:
            # Initial eager fetch happens during start(); confirm it.
            assert counter == [1]
            service.set_offline()
            time.sleep(0.20)  # 4 poll intervals
            assert counter == [1], f"Daemon called fetch while offline: counter={counter}"
            service.set_online()
            time.sleep(0.15)  # next wakeup should fetch
            assert len(counter) >= 2, (
                f"Daemon did not resume fetching after set_online: counter={counter}"
            )
        finally:
            service.stop(timeout=2.0)

    def test_force_refresh_while_offline_returns_offline_mode(self) -> None:
        counter: list[int] = []
        service = AutoPollService(AutoPoll(poll_interval_seconds=60.0))
        service.start(_counting_callback(counter))
        try:
            initial = list(counter)
            service.set_offline()
            result = service.force_refresh()
            assert result.success is False
            assert result.error == "OFFLINE_MODE"
            assert counter == initial, "force_refresh fetched while offline"
        finally:
            service.stop(timeout=2.0)


class TestLazyLoadServiceOnlineOffline:
    def test_default_is_online(self) -> None:
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=60.0))
        assert service.is_offline() is False

    def test_maybe_fetch_skipped_while_offline(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=0.0))
        service.start(_counting_callback(counter))
        service.set_offline()
        service.maybe_fetch_for_get_value()
        assert counter == [], "maybe_fetch_for_get_value fetched while offline"
        service.set_online()
        service.maybe_fetch_for_get_value()
        assert counter == [1], f"maybe_fetch did not resume after set_online: counter={counter}"

    def test_force_refresh_while_offline_returns_offline_mode(self) -> None:
        counter: list[int] = []
        service = LazyLoadService(LazyLoad(cache_refresh_interval_seconds=60.0))
        service.start(_counting_callback(counter))
        service.set_offline()
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "OFFLINE_MODE"
        assert counter == []


class TestManualPollServiceOnlineOffline:
    def test_default_is_online(self) -> None:
        service = ManualPollService()
        assert service.is_offline() is False

    def test_force_refresh_while_offline_returns_offline_mode(self) -> None:
        counter: list[int] = []
        service = ManualPollService()
        service.start(_counting_callback(counter))
        service.set_offline()
        result = service.force_refresh()
        assert result.success is False
        assert result.error == "OFFLINE_MODE"
        assert counter == []
        # Flip back and the next force_refresh fires.
        service.set_online()
        result = service.force_refresh()
        assert result.success is True
        assert counter == [1]


class TestConfeatureClientOnlineOffline:
    def test_local_only_client_is_offline(self) -> None:
        client = _local_only_client()
        try:
            assert client.is_offline() is True
        finally:
            client.close()

    def test_local_only_set_online_is_noop(self) -> None:
        client = _local_only_client()
        try:
            client.set_online()
            assert client.is_offline() is True
        finally:
            client.close()

    def test_local_only_set_offline_is_silent_noop(self) -> None:
        client = _local_only_client()
        try:
            client.set_offline()  # silent no-op
            assert client.is_offline() is True
        finally:
            client.close()

    def test_closed_client_is_offline(self) -> None:
        client = _local_only_client()
        client.close()
        assert client.is_offline() is True

    def test_closed_client_set_online_is_noop(self) -> None:
        client = _local_only_client()
        client.close()
        client.set_online()  # no exception
        assert client.is_offline() is True

    def test_closed_client_set_offline_is_noop(self) -> None:
        client = _local_only_client()
        client.close()
        client.set_offline()  # no exception
        assert client.is_offline() is True
