# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.config_fetcher`.

Covers the four `FetchResult.status` paths (200 / 304 / non-2xx / network
error) plus the load-bearing security invariant: the raw SDK key MUST
never appear in any log line or returned error string. The `pytest-httpx`
plugin intercepts every outbound `httpx` call so the tests never touch
the network.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx
import pytest
from pytest_httpx import HTTPXMock, IteratorStream

from confeature_client.config_fetcher import ConfigFetcher, FetchResult
from confeature_client.logger import Logger, LogLevel, StderrLogger

from .._key_leak import SURROGATE_KEY, CapturingLogger, go_path_escape, secrets_of

#: Full-form Confeature key the suite asserts is NEVER logged verbatim.
_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


def _make_fetcher(logger: Logger, **overrides: Any) -> ConfigFetcher:
    kwargs: dict[str, Any] = {
        "sdk_key": _SDK_KEY,
        "version": "0.0.0-test",
        "logger": logger,
        "base_url": "https://cdn.test.confeature.io",
        "request_timeout_seconds": 1.0,
    }
    kwargs.update(overrides)
    return ConfigFetcher(**kwargs)


def _path_of(request: httpx.Request) -> str:
    """The request path as sent — still percent-encoded, query excluded, so
    the pins survive the version carrier's query (#807)."""
    return request.url.raw_path.decode("ascii").split("?", 1)[0]


def _assert_sdk_key_never_logged(logger: CapturingLogger, *extra_strings: str) -> None:
    """Assert the raw SDK key never appears in any log line or returned string."""
    for msg in logger.rendered:
        assert _SDK_KEY not in msg, f"SDK key leaked in log line: {msg!r}"
    for extra in extra_strings:
        assert _SDK_KEY not in (extra or ""), f"SDK key leaked into a non-log string: {extra!r}"


class TestFetchSuccess:
    def test_200_returns_fetched(self, httpx_mock: HTTPXMock) -> None:
        body = {"f": {"feature.test": {"t": 0, "v": {"b": True}}}}
        httpx_mock.add_response(
            method="GET",
            status_code=200,
            json=body,
            headers={"etag": '"abc-123"'},
        )
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "fetched"
        assert result.body == body
        assert result.etag == '"abc-123"'
        assert result.error is None
        _assert_sdk_key_never_logged(logger)

    def test_url_is_canonical_configcat_shape(self, httpx_mock: HTTPXMock) -> None:
        """The CDN URL MUST be the canonical ConfigCat / Confeature CDN shape:
        ``/configuration-files/{full-sdk-key}/config_v6.json`` — full key
        in the path, NO ``/v2/`` prefix, NO hashed cache-key tail. The
        earlier ``/v2/`` + SHA-256-tail form diverged from every other SDK
        and the Worker; the live canary (#338) surfaced it.
        """
        httpx_mock.add_response(status_code=200, json={"f": {}})
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            fetcher.fetch()
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert _path_of(request) == f"/configuration-files/{_SDK_KEY}/config_v6.json"
        assert "/v2/" not in str(request.url)
        assert "confeature:cache:v1:" not in str(request.url)

    def test_url_appends_sdk_version_query_param(self, httpx_mock: HTTPXMock) -> None:
        """The CDN URL MUST append ``?sdk=<version>`` so the server-side
        deprecation-signal telemetry (#151, on the CDN) can see which SDK
        version made the request. ConfigCat's ``getUrl()`` always appends it
        and sdk-node does too (``?sdk=${CONFEATURE_SDK_VERSION}``); without
        it sdk-python was invisible to that telemetry (#379). Principle II.
        """
        httpx_mock.add_response(status_code=200, json={"f": {}})
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, version="7.7.7-sdk-param")
        try:
            fetcher.fetch()
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert request.url.params.get("sdk") == "7.7.7-sdk-param"
        # The version rides as a query param, not a path segment.
        assert "?sdk=7.7.7-sdk-param" in str(request.url)

    def test_etag_sent_as_if_none_match(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=304)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch(etag='"prev-etag"')
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert request.headers.get("if-none-match") == '"prev-etag"'
        assert result.status == "not_modified"

    def test_user_agent_header_present(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=200, json={"f": {}})
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, version="9.9.9-ua-test")
        try:
            fetcher.fetch()
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert request.headers.get("user-agent") == "confeature-python-sdk/9.9.9-ua-test"


