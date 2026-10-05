# SPDX-License-Identifier: MIT
"""Unit tests for the hooks/events bus (spec 107 / #268 slice 5/14).

Covers:
  - ``Hooks`` class: add_on_* + invoke_on_* contracts, listener exception isolation.
  - ``ConfeatureClient.get_hooks`` returns a stable instance.
  - flag_evaluated fires on get_value_details with the produced details.
"""

from __future__ import annotations

import inspect

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    MapOverrideDataSource,
    OverrideBehaviour,
)
from confeature_client.hooks import Hooks

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


def _local_only_client() -> ConfeatureClient:
    return ConfeatureClient(
        sdk_key=_SDK_KEY,
        flag_overrides=FlagOverrides(
            data_source=MapOverrideDataSource({"feature.dark-mode": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    )


class TestHooksClass:
    def test_add_on_client_ready_then_invoke_fires_listener(self) -> None:
        hooks = Hooks()
        fires: list[int] = []
        hooks.add_on_client_ready(lambda: fires.append(1))
        hooks.invoke_on_client_ready()
        assert fires == [1]

    def test_add_on_config_changed_receives_payload(self) -> None:
        hooks = Hooks()
        captured: list[dict] = []
        hooks.add_on_config_changed(captured.append)
        hooks.invoke_on_config_changed({"f": {"feature.x": {"v": True}}})
        assert captured == [{"f": {"feature.x": {"v": True}}}]

    def test_add_on_flag_evaluated_receives_payload(self) -> None:
        hooks = Hooks()
        captured: list[object] = []
        hooks.add_on_flag_evaluated(captured.append)
        hooks.invoke_on_flag_evaluated("EVAL")
        assert captured == ["EVAL"]

    def test_add_on_error_receives_message(self) -> None:
        hooks = Hooks()
        captured: list[str] = []
        hooks.add_on_error(captured.append)
        hooks.invoke_on_error("Config fetch failed.")
        assert captured == ["Config fetch failed."]

    def test_listener_exception_is_caught_and_does_not_break_others(self) -> None:
        hooks = Hooks()
        fires: list[int] = []

        def raising(_msg: str) -> None:
            raise RuntimeError("boom")

        hooks.add_on_error(raising)
        hooks.add_on_error(lambda _msg: fires.append(1))
        hooks.invoke_on_error("test error")
        assert fires == [1]


class TestClientHooksWiring:
    def test_get_hooks_returns_same_instance_across_calls(self) -> None:
        client = _local_only_client()
        try:
            assert isinstance(client.get_hooks(), Hooks)
            assert client.get_hooks() is client.get_hooks()
        finally:
            client.close()

    def test_flag_evaluated_fires_on_get_value_details(self) -> None:
        client = _local_only_client()
        captured: list[object] = []
        try:
            client.get_hooks().add_on_flag_evaluated(captured.append)
            client.get_value_details("feature.dark-mode", False)
            client.get_value_details("feature.unknown", False)
            assert len(captured) == 2
        finally:
            client.close()

    def test_get_hooks_is_part_of_public_api_surface(self) -> None:
        # Pin the call shape: get_hooks() takes no args beyond self.
        sig = inspect.signature(ConfeatureClient.get_hooks)
        params = [p for p in sig.parameters.values() if p.name != "self"]
        assert params == [], "get_hooks() MUST take no arguments beyond self"
