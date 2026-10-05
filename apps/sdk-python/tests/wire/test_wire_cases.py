# SPDX-License-Identifier: MIT
"""Wire-protocol fixture suite (Python consumer).

Drives ``confeature_client.config_fetcher.ConfigFetcher`` against each
case in ``packages/test-fixtures-sdk-parity/fixtures/wire-cases.json``.
The corpus is the language-agnostic contract; this file is the Python
consumer that maps Python's ``FetchResult`` shape onto the corpus's
normalised ``{fetched, notModified, failed}`` x ``{fetchFailed,
timeout, parseFailed, invalidSdkKey}`` vocabulary.

The Python SDK encodes its failure reason as a string in
``FetchResult.error`` rather than a typed enum (sdk-node has
``SdkErrorCode``; this maps the string form back to the same
vocabulary). When a future revision of ``ConfigFetcher`` switches to a
typed enum, update ``python_error_to_class`` in ``_wire_case_assertions.py``.

See epic #146 (contract testing framework) + #148 (this suite).
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from pytest_httpx import HTTPXMock, IteratorStream

from confeature_client.config_fetcher import ConfigFetcher, FetchResult

from ._wire_case_assertions import (
    FIXTURES_DIR,
    CapturedRequest,
    SilentLogger,
    assert_wire_case,
    load_corpus,
    mark_for,
    sdk_key_for,
)

_SDK_VERSION = "0.0.0-wire-test"
#: The key for a case that pins no ``given.sdkKey`` (a well-shaped legacy key).
_DEFAULT_SDK_KEY = (
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)


_CASES: list[dict[str, Any]] = load_corpus()


def _resolve_body(server: dict[str, Any]) -> str | None:
    """Resolve the server response body — bodyRef points to a sibling
    fixture JSON; body is a raw string (used for malformed payloads)."""
    if server.get("bodyRef"):
        ref_path = FIXTURES_DIR / server["bodyRef"]
        return ref_path.read_text(encoding="utf-8")
    return server.get("body")


def _install_mock(httpx_mock: HTTPXMock, server: dict[str, Any]) -> None:
    """Install the mock transport for a case based on ``server.behavior``
    (#490) — the Python behaviour adapter (mirror of the JS buildFetchSpy):

    - ``respond`` (default) → a mocked Response with status/headers/body;
    - ``timeout`` → an ``httpx.TimeoutException`` (ConfigFetcher surfaces a
      "Timeout"-bearing reason → ``timeout``);
    - ``close-mid-response`` → an ``httpx.RemoteProtocolError`` (mapped to
      ``fetchFailed`` — a transport failure, NOT ``parseFailed``: a
      truncated body is not a JSON-shape error).

    An unrecognised behaviour FAILS LOUDLY — it MUST NEVER fall through to
    the respond path and silently mis-pass (FR-008 anti-false-green guard;
    mirrors the JS adapters' `throw`).
    """
    behavior = server.get("behavior", "respond")
    if behavior == "respond":
        body_text = _resolve_body(server)
        add_kwargs: dict[str, Any] = {
            "method": "GET",
            "status_code": server["status"],
            "headers": dict(server.get("headers", {})),
        }
        if body_text is not None:
            add_kwargs["content"] = body_text.encode("utf-8")
        httpx_mock.add_response(**add_kwargs)
    elif behavior == "timeout":
        httpx_mock.add_exception(httpx.TimeoutException("simulated request timeout"))
    elif behavior == "close-mid-response":
        # Faithful mid-response reset: deliver a 200 + headers and START the
        # body, then drop the connection mid-stream. httpx raises
        # RemoteProtocolError during the body read → ConfigFetcher maps it
        # to fetchFailed (a transport failure, NOT parseFailed — a truncated
        # body is not a JSON-shape error). Mirrors the JS ReadableStream that
        # errors mid-read.
        def _truncated_body() -> Iterator[bytes]:
            yield b'{"p":{"s":"partial'
            raise httpx.RemoteProtocolError("peer closed connection mid-response")

        httpx_mock.add_response(
            status_code=server["status"],
            headers=dict(server.get("headers", {})),
            stream=IteratorStream(_truncated_body()),
        )
    else:
        pytest.fail(
            f"wire-cases: unsupported server.behavior {behavior!r} — no Python adapter; "
            "refusing to fall through to the respond path"
        )


@pytest.mark.parametrize(
    "case", [pytest.param(c, id=c["id"], marks=mark_for(c["id"])) for c in _CASES]
)
def test_wire_case(case: dict[str, Any], httpx_mock: HTTPXMock) -> None:
    given = case["given"]
    server = case["server"]

    # Wire up the mock transport per server.behavior (#490). pytest-httpx
    # intercepts every outbound httpx call so the test never touches the
    # network.
    _install_mock(httpx_mock, server)

    # Honour a per-case custom base URL (custom-base-url case, #336);
    # fall back to the default test CDN host otherwise.
    base_url = given.get("baseUrl") or "https://cdn.test.confeature.io"
    sdk_key = sdk_key_for(case, _DEFAULT_SDK_KEY)
    fetcher = ConfigFetcher(
        sdk_key=sdk_key,
        version=_SDK_VERSION,
        logger=SilentLogger(),
        base_url=base_url,
        request_timeout_seconds=1.0,
    )
    try:
        result: FetchResult = fetcher.fetch(etag=given["previousEtag"])
    finally:
        fetcher.close()

    # ---- Request + outcome assertions: one shared definition (#783) --------
    request = httpx_mock.get_request()
    assert request is not None, "Fetcher MUST issue exactly one HTTP request"
    # ``raw_path`` is the request-line target httpcore writes on the wire
    # (path + query, escaped as sent) — not a re-rendering of the URL.
    origin = f"{request.url.scheme}://{request.url.netloc.decode('ascii')}"
    assert_wire_case(
        case,
        result,
        CapturedRequest(
            url=origin + request.url.raw_path.decode("ascii"),
            if_none_match=request.headers.get("if-none-match"),
        ),
        sdk_key,
        _SDK_VERSION,
    )


#: The cases that pin the request path (#803 FR-001): a mock judges the
#: request httpx hands it, so these are ALSO run against a real socket.
_PATH_CASES = [c for c in _CASES if "requestPath" in c["expected"] or "sdkKey" in c["given"]]


class _RawRecorder:
    """A one-shot HTTP/1.1 server on a real socket: it records the request
    line exactly as the bytes arrived and answers the case's response, then
    closes. Nothing parses or decodes the target before it is judged."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.request_line: bytes | None = None
        self.accept_error: TimeoutError | None = None
        self.headers: dict[str, str] = {}
        self._listener = socket.create_server(("127.0.0.1", 0))
        self._listener.settimeout(5)
        reason = {200: "OK", 304: "Not Modified"}.get(status, "Status")
        head = [f"HTTP/1.1 {status} {reason}", f"Content-Length: {len(body)}", "Connection: close"]
        head += [f"{name}: {value}" for name, value in headers.items()]
        self._reply = ("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body
        self._thread = threading.Thread(target=self._serve_once, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._listener.getsockname()[1]}"

    def _serve_once(self) -> None:
        try:
            conn, _ = self._listener.accept()
        except TimeoutError as exc:
            # No request came: kept, and reported by the test's assertion.
            self.accept_error = exc
            return
        with conn:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            head = data.split(b"\r\n\r\n", 1)[0].split(b"\r\n")
            self.request_line = head[0]
            for line in head[1:]:
                name, _, value = line.decode("latin-1").partition(":")
                self.headers[name.strip().lower()] = value.strip()
            conn.sendall(self._reply)

    def close(self) -> None:
        self._thread.join(timeout=5)
        self._listener.close()


@pytest.mark.parametrize("case", [pytest.param(c, id=c["id"]) for c in _PATH_CASES])
def test_wire_case_on_a_real_socket(case: dict[str, Any]) -> None:
    """Brief item 4: the bytes ON THE WIRE, not the string the SDK built nor
    the request a mock was handed. The request-line target must equal the
    corpus ``expected.requestPath`` byte for byte (``request-path-malformed-key``
    carries é€😀: escaped by their UTF-8 bytes)."""
    server = case["server"]
    assert server.get("behavior", "respond") == "respond", case["id"]
    body = (_resolve_body(server) or "").encode("utf-8")
    recorder = _RawRecorder(server["status"], dict(server.get("headers", {})), body)
    base_url = recorder.base_url
    sdk_key = sdk_key_for(case, _DEFAULT_SDK_KEY)
    fetcher = ConfigFetcher(
        sdk_key=sdk_key,
        version=_SDK_VERSION,
        logger=SilentLogger(),
        base_url=base_url,
        request_timeout_seconds=5.0,
    )
    try:
        result = fetcher.fetch(etag=case["given"]["previousEtag"])
    finally:
        fetcher.close()
        recorder.close()

    assert recorder.request_line is not None, (
        f"no request reached the socket ({recorder.accept_error!r}; result={result!r})"
    )
    method, target, version = recorder.request_line.split(b" ")
    assert (method, version) == (b"GET", b"HTTP/1.1")
    if "requestPath" in case["expected"]:
        assert target.split(b"?", 1)[0] == case["expected"]["requestPath"].encode("ascii")
    assert_wire_case(
        case,
        result,
        CapturedRequest(
            url=base_url + target.decode("ascii"),
            if_none_match=recorder.headers.get("if-none-match"),
        ),
        sdk_key,
        _SDK_VERSION,
    )