class TestFetchNotModified:
    def test_304_returns_not_modified(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=304, headers={"etag": '"unchanged"'})
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch(etag='"unchanged"')
        finally:
            fetcher.close()

        assert result.status == "not_modified"
        assert result.body is None
        assert result.etag == '"unchanged"'
        _assert_sdk_key_never_logged(logger, result.error or "")


class TestFetchFailure:
    def test_500_returns_failed_with_reason(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=500, text="boom")
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "failed"
        assert result.body is None
        assert result.error == "HTTP 500"
        # The error path MUST have logged at ERROR level.
        assert any(level == "error" for level, _ in logger.records)
        _assert_sdk_key_never_logged(logger, result.error or "")

    def test_timeout_returns_failed_with_exc_name(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("read timed out"))
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "failed"
        assert result.error == "ReadTimeout"
        assert any(level == "error" for level, _ in logger.records)
        _assert_sdk_key_never_logged(logger, result.error or "")

    def test_network_error_returns_failed(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_exception(httpx.ConnectError("dns failure"))
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "failed"
        assert result.error == "ConnectError"
        _assert_sdk_key_never_logged(logger, result.error or "")

    def test_malformed_json_returns_failed(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=200, text="not-json")
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "failed"
        assert result.error == "MALFORMED_JSON"
        _assert_sdk_key_never_logged(logger, result.error or "")

    def test_non_object_json_returns_failed(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_response(status_code=200, json=["array-not-object"])
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result.status == "failed"
        assert result.error == "MALFORMED_JSON"
        _assert_sdk_key_never_logged(logger, result.error or "")


class TestConstructionValidation:
    def test_negative_timeout_raises(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            ConfigFetcher(
                sdk_key=_SDK_KEY,
                version="0.0.0",
                logger=CapturingLogger(),
                request_timeout_seconds=-1.0,
            )

    def test_zero_timeout_raises(self) -> None:
        with pytest.raises(ValueError, match="request_timeout_seconds"):
            ConfigFetcher(
                sdk_key=_SDK_KEY,
                version="0.0.0",
                logger=CapturingLogger(),
                request_timeout_seconds=0,
            )


class TestAsyncFetch:
    async def test_async_200_returns_fetched(self, httpx_mock: HTTPXMock) -> None:
        body: dict[str, Any] = {"f": {}}
        httpx_mock.add_response(status_code=200, json=body)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result: FetchResult = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()

        assert result.status == "fetched"
        assert result.body == body
        _assert_sdk_key_never_logged(logger)

    async def test_async_timeout_returns_failed(self, httpx_mock: HTTPXMock) -> None:
        httpx_mock.add_exception(httpx.ReadTimeout("read timed out"))
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()

        assert result.status == "failed"
        assert result.error == "ReadTimeout"
        _assert_sdk_key_never_logged(logger, result.error or "")


#: A base URL holding ``?`` or ``#`` would move the keyed path out of the
#: path: into the query string (sent, and logged by proxies as a parameter)
#: or the fragment (never sent at all).
_BASES_THAT_MOVE_THE_KEY = [
    "https://cdn.test.confeature.io?",
    "https://cdn.test.confeature.io/?x=1",
    "https://cdn.test.confeature.io#",
    "https://cdn.test.confeature.io/base#frag",
]


class TestBaseUrlKeepsTheKeyInThePath:
    """#803: a base URL with a query or fragment is refused with the fixed
    code ``INVALID_REQUEST`` and nothing is sent, as sdk-dart does."""

    @staticmethod
    def _assert_refused(
        httpx_mock: HTTPXMock, result: FetchResult, logger: CapturingLogger
    ) -> None:
        assert result == FetchResult(status="failed", error="INVALID_REQUEST")
        assert httpx_mock.get_requests() == [], "a request left with the key out of the path"
        assert [level for level, _ in logger.records] == ["error"]
        assert "INVALID_REQUEST" in logger.records[0][1]
        for secret in secrets_of(_SDK_KEY):
            for rendered in logger.rendered:
                assert secret not in rendered, f"log output leaks {secret!r}: {rendered!r}"

    @pytest.mark.parametrize("base_url", _BASES_THAT_MOVE_THE_KEY)
    def test_sync(self, base_url: str, httpx_mock: HTTPXMock) -> None:
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, base_url=base_url)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        self._assert_refused(httpx_mock, result, logger)

    @pytest.mark.parametrize("base_url", _BASES_THAT_MOVE_THE_KEY)
    async def test_async(self, base_url: str, httpx_mock: HTTPXMock) -> None:
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, base_url=base_url)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()
        self._assert_refused(httpx_mock, result, logger)

    def test_a_base_url_with_a_path_is_still_used(self, httpx_mock: HTTPXMock) -> None:
        """Only a query or fragment is refused: a path prefix is kept."""
        httpx_mock.add_response(status_code=200, json={"f": {}})
        fetcher = _make_fetcher(CapturingLogger(), base_url="https://cdn.test.confeature.io/edge/")
        try:
            assert fetcher.fetch().status == "fetched"
        finally:
            fetcher.close()
        request = httpx_mock.get_request()
        assert request is not None
        assert _path_of(request) == f"/edge/configuration-files/{_SDK_KEY}/config_v6.json"


class TestCloseIsIdempotent:
    def test_close_twice_does_not_raise(self) -> None:
        fetcher = _make_fetcher(CapturingLogger())
        fetcher.close()
        fetcher.close()  # second call must be a no-op.


#: Real ``go run`` output of Go's ``url.PathEscape`` (go1.x, net/url) — the
#: FR-001 escaper for a malformed key. Literals, never recomputed with the
#: library call the code uses: the oracle must not borrow the code it judges.
#: #858 swapped the fixture keys' segments for obvious fakes; PathEscape never
#: escapes ``[A-Za-z0-9_-]``, so each swapped segment is its own escaped form.
_GO_PATH_ESCAPE = {
    "bad key$&+:=@,;!'()*~/x?y#z%..": "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
    # One code point of each UTF-8 length (2, 3, 4 bytes; 😀 is outside the BMP).
    "bad key$&+:=@,;!'()*~/x?y#z%é€😀..": (
        "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80.."
    ),
    "bad?key=1#frag/../x": "bad%3Fkey=1%23frag%2F..%2Fx",
    "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3n!/pQ5rS7tU9vW1xY3zA5bC7d": (
        "configcat-sdk-1%2FaB3_-dE5fG7hI9jK1lM3n%21%2FpQ5rS7tU9vW1xY3zA5bC7d"
    ),
    " configcat-sdk-1/FAKEfi--xtureKeyNotR07/FAKEfixtureKeyNotRea08": (
        "%20configcat-sdk-1%2FFAKEfi--xtureKeyNotR07%2FFAKEfixtureKeyNotRea08"
    ),
    "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d\n": (
        "configcat-sdk-1%2FaB3_-dE5fG7hI9jK1lM3nO%2FpQ5rS7tU9vW1xY3zA5bC7d%0A"
    ),
    "configcat-proxy/my-proxy-key": "configcat-proxy%2Fmy-proxy-key",
    "clé-ünï-日本": "cl%C3%A9-%C3%BCn%C3%AF-%E6%97%A5%E6%9C%AC",
    "...": "...",
}


class TestRequestPath:
    """#803 FR-001: one rule for the federation, built in ``ConfigFetcher.url``.

    A well-shaped key travels RAW — exactly configcat python-sdk's
    ``self._base_url + '/' + BASE_PATH + self._sdk_key + BASE_EXTENSION``
    (configcatclient/configfetcher.py:152). Any other key is ONE escaped
    segment, and "", "." and ".." are refused before any request.
    """

    def test_a_well_shaped_key_travels_raw(
        self, httpx_mock: HTTPXMock, sdk_key_shapes: dict[str, list[dict[str, str]]]
    ) -> None:
        for shape in sdk_key_shapes["valid"]:
            httpx_mock.add_response(status_code=200, json={"f": {}})
            fetcher = _make_fetcher(CapturingLogger(), sdk_key=shape["key"])
            try:
                assert fetcher.fetch().status == "fetched", shape["name"]
            finally:
                fetcher.close()
        paths = [_path_of(r) for r in httpx_mock.get_requests()]
        assert paths == [
            f"/configuration-files/{shape['key']}/config_v6.json"
            for shape in sdk_key_shapes["valid"]
        ]

    def test_a_configcat_shaped_key_is_three_segments(self, httpx_mock: HTTPXMock) -> None:
        key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"
        httpx_mock.add_response(status_code=200, json={"f": {}})
        fetcher = _make_fetcher(CapturingLogger(), sdk_key=key)
        try:
            fetcher.fetch()
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert _path_of(request) == (
            "/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/"
            "FAKEfixtureKeyNotRea02/config_v6.json"
        )

    @pytest.mark.parametrize(("key", "go_escaped"), _GO_PATH_ESCAPE.items())
    def test_a_malformed_key_is_one_segment_escaped_as_go(
        self, key: str, go_escaped: str, httpx_mock: HTTPXMock
    ) -> None:
        httpx_mock.add_response(status_code=200, json={"f": {}})
        fetcher = _make_fetcher(CapturingLogger(), sdk_key=key)
        try:
            assert fetcher.fetch().status == "fetched"
        finally:
            fetcher.close()

        request = httpx_mock.get_request()
        assert request is not None
        assert _path_of(request) == f"/configuration-files/{go_escaped}/config_v6.json"
        # Nothing of a malformed key reaches the query: only ?sdk= is there.
        assert set(request.url.params.keys()) == {"sdk"}

    def test_every_malformed_shape_stays_one_segment(
        self, httpx_mock: HTTPXMock, sdk_key_shapes: dict[str, list[dict[str, str]]]
    ) -> None:
        """Every invalid key of the shared shapes file is fetched as exactly
        ONE path segment — whatever its ``/``, whitespace or newline."""
        keys = [shape["key"] for shape in sdk_key_shapes["invalid"] if shape["key"]]
        for key in keys:
            httpx_mock.add_response(status_code=200, json={"f": {}})
            fetcher = _make_fetcher(CapturingLogger(), sdk_key=key)
            try:
                fetcher.fetch()
            finally:
                fetcher.close()
        paths = [_path_of(r) for r in httpx_mock.get_requests()]
        assert len(paths) == len(keys)
        for path in paths:
            assert re.fullmatch(r"/configuration-files/[^/]+/config_v6\.json", path), path

    @pytest.mark.parametrize("key", ["", ".", "..", SURROGATE_KEY], ids=repr)
    def test_a_key_that_cannot_be_one_segment_is_refused(
        self, key: str, httpx_mock: HTTPXMock
    ) -> None:
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=key)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()

        assert result == FetchResult(status="failed", error="INVALID_SDK_KEY")
        assert httpx_mock.get_requests() == []
        assert len(logger.records) == 1
        assert logger.records[0][0] == "error"
        assert "INVALID_SDK_KEY" in logger.records[0][1]

    @pytest.mark.parametrize("key", ["", ".", "..", SURROGATE_KEY], ids=repr)
    async def test_a_refused_key_sends_nothing_async(self, key: str, httpx_mock: HTTPXMock) -> None:
        fetcher = _make_fetcher(CapturingLogger(), sdk_key=key)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()

        assert result == FetchResult(status="failed", error="INVALID_SDK_KEY")
        assert httpx_mock.get_requests() == []


