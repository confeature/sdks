# SPDX-License-Identifier: MIT
import asyncio
from contextlib import contextmanager
from threading import get_ident
from unittest.mock import DEFAULT, patch

import httpx
import pytest
from fixture import TARGETED_FLAG, FixtureHTTP, guarded_http
from openfeature.evaluation_context import EvaluationContext
from openfeature.exception import ErrorCode

from confeature_client import AutoPoll, ConfeatureClient, LazyLoad, ManualPoll, User
from confeature_client.openfeature import ConfeatureProvider
from openfeature import api

ADMIN = EvaluationContext("synthetic-admin", {"Custom1": "admin"})
VISITOR = EvaluationContext("synthetic-visitor", {"Custom1": "visitor"})


@pytest.fixture
def transport():
    with guarded_http() as guard:
        yield guard


@contextmanager
def registered(sdk):
    # The official registry's synchronous registration calls the no-op initializer.
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="python-fixture")
    try:
        yield api.get_client(domain="python-fixture")
    finally:
        api.clear_providers()


def assert_targeting(client):
    admin = client.get_string_details(TARGETED_FLAG, "default", ADMIN)
    visitor = client.get_string_details(TARGETED_FLAG, "default", VISITOR)
    same = client.get_string_details(TARGETED_FLAG, "Dog", ADMIN)
    assert (admin.value, admin.variant, admin.error_code) == ("Dog", "5b64d9b4", None)
    assert (visitor.value, visitor.variant, visitor.error_code) == ("Cat", "83372510", None)
    assert (same.value, same.variant, same.error_code) == ("Dog", "5b64d9b4", None)


def assert_errors(client):
    missing = client.get_boolean_details("missing-synthetic-flag", True)
    integer_as_float = client.get_float_details("whole", -1.5)
    boolean_as_integer = client.get_integer_details("boolean", -1)
    objects = client.get_object_details(TARGETED_FLAG, {"default": "object"})
    assert (missing.value, missing.error_code) == (True, ErrorCode.FLAG_NOT_FOUND)
    assert (integer_as_float.value, integer_as_float.error_code) == (-1.5, ErrorCode.TYPE_MISMATCH)
    assert (boolean_as_integer.value, boolean_as_integer.error_code) == (
        -1,
        ErrorCode.TYPE_MISMATCH,
    )
    assert (objects.value, objects.error_code) == ({"default": "object"}, ErrorCode.TYPE_MISMATCH)


def test_manual_cold_refresh_targeting_offline_and_shutdown(transport, tmp_path):
    served = transport.served()
    with (
        ConfeatureClient(
            transport.key, ManualPoll(), base_url=transport.origin, cache_dir=tmp_path
        ) as sdk,
        patch.object(sdk, "get_hooks", wraps=sdk.get_hooks) as hooks,
        patch.object(sdk, "get_value_details", wraps=sdk.get_value_details) as details,
    ):
        with registered(sdk) as client:
            assert (transport.count, details.call_count, hooks.call_count) == (0, 0, 0)
            cold = client.get_string_details(TARGETED_FLAG, "default", ADMIN)
            assert (cold.value, cold.error_code) == ("default", ErrorCode.PROVIDER_NOT_READY)
            assert (transport.count, details.call_count) == (0, 1)
            assert sdk.force_refresh().success
            assert_targeting(client)
            assert_errors(client)
            sdk.set_offline()
            assert_targeting(client)
            assert (transport.count, details.call_count, hooks.call_count) == (1, 10, 0)
            assert all(call.args[1] is None for call in details.call_args_list)
        assert sdk.get_value_details(TARGETED_FLAG, None).value == "Cat"
        assert (transport.count, transport.served() - served, transport.blocked) == (1, 1, 0)


def test_auto_cold_origin_failure_recovers_after_caller_refresh(transport, tmp_path):
    served = transport.served()
    transport.fault("5xx")
    try:
        with ConfeatureClient(
            transport.key, AutoPoll(), base_url=transport.origin, cache_dir=tmp_path
        ) as sdk:
            # The native constructor performs its first poll before registration.
            assert transport.count == 1
            with registered(sdk) as client:
                cold = client.get_string_details(TARGETED_FLAG, "default")
                assert (cold.value, cold.error_code) == ("default", ErrorCode.PROVIDER_NOT_READY)
                assert transport.count == 1
                transport.clear_fault()
                assert sdk.force_refresh().success
                assert_targeting(client)
                assert (transport.count, transport.served() - served, transport.blocked) == (
                    2,
                    2,
                    0,
                )
    finally:
        transport.clear_fault()


def test_warm_auto_and_restored_offline_cache_use_native_counts(transport, tmp_path):
    served = transport.served()
    with ConfeatureClient(
        transport.key, AutoPoll(), base_url=transport.origin, cache_dir=tmp_path
    ) as auto:
        assert transport.count == 1
        with registered(auto) as client:
            assert_targeting(client)
        assert (transport.count, transport.served() - served) == (1, 1)
    with ConfeatureClient(
        transport.key, ManualPoll(), base_url=transport.origin, cache_dir=tmp_path
    ) as manual:
        manual.set_offline()
        with registered(manual) as client:
            assert_targeting(client)
        assert (transport.count, transport.served() - served, transport.blocked) == (1, 1, 0)


