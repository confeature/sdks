# SPDX-License-Identifier: MIT
"""Spec 079 / #266 — get_value_details + get_all_values on sdk-python."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from confeature_client import (
    ConfeatureClient,
    EvaluationDetails,
    FlagOverrides,
    ManualPoll,
    MapOverrideDataSource,
    OverrideBehaviour,
    User,
    derive_cache_key,
)

VALID_SDK_KEY = "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"


def _client_with_overrides(map_: dict[str, bool | str | int | float]) -> ConfeatureClient:
    return ConfeatureClient(
        sdk_key=VALID_SDK_KEY,
        polling_mode=ManualPoll(),
        flag_overrides=FlagOverrides(
            data_source=MapOverrideDataSource(map_),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    )


def test_get_value_details_returns_envelope_with_value_from_overrides() -> None:
    client = _client_with_overrides({"feature.x": True})
    details = client.get_value_details("feature.x", False)
    try:
        assert isinstance(details, EvaluationDetails)
        assert details.key == "feature.x"
        assert details.value is True
        assert details.is_default_value is False
        assert details.error is None
        assert details.variation_id is None
        assert details.matched_targeting_rule is None
        assert details.matched_percentage_option is None
    finally:
        client.close()


def test_get_value_details_returns_default_on_missing_key_with_error_code() -> None:
    client = _client_with_overrides({"feature.x": True})
    try:
        details = client.get_value_details("feature.does-not-exist", "fallback")
        assert details.value == "fallback"
        assert details.is_default_value is True
        assert details.error is not None
        # Stable code per the evaluator's tier-0 set
        assert "NOT_FOUND" in details.error or details.error == "NO_CONFIG"
    finally:
        client.close()


def test_get_value_details_on_closed_client_returns_client_closed_error() -> None:
    client = _client_with_overrides({"feature.x": True})
    client.close()
    details = client.get_value_details("feature.x", False)
    assert details.value is False
    assert details.is_default_value is True
    assert details.error == "CLIENT_CLOSED"


def test_get_all_values_returns_resolved_map_for_all_overrides() -> None:
    client = _client_with_overrides({"a": True, "b": "hello", "c": 42})
    try:
        values = client.get_all_values()
        assert values == {"a": True, "b": "hello", "c": 42}
    finally:
        client.close()


def test_get_all_values_on_closed_client_returns_empty_dict() -> None:
    client = _client_with_overrides({"x": True})
    client.close()
    assert client.get_all_values() == {}


def test_get_all_values_with_no_config_returns_empty_dict() -> None:
    # No overrides + no remote fetch — empty.
    with tempfile.TemporaryDirectory() as cache_dir:
        client = ConfeatureClient(
            sdk_key=VALID_SDK_KEY,
            polling_mode=ManualPoll(),
            cache_dir=cache_dir,
        )
        try:
            assert client.get_all_values() == {}
        finally:
            client.close()


def test_get_value_details_user_propagation() -> None:
    client = _client_with_overrides({"feature.x": True})
    user = User(identifier="alice@example.com")
    try:
        details = client.get_value_details("feature.x", False, user=user)
        assert details.user is user
    finally:
        client.close()


def test_snapshot_get_value_details_mirrors_client() -> None:
    client = _client_with_overrides({"feature.x": True})
    try:
        snap = client.snapshot()
        details = snap.get_value_details("feature.x", False)
        assert details.value is True
        assert details.is_default_value is False
        assert details.error is None
    finally:
        client.close()


def test_fetch_time_populated_on_cache_restore() -> None:
    """When a cache file already exists with `fetched_at`, the client
    restores it and surfaces it via EvaluationDetails.fetch_time."""
    with tempfile.TemporaryDirectory() as cache_dir:
        cache_dir_path = Path(cache_dir)
        # Pre-seed the cache file the way `make_cache` would name it
        # (see `FileCache.__init__` — `confeature-{cache_key_tail}.json`).
        cache_key = derive_cache_key(VALID_SDK_KEY)
        cache_key_tail = cache_key.rsplit(":", maxsplit=1)[-1] or cache_key
        cache_file = cache_dir_path / f"confeature-{cache_key_tail}.json"
        cache_file.write_text(
            json.dumps(
                {
                    "body": {"f": {"feature.x": {"t": 0, "v": {"b": True}}}},
                    "etag": "abc123",
                    "fetched_at": 1700000000.0,
                }
            )
        )
        client = ConfeatureClient(
            sdk_key=VALID_SDK_KEY,
            polling_mode=ManualPoll(),
            cache_dir=cache_dir,
        )
        try:
            details = client.get_value_details("feature.x", False)
            assert details.fetch_time is not None
            assert details.fetch_time.timestamp() == pytest.approx(1700000000.0)
        finally:
            client.close()