#: The corpus's ``request-path-malformed-key``: no part of it survives its
#: escaping, so only its escaped form betrays it in a log of the keyed URL.
_MALFORMED_LEAK_KEY = "bad key$&+:=@,;!'()*~/x?y#z%é€😀.."

#: A ConfigCat-shaped and a legacy key — both travel in the URL raw — a
#: malformed key, which travels ESCAPED, and a key no URL can carry (refused
#: before any request, never a raised exception).
_LEAK_KEYS = [
    "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d",
    _SDK_KEY,
    _MALFORMED_LEAK_KEY,
    SURROGATE_KEY,
]
_LEAK_KEY_IDS = ["configcat-shaped", "legacy", "malformed", "lone-surrogate"]

#: FR-002: a failure is a fixed code — an HTTP status, a named reason, or the
#: exception's type name — never a library message.
_FIXED_REASON = re.compile(r"^(?:HTTP \d{3}|[A-Z_]+|[A-Za-z]+)$")


def _install_failure(httpx_mock: HTTPXMock, failure: str, key: str) -> None:
    """Each failure carries the URL in its library message, as httpx and
    the transports beneath it do — the message must never get through. The
    URL is the one sent: a malformed key in its Go-escaped form."""
    path_key = _GO_PATH_ESCAPE.get(key, key)
    url = f"https://cdn.test.confeature.io/configuration-files/{path_key}/config_v6.json"
    optional = key == SURROGATE_KEY  # refused: no request ever reaches the mock
    if failure == "timeout":
        httpx_mock.add_exception(
            httpx.ReadTimeout(f"timed out reading {url}"), is_optional=optional
        )
    elif failure == "mid-body reset":

        def _truncated() -> Any:
            yield b'{"f":{'
            raise httpx.RemoteProtocolError(f"peer closed connection mid-body: {url}")

        httpx_mock.add_response(
            status_code=200, stream=IteratorStream(_truncated()), is_optional=optional
        )
    else:  # redirect loop: every response redirects back to the keyed URL.
        httpx_mock.add_response(
            status_code=302,
            headers={"Location": url},
            is_reusable=True,
            is_optional=key == SURROGATE_KEY,
        )


