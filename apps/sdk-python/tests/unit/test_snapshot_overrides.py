# SPDX-License-Identifier: MIT
"""Spec 036 correctness gate, inherited by spec 037 from day one.

The Python SDK MUST resolve `flag_overrides` synchronously via
`snapshot().get_value()` **before any poll has happened**. This proves
the spec-036 fix (originally retrofitted into sdk-node) is correct in
the new Python implementation from the very first commit — no
`waitFor()` workaround, no async-only override path.
"""

from __future__ import annotations

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    MapOverrideDataSource,
    OverrideBehaviour,
)

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


class TestSnapshotOverridesLocalOnly:
    def test_snapshot_get_value_returns_override_synchronously(self) -> None:
        # Construct the client with LocalOnly overrides; no fetch has
        # happened yet, no poll thread has produced data.
        client = ConfeatureClient(
            sdk_key=_SDK_KEY,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"feature.a": True}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            snapshot = client.snapshot()
            # The spec-036 gate: this MUST be True without waiting for
            # any background poll to fire.
            assert snapshot.get_value("feature.a", False) is True
        finally:
            client.close()

    def test_snapshot_returns_false_override_synchronously(self) -> None:
        # Regression guard: a False override must not be mistaken for
        # "no override" and fall through to the default.
        client = ConfeatureClient(
            sdk_key=_SDK_KEY,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"feature.b": False}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            snapshot = client.snapshot()
            assert snapshot.get_value("feature.b", True) is False
        finally:
            client.close()

    def test_snapshot_missing_key_returns_default_synchronously(self) -> None:
        # LocalOnly contract: missing key → default, NEVER fall through
        # to the (uninitialised) cache.
        client = ConfeatureClient(
            sdk_key=_SDK_KEY,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"feature.a": True}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            snapshot = client.snapshot()
            assert snapshot.get_value("missing", "fallback") == "fallback"
        finally:
            client.close()

    def test_get_value_returns_override_synchronously_too(self) -> None:
        # The client's top-level get_value must use the same override
        # path. (snapshot() is the canonical surface but get_value()
        # MUST NOT degrade behaviour.)
        client = ConfeatureClient(
            sdk_key=_SDK_KEY,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"feature.a": True}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            assert client.get_value("feature.a", False) is True
        finally:
            client.close()

    def test_get_all_keys_includes_override_keys(self) -> None:
        client = ConfeatureClient(
            sdk_key=_SDK_KEY,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"feature.a": True, "feature.b": False}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            keys = client.snapshot().get_all_keys()
            assert set(keys) == {"feature.a", "feature.b"}
        finally:
            client.close()
