# SPDX-License-Identifier: MIT
"""What a corpus ``expected`` block means for sdk-python (#783, decision row 6).

ONE implementation, called by the hermetic suite (``test_wire_cases.py``,
mocked httpx) AND the live runner (``test_wire_cases_live.py``, real HTTP
against the harness), so both are judged by the same rules. The request is
passed in SDK-neutral form: the hermetic suite builds it from the mock, the
live runner from the harness's ``GET /admin/requests``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

from confeature_client.config_fetcher import FetchResult
from confeature_client.logger import Logger

# apps/sdk-python/tests/wire/_wire_case_assertions.py → workspace root is parents[4].
_WORKSPACE_ROOT: Path = Path(__file__).resolve().parents[4]
FIXTURES_DIR: Path = _WORKSPACE_ROOT / "packages" / "test-fixtures-sdk-parity" / "fixtures"

# Known sdk-python bugs, as STRICT expected failures: case id -> ticket.
# ``xfail(strict=True)`` turns red the moment the bug is fixed, so an entry can
# never outlive its reason. Cases that cannot be seeded at all live in the
# harness's NOT_REPRESENTABLE instead — this list is for SDK defects only.
KNOWN_SDK_BUGS: dict[str, str] = {}


#: Every ``given`` / ``expected`` field this reader understands (schema 1.3).
#: A corpus field outside these sets FAILS the case (#803 FR-003): the next
#: expectation added to the corpus cannot be skipped silently by a reader
#: that predates it — which is how the native suites ignored
#: ``requestUrlPrefix`` and #803 went unseen. Add a field here only together
#: with the code that reads it.
KNOWN_GIVEN_FIELDS = frozenset({"previousEtag", "baseUrl", "sdkKey"})
KNOWN_EXPECTED_FIELDS = frozenset(
    {
        "requestHeaderIfNoneMatch",
        "outcome",
        "resultingEtag",
        "errorClass",
        "hasConfig",
        "requestUrlPrefix",
        "requestPath",
    }
)

# FR-001's "well-shaped" — a ConfigCat-shaped or a legacy key. Written here,
# not imported from confeature_client: the oracle must not borrow the code it
# judges.
_WELL_SHAPED_KEY = re.compile(
    r"(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}"
    r"|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})"
)


def sdk_key_for(case: dict[str, Any], default_key: str) -> str:
    """The key a suite must configure its SDK with: the corpus's
    ``given.sdkKey`` when the case pins one, else the suite's own default.
    ``assert_wire_case`` fails when it is handed any other key."""
    key = case["given"].get("sdkKey", default_key)
    assert isinstance(key, str)
    return key


#: Characters every escaper keeps (RFC 3986 unreserved): a key made only of
#: them is its own escaped form, so its path needs no escaper to predict.
_PLAIN_SEGMENT = re.compile(r"[A-Za-z0-9._~-]+")


def fr001_path(sdk_key: str) -> str:
    """FR-001 (#803): the path an SDK requests for ``sdk_key`` when a case
    pins no ``expected.requestPath`` — the key's own bytes. That holds for a
    well-shaped key (FR-001 sends it raw) and for one made only of unreserved
    characters (no escaper changes them, ``.``/``..`` aside). Any other key
    needs an escaper to predict its path, and the oracle borrows none: such a
    case must pin ``expected.requestPath`` (real ``url.PathEscape`` output,
    as ``request-path-malformed-key`` does)."""
    plain = _PLAIN_SEGMENT.fullmatch(sdk_key) and sdk_key not in (".", "..")
    assert _WELL_SHAPED_KEY.fullmatch(sdk_key) or plain, (
        f"key {sdk_key!r} needs escaping: its case must pin expected.requestPath"
    )
    return f"/configuration-files/{sdk_key}/config_v6.json"


def load_corpus() -> list[dict[str, Any]]:
    with (FIXTURES_DIR / "wire-cases.json").open() as fh:
        return json.load(fh)["cases"]


def python_error_to_class(error: str | None) -> str:
    """Map Python's stringly-typed ``FetchResult.error`` onto the corpus's
    normalised error-class vocabulary. HTTP 403 and 404 BOTH map to
    ``invalidSdkKey`` — ConfigCat parity (configcat-js classes them together
    as "your SDK Key seems to be wrong"; #336).

    An error this function does not know maps to ``unmapped:<error>``, which
    matches no corpus class — so it FAILS, like an unmapped ``errorCode`` in
    the TS ``assertWireCase``. Folding the unknown into ``fetchFailed`` would
    let any unexpected failure pass every fetchFailed case."""
    if error == "MALFORMED_JSON":
        return "parseFailed"
    if error in ("HTTP 403", "HTTP 404"):
        return "invalidSdkKey"
    if error is not None and error.startswith("HTTP "):
        return "fetchFailed"
    # Anything else is an exception's type name (``_handle_exception``).
    exc_type = getattr(httpx, error, None) if error else None
    if isinstance(exc_type, type) and issubclass(exc_type, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc_type, type) and issubclass(exc_type, httpx.TransportError):
        return "fetchFailed"
    return f"unmapped:{error!r}"


class SilentLogger(Logger):
    """Drops every record: the wire suites judge outcomes, not log content
    (the config-fetcher unit tests hold the no-SDK-key-leak invariant)."""

    def error(self, message: str) -> None: ...

    def warning(self, message: str) -> None: ...

    def info(self, message: str) -> None: ...

    def debug(self, message: str) -> None: ...


@dataclass(frozen=True)
class CapturedRequest:
    """The request the SDK sent: absolute (hermetic) or path + query (live)."""

    url: str
    if_none_match: str | None


def mark_for(case_id: str) -> Any:
    """``pytest.param`` marks for a case: strict xfail when it is a known bug."""
    ticket = KNOWN_SDK_BUGS.get(case_id)
    return [pytest.mark.xfail(strict=True, reason=ticket)] if ticket else []


def _sdk_param(url: str) -> str | None:
    """The raw ``sdk`` query value of a request URL (absolute or path + query)."""
    query = url.split("?", 1)[1] if "?" in url else ""
    for pair in query.split("&"):
        if pair.startswith("sdk="):
            return pair[len("sdk=") :]
    return None


def assert_wire_case(
    case: dict[str, Any],
    result: FetchResult,
    request: CapturedRequest,
    sdk_key: str,
    sdk_version: str,
) -> None:
    case_id = case["id"]
    expected = case["expected"]
    given = case["given"]

    # ---- Fail closed on what this reader does not know (#803 FR-003) -----
    unknown_given = sorted(set(given) - KNOWN_GIVEN_FIELDS)
    assert not unknown_given, f"{case_id}: given fields this reader does not read: {unknown_given}"
    unknown_expected = sorted(set(expected) - KNOWN_EXPECTED_FIELDS)
    assert not unknown_expected, (
        f"{case_id}: expected fields this reader does not read: {unknown_expected}"
    )
    if "sdkKey" in given:
        # The suite, not this function, configures the SDK: a suite that
        # ignored given.sdkKey would make the path check below vacuous.
        assert sdk_key == given["sdkKey"], (
            f"{case_id}: the SDK must be configured with given.sdkKey"
        )

    # ---- Request side (the same checks as the TS assertWireCase) ---------
    # The parsed path as sent (still escaped, query excluded — #807 may add
    # one), compared EXACTLY: the corpus's requestPath when the case pins one
    # (its single home), else FR-001's path for the suite's key.
    want_path = expected.get("requestPath") or fr001_path(sdk_key)
    path = urlsplit(request.url).path
    assert path == want_path, f"{case_id}: request path {path!r} != {want_path!r}"
    assert "/v2/" not in request.url, f"{case_id}: legacy /v2/ path {request.url!r}"
    # A plain version is its own escaped form: compared as is, no escaper.
    assert _PLAIN_SEGMENT.fullmatch(sdk_version), f"suite version {sdk_version!r} is not plain"
    assert _sdk_param(request.url) == sdk_version, (
        f"{case_id}: ?sdk= param in {request.url!r} is not {sdk_version!r}"
    )
    url_prefix = expected.get("requestUrlPrefix")
    if url_prefix is not None:
        assert request.url.startswith(url_prefix), (
            f"{case_id}: request URL {request.url!r} did not start with {url_prefix!r}"
        )
    if "requestHeaderIfNoneMatch" in expected:
        assert request.if_none_match == expected["requestHeaderIfNoneMatch"], (
            f"{case_id}: If-None-Match {request.if_none_match!r} != "
            f"{expected['requestHeaderIfNoneMatch']!r}"
        )

    # ---- Outcome side -----------------------------------------------------
    if "hasConfig" in expected:
        has_config = result.status == "fetched" and result.body is not None
        assert has_config == expected["hasConfig"], f"{case_id}: hasConfig"
    outcome = expected["outcome"]
    if outcome == "fetched":
        assert result.status == "fetched", (
            f"{case_id}: expected 'fetched', got {result.status!r} (error={result.error!r})"
        )
        assert result.body is not None
        assert result.etag == expected.get("resultingEtag"), f"{case_id}: resulting ETag"
        # Content, not presence: a fetched case with a bodyRef must yield
        # exactly that fixture.
        ref = case["server"].get("bodyRef")
        if ref:
            with (FIXTURES_DIR / ref).open() as fh:
                assert result.body == json.load(fh), f"{case_id}: config is not {ref}"
    elif outcome == "notModified":
        # The corpus is camelCase; Python's status is snake_case.
        assert result.status == "not_modified", (
            f"{case_id}: expected 'not_modified', got {result.status!r} (error={result.error!r})"
        )
        assert result.etag == expected.get("resultingEtag"), f"{case_id}: resulting ETag"
    elif outcome == "failed":
        assert result.status == "failed", (
            f"{case_id}: expected 'failed', got {result.status!r} (body={result.body!r})"
        )
        mapped = python_error_to_class(result.error)
        assert mapped == expected["errorClass"], (
            f"{case_id}: expected errorClass={expected['errorClass']!r}, "
            f"got {mapped!r} from raw error={result.error!r}"
        )
    else:
        pytest.fail(f"{case_id}: unmapped corpus outcome {outcome!r}")
