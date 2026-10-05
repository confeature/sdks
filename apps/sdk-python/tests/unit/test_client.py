# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.client` — construction + lifecycle.

Covers:
  - construction validates inputs (empty sdk_key, negative timeout,
    wrong flag_overrides type, wrong logger type).
  - `close()` is idempotent.
  - context manager (`__enter__` / `__exit__`) calls close.
  - LocalOnly mode skips network setup (no poll thread spawned).
  - GC finaliser path — marked skip (timing-dependent).
"""

from __future__ import annotations

import pytest

from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    LazyLoad,
    MapOverrideDataSource,
    OverrideBehaviour,
)

from .._key_leak import SURROGATE_KEY, CapturingLogger, render, secrets_of

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


def _local_only_client(**overrides: object) -> ConfeatureClient:
    """Build a LocalOnly client that never reaches the network."""
    kwargs: dict[str, object] = {
        "sdk_key": _SDK_KEY,
        "flag_overrides": FlagOverrides(
            data_source=MapOverrideDataSource({"a": True}),
            behaviour=OverrideBehaviour.LOCAL_ONLY,
        ),
    }
    kwargs.update(overrides)
    return ConfeatureClient(**kwargs)  # type: ignore[arg-type]


class TestConstructionValidation:
    def test_empty_sdk_key_raises(self) -> None:
        with pytest.raises(ValueError, match="sdk_key"):
            ConfeatureClient(sdk_key="")

    def test_non_string_sdk_key_raises(self) -> None:
        with pytest.raises(ValueError, match="sdk_key"):
            ConfeatureClient(sdk_key=None)  # type: ignore[arg-type]

    def test_negative_timeout_raises(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            ConfeatureClient(
                sdk_key=_SDK_KEY,
                request_timeout_seconds=-1.0,
                flag_overrides=FlagOverrides(
                    data_source=MapOverrideDataSource({"a": True}),
                    behaviour=OverrideBehaviour.LOCAL_ONLY,
                ),
            )

    def test_zero_timeout_raises(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            ConfeatureClient(
                sdk_key=_SDK_KEY,
                request_timeout_seconds=0,
                flag_overrides=FlagOverrides(
                    data_source=MapOverrideDataSource({"a": True}),
                    behaviour=OverrideBehaviour.LOCAL_ONLY,
                ),
            )

    def test_wrong_flag_overrides_type_raises(self) -> None:
        with pytest.raises(TypeError, match="flag_overrides"):
            ConfeatureClient(
                sdk_key=_SDK_KEY,
                flag_overrides="not-a-flag-overrides",  # type: ignore[arg-type]
            )

    def test_wrong_logger_type_raises(self) -> None:
        with pytest.raises(TypeError, match="logger"):
            ConfeatureClient(
                sdk_key=_SDK_KEY,
                logger="not-a-logger",  # type: ignore[arg-type]
                flag_overrides=FlagOverrides(
                    data_source=MapOverrideDataSource({"a": True}),
                    behaviour=OverrideBehaviour.LOCAL_ONLY,
                ),
            )

    def test_malformed_sdk_key_format_logs_warning_but_does_not_raise(self) -> None:
        # Per FR-009 of sdk-node spec 030: lenient at runtime — log
        # `INVALID_SDK_KEY` and continue.
        logger = CapturingLogger()
        client = ConfeatureClient(
            sdk_key="not-a-confeature-key-but-long-enough-to-construct",
            logger=logger,
            flag_overrides=FlagOverrides(
                data_source=MapOverrideDataSource({"a": True}),
                behaviour=OverrideBehaviour.LOCAL_ONLY,
            ),
        )
        try:
            warnings = [m for lvl, m in logger.records if lvl == "warning"]
            assert any("INVALID_SDK_KEY" in m for m in warnings)
        finally:
            client.close()


class TestKeyNeverEscapes:
    """#803: the key travels in the URL. Nothing that can carry it — an
    exception raised to the caller, a log line — may quote it."""

    def test_an_unencodable_key_is_refused_without_quoting_it(self) -> None:
        logger = CapturingLogger()
        with pytest.raises(ValueError) as caught:
            ConfeatureClient(sdk_key=SURROGATE_KEY, logger=logger)

        exc = caught.value
        # No chained library exception (UnicodeEncodeError holds the whole key).
        assert exc.__cause__ is None and exc.__context__ is None
        # Judged as a logger would print it: traceback, repr, args, cause chain
        # (str() of a UnicodeEncodeError omits the key; its repr and args hold it).
        rendered = render(exc)
        for secret in secrets_of(SURROGATE_KEY):
            assert secret not in rendered, f"the raised error quotes {secret!r}"
            for line in logger.rendered:
                assert secret not in line, f"log line leaks {secret!r}: {line!r}"

    def test_a_failure_inside_the_fetch_is_logged_by_type_only(self) -> None:
        """A LazyLoad ``get_value`` whose fetch raises: the exception's
        message (here quoting the key, as a URL-quoting library would) never
        reaches the log — only its type name does."""
        logger = CapturingLogger()
        client = ConfeatureClient(
            sdk_key=_SDK_KEY, polling_mode=LazyLoad(), logger=logger, cache_dir=None
        )
        try:

            def _raise() -> None:
                raise RuntimeError(f"GET https://cdn.test/configuration-files/{_SDK_KEY}")

            client._service.maybe_fetch_for_get_value = _raise  # type: ignore[method-assign]
            assert client.get_value("missing", "dflt") == "dflt"
            assert client.get_value_details("missing", "dflt").value == "dflt"
        finally:
            client.close()

        raised = [line for line in logger.messages if "maybe_fetch_for_get_value raised" in line]
        assert len(raised) == 2, logger.messages
        assert all("RuntimeError" in line for line in raised)
        for line in logger.rendered:
            assert _SDK_KEY not in line, f"log line leaks the key: {line!r}"


class TestCloseIsIdempotent:
    def test_close_twice_does_not_raise(self) -> None:
        client = _local_only_client()
        client.close()
        client.close()

    def test_close_then_get_value_returns_default(self) -> None:
        client = _local_only_client()
        client.close()
        # After close, get_value falls through to the default — the
        # SDK never raises on a closed client.
        assert client.get_value("missing", "fallback") == "fallback"


class TestContextManager:
    def test_context_manager_calls_close(self) -> None:
        client = _local_only_client()
        with client:
            assert client.get_value("a", False) is True
        # After the with block exits, the client should be closed.
        assert client._closed is True

    async def test_async_context_manager_calls_close_async(self) -> None:
        client = _local_only_client()
        async with client:
            assert client.get_value("a", False) is True
        assert client._closed is True


class TestLocalOnlyModeSkipsNetwork:
    def test_local_only_does_not_start_poll_service(self) -> None:
        # LocalOnly clients never need to fetch; the poll service
        # callback should stay None.
        client = _local_only_client()
        try:
            cb = getattr(client._service, "_callback", "MISSING")
            assert cb is None
        finally:
            client.close()

    def test_force_refresh_in_local_only_is_noop_success(self) -> None:
        client = _local_only_client()
        try:
            result = client.force_refresh()
            assert result.success is True
        finally:
            client.close()


@pytest.mark.skip(reason="GC timing-dependent — TODO: subprocess-isolated finaliser test")
def test_gc_finaliser_closes_client() -> None:
    """`__del__` safety net — must close the client without raising.

    Skipped because Python's GC timing makes this flaky in-process.
    A subprocess-isolated test could exercise it deterministically;
    the current `__del__` body is small enough to be covered by code
    review.
    """
    pass  # pragma: no cover