async def test_lazy_async_keeps_real_refresh_in_flight_off_the_event_loop(transport, tmp_path):
    served = transport.served()
    with (
        ConfeatureClient(
            transport.key, LazyLoad(), base_url=transport.origin, cache_dir=tmp_path
        ) as sdk,
        patch.object(sdk, "get_value_details", wraps=sdk.get_value_details) as details,
    ):
        with registered(sdk) as client:
            assert (transport.count, details.call_count) == (0, 0)
            loop_thread = get_ident()
            details_thread = []

            def record_thread(*args):
                details_thread.append(get_ident())
                return DEFAULT

            details.side_effect = record_thread
            with transport.pause_next_request() as entered:
                evaluation = asyncio.create_task(
                    client.get_string_details_async(TARGETED_FLAG, "default", ADMIN)
                )
                assert await asyncio.to_thread(entered.wait, 3)
                assert transport.count == 1
                assert transport.served() == served
                assert not evaluation.done()
                assert len(details_thread) == 1
                assert details_thread[0] != loop_thread
            result = await asyncio.wait_for(evaluation, timeout=3)
            assert (result.value, result.variant, result.error_code) == ("Dog", "5b64d9b4", None)
            assert (transport.count, transport.served() - served, details.call_count) == (1, 1, 1)
            assert_targeting(client)
            assert (transport.count, transport.served() - served, details.call_count) == (1, 1, 4)
            assert transport.blocked == 0


@pytest.mark.parametrize(
    "url",
    [
        "",
        "http://localhost:8080",
        "http://127.0.0.1:99999",
        "http://127.0.0.1:8080/",
        "http://127.0.0.1:8080?unexpected",
    ],
)
def test_fixture_origin_must_be_literal_loopback(url):
    with pytest.raises(ValueError, match="bound HTTP loopback"):
        FixtureHTTP(url, "synthetic")


async def test_transport_refuses_fallback_origin_and_proxy_overrides(transport, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://192.0.2.1:8765")
    monkeypatch.setenv("ALL_PROXY", "http://192.0.2.1:8765")
    with httpx.Client(follow_redirects=True, trust_env=True) as sync:
        assert sync.get(f"{transport.origin}/admin/state").status_code == 200
        with pytest.raises(RuntimeError, match="outside the bound origin"):
            sync.get("https://fallback.invalid")
    async with httpx.AsyncClient(follow_redirects=True, trust_env=True) as asynchronous:
        assert (await asynchronous.get(f"{transport.origin}/admin/state")).status_code == 200
        with pytest.raises(RuntimeError, match="outside the bound origin"):
            await asynchronous.get("https://fallback.invalid")
    with pytest.raises(RuntimeError, match="overrides are disabled"):
        httpx.Client(proxy="http://192.0.2.1:8765")
    assert (transport.count, transport.blocked) == (0, 2)


async def test_transport_refuses_redirect_before_a_second_request(transport, monkeypatch):
    served = transport.served()
    path = f"{transport.origin}/configuration-files/{transport.key}/config_v6.json"
    transport.fault({"kind": "status", "status": 307})

    # The harness's status-fault schema permits 307 and has no Location field.
    # Add Location on the real response to make the redirect followable.
    native_sync = httpx.HTTPTransport.handle_request
    native_async = httpx.AsyncHTTPTransport.handle_async_request

    def redirect(response):
        if response.status_code == 307:
            response.headers["Location"] = f"{transport.origin}/admin/state"
        return response

    def sync_response(self, request):
        return redirect(native_sync(self, request))

    async def async_response(self, request):
        return redirect(await native_async(self, request))

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", sync_response)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", async_response)
    try:
        with httpx.Client() as sync:
            with pytest.raises(RuntimeError, match="Fixture redirect refused"):
                sync.get(path, follow_redirects=True)
        async with httpx.AsyncClient() as asynchronous:
            with pytest.raises(RuntimeError, match="Fixture redirect refused"):
                await asynchronous.get(path, follow_redirects=True)
        assert (transport.count, transport.served() - served, transport.blocked) == (2, 2, 2)
    finally:
        transport.clear_fault()


@pytest.mark.parametrize("mode", [AutoPoll(), LazyLoad(), ManualPoll()])
def test_provider_request_count_matches_direct_sdk(mode, transport, tmp_path):
    def read(cache_dir, use_provider):
        served = transport.served()
        attempts = transport.count
        with ConfeatureClient(
            transport.key, mode, base_url=transport.origin, cache_dir=cache_dir
        ) as sdk:
            after_construction = transport.count - attempts
            if isinstance(mode, ManualPoll):
                assert sdk.force_refresh().success
            before_reads = transport.count - attempts
            if use_provider:
                with registered(sdk) as client:
                    assert_targeting(client)
            else:
                for attributes, expected in (("admin", "Dog"), ("visitor", "Cat")):
                    sdk_user = User("synthetic", custom={"Custom1": attributes})
                    assert sdk.get_value_details(TARGETED_FLAG, None, sdk_user).value == expected
            total = transport.count - attempts
            assert transport.served() - served == total == 1
            return after_construction, before_reads, total

    assert read(tmp_path / "direct", False) == read(tmp_path / "provider", True)
    assert transport.blocked == 0
