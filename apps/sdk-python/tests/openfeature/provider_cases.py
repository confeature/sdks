# SPDX-License-Identifier: MIT
from datetime import datetime, timezone
from unittest.mock import Mock

import pytest
from openfeature.evaluation_context import EvaluationContext
from openfeature.exception import ErrorCode
from openfeature.flag_evaluation import Reason
from openfeature.provider.no_op_provider import NoOpProvider

from confeature_client import ConfeatureClient, EvaluationDetails, User
from confeature_client.openfeature import ConfeatureProvider
from openfeature import api

SENTINELS = ("synthetic-key-secret", "synthetic-context-secret", "synthetic-exception-secret")


@pytest.fixture
def sdk():
    return Mock(spec=ConfeatureClient)


def test_example_cleanup_is_scoped_to_its_domain(sdk):
    sdk.get_value_details.return_value = EvaluationDetails("flag", True)
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="app")
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="other")
    try:
        app = api.get_client(domain="app")
        other = api.get_client(domain="other")
        assert app.get_boolean_value("flag", False) is True

        api.set_provider_and_wait(NoOpProvider(), domain="app")

        assert app.get_boolean_value("flag", False) is False
        assert other.get_boolean_value("flag", False) is True
    finally:
        api.clear_providers()
    sdk.close.assert_not_called()


@pytest.mark.parametrize(
    ("kind", "default", "value"),
    [("boolean", False, True), ("string", "", "v"), ("integer", 0, 7), ("float", 0.0, 7.0)],
)
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_scalar_resolves_once_through_official_client(
    sdk, kind, default, value, asynchronous
):
    sdk.get_value_details.return_value = EvaluationDetails(
        "flag", value, variation_id="variant", error="opaque SDK warning"
    )
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="scalar")
    try:
        client = api.get_client(domain="scalar")
        if asynchronous:
            details = await getattr(client, f"get_{kind}_details_async")("flag", default)
        else:
            details = getattr(client, f"get_{kind}_details")("flag", default)
        assert type(details.value) is type(value)
        assert (details.value, details.variant, details.error_code) == (value, "variant", None)
    finally:
        api.clear_providers()
    sdk.get_value_details.assert_called_once_with("flag", None, None)
    sdk.get_hooks.assert_not_called()
    sdk.close.assert_not_called()


@pytest.mark.parametrize(
    ("kind", "default", "value"),
    [("boolean", False, 1), ("integer", -1, True), ("integer", -1, 1.0), ("float", -1.0, 1)],
)
def test_exact_primitive_types(sdk, kind, default, value):
    sdk.get_value_details.return_value = EvaluationDetails("flag", value, variation_id="ignored")
    details = getattr(ConfeatureProvider(sdk), f"resolve_{kind}_details")("flag", default)
    assert details.value == default
    assert details.error_code is ErrorCode.TYPE_MISMATCH
    assert details.variant is None


@pytest.mark.parametrize(
    ("sdk_error", "expected"),
    [
        ("NO_CONFIG", ErrorCode.PROVIDER_NOT_READY),
        ("CLIENT_CLOSED", ErrorCode.PROVIDER_NOT_READY),
        ("KEY_NOT_FOUND", ErrorCode.FLAG_NOT_FOUND),
        ("TYPE_MISMATCH", ErrorCode.TYPE_MISMATCH),
        ("UNSUPPORTED_TYPE", ErrorCode.TYPE_MISMATCH),
        ("MALFORMED_CONFIG", ErrorCode.GENERAL),
        ("opaque synthetic-context-secret", ErrorCode.GENERAL),
        (None, ErrorCode.GENERAL),
    ],
)
def test_typed_failures(sdk, sdk_error, expected):
    sdk.get_value_details.return_value = EvaluationDetails(
        "flag", "ignored", error=sdk_error, is_default_value=True, variation_id="ignored"
    )
    details = ConfeatureProvider(sdk).resolve_string_details("flag", "default")
    assert (details.value, details.error_code, details.reason) == (
        "default",
        expected,
        Reason.ERROR,
    )
    assert details.variant is None
    assert all(sentinel not in (details.error_message or "") for sentinel in SENTINELS)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_decimal_returns_default(sdk, value):
    sdk.get_value_details.return_value = EvaluationDetails("flag", value, variation_id="ignored")
    details = ConfeatureProvider(sdk).resolve_float_details("flag", 0.0)
    assert (details.value, details.error_code, details.variant) == (
        0.0,
        ErrorCode.TYPE_MISMATCH,
        None,
    )


def test_untyped_none_cannot_be_success(sdk):
    sdk.get_value_details.return_value = EvaluationDetails("flag", None)
    details = ConfeatureProvider(sdk).resolve_string_details("flag", "default")
    assert details.value == "default"
    assert details.error_code is ErrorCode.GENERAL


async def test_objects_return_defaults_without_sdk(sdk):
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="objects")
    try:
        client = api.get_client(domain="objects")
        for details in [
            client.get_object_details("flag", {"default": True}),
            await client.get_object_details_async("flag", {"default": True}),
        ]:
            assert details.value == {"default": True}
            assert details.error_code is ErrorCode.TYPE_MISMATCH
    finally:
        api.clear_providers()
    assert sdk.mock_calls == []


def test_context_is_copied_and_reserved_attributes_stay_reserved(sdk):
    instant = datetime(2026, 1, 1, tzinfo=timezone.utc)
    items = ["one", "two"]
    original = EvaluationContext(
        targeting_key="first",
        attributes={
            "Email": "synthetic@example.test",
            "Country": "FR",
            "Identifier": "ignored",
            "targetingKey": "also ignored",
            "StringArray": items,
            "Numeric": 5,
            "Boolean": False,
            "Instant": instant,
            "UnsupportedObject": {"nested": "string"},
            "UnsupportedArray": ["string", 1],
        },
    )
    sdk.get_value_details.return_value = EvaluationDetails("flag", "served")
    provider = ConfeatureProvider(sdk)
    for context in (original, EvaluationContext("second"), original, EvaluationContext()):
        provider.resolve_string_details("flag", "", context)
    first, second, third, fourth = (call.args[2] for call in sdk.get_value_details.call_args_list)
    assert (
        first
        == third
        == User(
            "first",
            "synthetic@example.test",
            "FR",
            {"StringArray": ["one", "two"], "Numeric": 5, "Boolean": False, "Instant": instant},
        )
    )
    assert first is not third
    assert first.custom is not third.custom
    assert first.custom["StringArray"] is not third.custom["StringArray"]
    assert first.custom["StringArray"] is not items
    assert second == User("second", custom={})
    assert fourth is None
    assert original.attributes["StringArray"] is items


def test_opaque_exception_is_sanitized_in_official_client_and_logs(sdk, caplog):
    sdk.get_value_details.side_effect = RuntimeError(" ".join(SENTINELS))
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="sanitized")
    try:
        details = api.get_client(domain="sanitized").get_string_details(
            SENTINELS[0], "caller-default", EvaluationContext(SENTINELS[1])
        )
        assert details.value == "caller-default"
        assert details.error_code is ErrorCode.GENERAL
        assert details.error_message == "Confeature could not evaluate the flag."
        assert all(sentinel not in caplog.text for sentinel in SENTINELS)
    finally:
        api.clear_providers()