class TestForcedFailuresNeverLeakKey:
    """#803 FR-004: the key now travels in the URL. A forced timeout, a
    mid-body reset and a redirect loop must report a fixed reason and leave
    no part of the key in a log line or ``FetchResult.error``."""

    @pytest.mark.parametrize("key", _LEAK_KEYS, ids=_LEAK_KEY_IDS)
    @pytest.mark.parametrize("failure", ["timeout", "mid-body reset", "redirect loop"])
    def test_sync(self, failure: str, key: str, httpx_mock: HTTPXMock) -> None:
        _install_failure(httpx_mock, failure, key)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=key)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        self._assert_key_free(failure, key, result, logger)

    @pytest.mark.parametrize("key", _LEAK_KEYS, ids=_LEAK_KEY_IDS)
    @pytest.mark.parametrize("failure", ["timeout", "mid-body reset", "redirect loop"])
    async def test_async(self, failure: str, key: str, httpx_mock: HTTPXMock) -> None:
        _install_failure(httpx_mock, failure, key)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=key)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()
        self._assert_key_free(failure, key, result, logger)

    @staticmethod
    def _assert_key_free(
        failure: str, key: str, result: FetchResult, logger: CapturingLogger
    ) -> None:
        assert result.status == "failed", failure
        assert result.error is not None and _FIXED_REASON.match(result.error), result.error
        assert logger.records, f"a {failure} must be logged"
        for secret in secrets_of(key):
            assert secret not in result.error, f"FetchResult.error leaks {secret!r}"
            for rendered in logger.rendered:
                assert secret not in rendered, f"log output leaks {secret!r}: {rendered!r}"

    @pytest.mark.parametrize("failure", ["timeout", "mid-body reset", "redirect loop"])
    def test_the_default_logger_prints_no_key(
        self, failure: str, httpx_mock: HTTPXMock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The shipped ``StderrLogger``, through stdlib ``logging``: the
        formatted output — tracebacks from any ``exc_info`` included — must
        carry no part of the key."""
        key = _LEAK_KEYS[0]
        _install_failure(httpx_mock, failure, key)
        fetcher = _make_fetcher(StderrLogger(LogLevel.DEBUG), sdk_key=key)
        with caplog.at_level(logging.DEBUG, logger="confeature_client"):
            try:
                result = fetcher.fetch()
            finally:
                fetcher.close()
        assert result.status == "failed"
        assert caplog.records, f"a {failure} must be logged"
        for secret in secrets_of(key):
            assert secret not in caplog.text, f"log output leaks {secret!r}"
            for record in caplog.records:
                assert record.exc_info is None, "a library exception reached the log"

    def test_a_redirect_loop_is_followed_then_reported_by_a_fixed_code(
        self, httpx_mock: HTTPXMock
    ) -> None:
        """A real loop: the fetcher follows redirects (as ConfigCat's
        ``requests`` and Go's ``net/http`` do), keeps landing on the keyed
        URL, and gives up with a fixed code — not a 3xx served as a reply."""
        key = _LEAK_KEYS[0]
        _install_failure(httpx_mock, "redirect loop", key)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=key)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        requests = httpx_mock.get_requests()
        assert len(requests) > 1, "the redirect was never followed"
        assert {_path_of(r) for r in requests} == {f"/configuration-files/{key}/config_v6.json"}
        assert result == FetchResult(status="failed", error="TooManyRedirects")
        self._assert_key_free("redirect loop", key, result, logger)

    async def test_a_redirect_loop_is_followed_then_reported_by_a_fixed_code_async(
        self, httpx_mock: HTTPXMock
    ) -> None:
        """The async client follows the same loop and gives up the same way."""
        key = _LEAK_KEYS[0]
        _install_failure(httpx_mock, "redirect loop", key)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=key)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()
        requests = httpx_mock.get_requests()
        assert len(requests) > 1, "the redirect was never followed"
        assert {_path_of(r) for r in requests} == {f"/configuration-files/{key}/config_v6.json"}
        assert result == FetchResult(status="failed", error="TooManyRedirects")
        self._assert_key_free("redirect loop", key, result, logger)

    def test_a_body_decode_error_message_is_not_logged(self, httpx_mock: HTTPXMock) -> None:
        """A JSON decode error is reported by its type, never its message
        (which quotes the body)."""
        httpx_mock.add_response(status_code=200, content=b"\xff\xfe not json")
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        assert result.error == "MALFORMED_JSON"
        assert all("not json" not in m and "\\xff" not in m for m in logger.messages)


class TestLeakOracle:
    """The oracle every key-leak assertion judges with (``tests/_key_leak``)
    must know each form the key can be printed in (#803 review pass 3)."""

    @pytest.mark.parametrize(("key", "go_escaped"), _GO_PATH_ESCAPE.items())
    def test_its_escaper_is_go_path_escape(self, key: str, go_escaped: str) -> None:
        assert go_path_escape(key) == go_escaped

    def test_a_malformed_key_is_searched_for_in_its_request_path_form(self) -> None:
        escaped = _GO_PATH_ESCAPE[_MALFORMED_LEAK_KEY]
        line = f"GET https://cdn.test.confeature.io/configuration-files/{escaped}/config_v6.json"
        assert _MALFORMED_LEAK_KEY not in line  # the raw key alone misses it
        assert any(secret in line for secret in secrets_of(_MALFORMED_LEAK_KEY))

    @pytest.mark.parametrize(
        ("key", "parts"),
        [
            (
                "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d",
                ["aB3_-dE5fG7hI9jK1lM3nO", "pQ5rS7tU9vW1xY3zA5bC7d"],
            ),
            (_SDK_KEY, ["A" * 32, "B" * 32]),
            # Read from an env var: a stray space and newline around the key.
            (f" {_SDK_KEY}\n", ["A" * 32, "B" * 32]),
            (SURROGATE_KEY, ["aB3_-dE5fG7hI9jK1lM3n\udcff", "pQ5rS7tU9vW1xY3zA5bC7d"]),
        ],
        ids=["configcat-shaped", "legacy", "legacy-padded", "lone-surrogate"],
    )
    def test_each_secret_part_of_both_shapes_is_searched_for(
        self, key: str, parts: list[str]
    ) -> None:
        secrets = secrets_of(key)
        assert key in secrets
        for part in parts:
            assert part in secrets, part


#: The keyed path an https origin redirects to over clear-text http.
_DOWNGRADE_KEY = _LEAK_KEYS[0]
_HTTPS_URL = f"https://cdn.test.confeature.io/configuration-files/{_DOWNGRADE_KEY}/config_v6.json"
_HTTP_URL = f"http://cdn.test.confeature.io/configuration-files/{_DOWNGRADE_KEY}/config_v6.json"


def _install_downgrade(httpx_mock: HTTPXMock) -> None:
    """The https URL redirects to the same keyed path over http. The http
    target answers a valid config, so a fetcher that followed the downgrade
    would report ``fetched`` — never a vacuous pass."""
    httpx_mock.add_response(
        url=f"{_HTTPS_URL}?sdk=0.0.0-test", status_code=302, headers={"Location": _HTTP_URL}
    )
    httpx_mock.add_response(url=_HTTP_URL, status_code=200, json={"f": {}}, is_optional=True)


class TestRedirectNeverDowngrades:
    """#803: the URL carries the SDK key, so an https fetch follows only
    https redirects — a downgrade would re-send the key in clear text. The
    http request is never sent; the fetch ends as a fixed code."""

    @staticmethod
    def _assert_refused(
        httpx_mock: HTTPXMock, result: FetchResult, logger: CapturingLogger
    ) -> None:
        assert [str(r.url) for r in httpx_mock.get_requests()] == [
            f"{_HTTPS_URL}?sdk=0.0.0-test"
        ], "the clear-text request was sent"
        assert result == FetchResult(status="failed", error="INSECURE_REDIRECT")
        assert [level for level, _ in logger.records] == ["error"]
        for secret in secrets_of(_DOWNGRADE_KEY):
            for rendered in logger.rendered:
                assert secret not in rendered, f"log output leaks {secret!r}: {rendered!r}"

    def test_sync(self, httpx_mock: HTTPXMock) -> None:
        _install_downgrade(httpx_mock)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=_DOWNGRADE_KEY)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        self._assert_refused(httpx_mock, result, logger)

    async def test_async(self, httpx_mock: HTTPXMock) -> None:
        _install_downgrade(httpx_mock)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=_DOWNGRADE_KEY)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()
        self._assert_refused(httpx_mock, result, logger)

    @staticmethod
    def _install_https_redirect(httpx_mock: HTTPXMock) -> None:
        moved = "https://cdn2.test.confeature.io/configuration-files/moved/config_v6.json"
        httpx_mock.add_response(
            url=f"{_HTTPS_URL}?sdk=0.0.0-test", status_code=301, headers={"Location": moved}
        )
        httpx_mock.add_response(url=moved, status_code=200, json={"f": {}})

    @staticmethod
    def _install_http_origin_redirect(httpx_mock: HTTPXMock) -> None:
        moved = "http://cdn.test.confeature.io/configuration-files/moved/config_v6.json"
        httpx_mock.add_response(
            url=f"{_HTTP_URL}?sdk=0.0.0-test", status_code=302, headers={"Location": moved}
        )
        httpx_mock.add_response(url=moved, status_code=200, json={"f": {}})

    def test_an_https_redirect_is_still_followed(self, httpx_mock: HTTPXMock) -> None:
        """The guard refuses the downgrade only: https -> https is followed."""
        self._install_https_redirect(httpx_mock)
        fetcher = _make_fetcher(CapturingLogger(), sdk_key=_DOWNGRADE_KEY)
        try:
            assert fetcher.fetch().status == "fetched"
        finally:
            fetcher.close()

    async def test_an_https_redirect_is_still_followed_async(self, httpx_mock: HTTPXMock) -> None:
        """The async hook refuses the downgrade only, too."""
        self._install_https_redirect(httpx_mock)
        fetcher = _make_fetcher(CapturingLogger(), sdk_key=_DOWNGRADE_KEY)
        try:
            assert (await fetcher.fetch_async()).status == "fetched"
        finally:
            await fetcher.close_async()

    def test_an_http_origin_follows_an_http_redirect(self, httpx_mock: HTTPXMock) -> None:
        """A clear-text base URL (a local CDN) already sends the key in clear:
        its redirects are not a downgrade, as sdk-cpp's ``http,https``."""
        self._install_http_origin_redirect(httpx_mock)
        fetcher = _make_fetcher(
            CapturingLogger(), sdk_key=_DOWNGRADE_KEY, base_url="http://cdn.test.confeature.io"
        )
        try:
            assert fetcher.fetch().status == "fetched"
        finally:
            fetcher.close()

    async def test_an_http_origin_follows_an_http_redirect_async(
        self, httpx_mock: HTTPXMock
    ) -> None:
        self._install_http_origin_redirect(httpx_mock)
        fetcher = _make_fetcher(
            CapturingLogger(), sdk_key=_DOWNGRADE_KEY, base_url="http://cdn.test.confeature.io"
        )
        try:
            assert (await fetcher.fetch_async()).status == "fetched"
        finally:
            await fetcher.close_async()

    @staticmethod
    def _install_multi_hop_downgrade(httpx_mock: HTTPXMock) -> tuple[str, str]:
        """https -> https on another host -> http: the downgrade is the
        SECOND hop, and leaves the origin's host. A guard judging only the
        first hop, or only a return to the origin's host, lets it through;
        the http target answers a valid config so that shows as ``fetched``."""
        hop = f"https://cdn2.test.confeature.io/configuration-files/{_DOWNGRADE_KEY}/config_v6.json"
        clear = (
            f"http://cdn2.test.confeature.io/configuration-files/{_DOWNGRADE_KEY}/config_v6.json"
        )
        httpx_mock.add_response(
            url=f"{_HTTPS_URL}?sdk=0.0.0-test", status_code=301, headers={"Location": hop}
        )
        httpx_mock.add_response(url=hop, status_code=302, headers={"Location": clear})
        httpx_mock.add_response(url=clear, status_code=200, json={"f": {}}, is_optional=True)
        return f"{_HTTPS_URL}?sdk=0.0.0-test", hop

    @staticmethod
    def _assert_multi_hop_refused(
        httpx_mock: HTTPXMock, sent: tuple[str, str], result: FetchResult, logger: CapturingLogger
    ) -> None:
        assert [str(r.url) for r in httpx_mock.get_requests()] == list(sent), (
            "the clear-text hop was sent"
        )
        assert result == FetchResult(status="failed", error="INSECURE_REDIRECT")
        assert [level for level, _ in logger.records] == ["error"]
        for secret in secrets_of(_DOWNGRADE_KEY):
            for rendered in logger.rendered:
                assert secret not in rendered, f"log output leaks {secret!r}: {rendered!r}"

    def test_a_downgrade_after_an_https_hop_is_refused(self, httpx_mock: HTTPXMock) -> None:
        sent = self._install_multi_hop_downgrade(httpx_mock)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=_DOWNGRADE_KEY)
        try:
            result = fetcher.fetch()
        finally:
            fetcher.close()
        self._assert_multi_hop_refused(httpx_mock, sent, result, logger)

    async def test_a_downgrade_after_an_https_hop_is_refused_async(
        self, httpx_mock: HTTPXMock
    ) -> None:
        sent = self._install_multi_hop_downgrade(httpx_mock)
        logger = CapturingLogger()
        fetcher = _make_fetcher(logger, sdk_key=_DOWNGRADE_KEY)
        try:
            result = await fetcher.fetch_async()
        finally:
            await fetcher.close_async()
        self._assert_multi_hop_refused(httpx_mock, sent, result, logger)
