# SPDX-License-Identifier: MIT
"""The failure branches of ``assert_wire_case`` — the paths no green corpus
run reaches, so without these they are proven only by a one-off mutation
(#783 review). Each asserts the assertion REFUSES, never that it passes."""

from __future__ import annotations

import json
from typing import Any

import pytest

from confeature_client.config_fetcher import FetchResult

from . import _wire_case_assertions as wca
from ._wire_case_assertions import CapturedRequest, assert_wire_case, python_error_to_class

_KEY = "case-key"
_VERSION = "1.2.3"
_REQUEST = CapturedRequest(
    url=f"https://cdn.test/configuration-files/{_KEY}/config_v6.json?sdk={_VERSION}",
    if_none_match=None,
)


def _case(expected: dict[str, Any], given: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": "synthetic",
        "given": given if given is not None else {"previousEtag": None},
        "server": {},
        "expected": expected,
    }


@pytest.mark.parametrize(
    ("error", "klass"),
    [
        ("MALFORMED_JSON", "parseFailed"),
        ("HTTP 403", "invalidSdkKey"),
        ("HTTP 404", "invalidSdkKey"),
        ("HTTP 500", "fetchFailed"),
        ("ReadTimeout", "timeout"),
        ("TimeoutException", "timeout"),
        ("RemoteProtocolError", "fetchFailed"),
        ("ConnectError", "fetchFailed"),
    ],
)
def test_known_errors_map_to_their_class(error: str, klass: str) -> None:
    assert python_error_to_class(error) == klass


@pytest.mark.parametrize("error", [None, "KeyError", "ValueError", "Client", ""])
def test_an_unknown_error_maps_to_no_corpus_class(error: str | None) -> None:
    assert python_error_to_class(error).startswith("unmapped:")


def test_an_unknown_error_fails_a_fetch_failed_case() -> None:
    case = _case({"outcome": "failed", "errorClass": "fetchFailed"})
    with pytest.raises(AssertionError, match="unmapped"):
        assert_wire_case(
            case, FetchResult(status="failed", error="KeyError"), _REQUEST, _KEY, _VERSION
        )


def test_an_unknown_corpus_outcome_fails() -> None:
    with pytest.raises(pytest.fail.Exception, match="unmapped corpus outcome"):
        assert_wire_case(
            _case({"outcome": "bogus"}), FetchResult(status="failed"), _REQUEST, _KEY, _VERSION
        )


def test_an_invented_etag_fails_when_the_corpus_expects_none() -> None:
    case = _case({"outcome": "notModified", "resultingEtag": None})
    with pytest.raises(AssertionError, match="resulting ETag"):
        assert_wire_case(
            case, FetchResult(status="not_modified", etag='"x"'), _REQUEST, _KEY, _VERSION
        )


def test_a_request_without_the_sdk_param_fails() -> None:
    request = CapturedRequest(url=_REQUEST.url.split("?")[0], if_none_match=None)
    case = _case({"outcome": "failed", "errorClass": "fetchFailed"})
    with pytest.raises(AssertionError, match=r"\?sdk="):
        assert_wire_case(
            case, FetchResult(status="failed", error="HTTP 500"), request, _KEY, _VERSION
        )


def test_a_request_with_another_sdk_version_fails() -> None:
    request = CapturedRequest(url=_REQUEST.url.replace(_VERSION, "9.9.9"), if_none_match=None)
    case = _case({"outcome": "failed", "errorClass": "fetchFailed"})
    with pytest.raises(AssertionError, match=r"\?sdk="):
        assert_wire_case(
            case, FetchResult(status="failed", error="HTTP 500"), request, _KEY, _VERSION
        )


def test_a_known_sdk_bug_is_a_strict_expected_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(wca.KNOWN_SDK_BUGS, "synthetic", "#000")
    (mark,) = wca.mark_for("synthetic")
    assert mark.name == "xfail"
    assert mark.kwargs["strict"] is True
    assert wca.mark_for("not-a-bug") == []


_FAILED = {"outcome": "failed", "errorClass": "fetchFailed"}
_HTTP_500 = FetchResult(status="failed", error="HTTP 500")


@pytest.mark.parametrize(
    ("given", "expected", "field"),
    [
        ({"previousEtag": None, "newKnob": 1}, _FAILED, "given fields"),
        ({"previousEtag": None}, {**_FAILED, "requestQuery": "?a"}, "expected fields"),
    ],
)
def test_an_unknown_corpus_field_fails(
    given: dict[str, Any], expected: dict[str, Any], field: str
) -> None:
    """#803 FR-003: a field this reader does not read is a failure, never a
    silently skipped expectation."""
    with pytest.raises(AssertionError, match=field):
        assert_wire_case(_case(expected, given), _HTTP_500, _REQUEST, _KEY, _VERSION)


def test_a_suite_that_ignored_given_sdk_key_fails() -> None:
    case = _case(_FAILED, {"previousEtag": None, "sdkKey": "pinned-key"})
    with pytest.raises(AssertionError, match=r"given\.sdkKey"):
        assert_wire_case(case, _HTTP_500, _REQUEST, _KEY, _VERSION)


def test_a_path_other_than_request_path_fails() -> None:
    case = _case({**_FAILED, "requestPath": "/configuration-files/other/config_v6.json"})
    with pytest.raises(AssertionError, match="request path"):
        assert_wire_case(case, _HTTP_500, _REQUEST, _KEY, _VERSION)


def test_a_configcat_shaped_key_escaped_into_one_segment_fails() -> None:
    """FR-001: a well-shaped key travels raw; ``%2F`` is the old, wrong path."""
    key = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"
    escaped = key.replace("/", "%2F")
    request = CapturedRequest(
        url=f"https://cdn.test/configuration-files/{escaped}/config_v6.json?sdk={_VERSION}",
        if_none_match=None,
    )
    with pytest.raises(AssertionError, match="request path"):
        assert_wire_case(_case(_FAILED), _HTTP_500, request, key, _VERSION)


def test_a_key_that_needs_escaping_must_have_its_path_pinned() -> None:
    """The oracle predicts no escaped path itself (it would borrow the code's
    escaper): a case whose key needs escaping and pins no requestPath fails."""
    key = "bad key/x"
    request = CapturedRequest(
        url=f"https://cdn.test/configuration-files/bad%20key%2Fx/config_v6.json?sdk={_VERSION}",
        if_none_match=None,
    )
    with pytest.raises(AssertionError, match=r"must pin expected\.requestPath"):
        assert_wire_case(_case(_FAILED), _HTTP_500, request, key, _VERSION)


def test_the_malformed_key_case_is_judged_by_the_corpus_literal() -> None:
    """``request-path-malformed-key``: the path comes from the corpus — real
    ``url.PathEscape`` output — and a lenient escaping of the same key fails."""
    (case,) = [c for c in wca.load_corpus() if c["id"] == "request-path-malformed-key"]
    key = case["given"]["sdkKey"]
    # A fetched case compares the body to its bodyRef: hand it that fixture.
    with (wca.FIXTURES_DIR / case["server"]["bodyRef"]).open() as fh:
        fetched = FetchResult(
            status="fetched", body=json.load(fh), etag=case["expected"]["resultingEtag"]
        )
    good = CapturedRequest(
        url=f"https://cdn.test{case['expected']['requestPath']}?sdk={_VERSION}",
        if_none_match=None,
    )
    assert_wire_case(case, fetched, good, key, _VERSION)
    # Python's default quote() keeps '/' and escapes Go's sub-delims: wrong.
    lenient = "bad%20key%24%26%2B%3A%3D%40%2C%3B%21%27%28%29%2A~/x%3Fy%23z%25.."
    bad = CapturedRequest(
        url=f"https://cdn.test/configuration-files/{lenient}/config_v6.json?sdk={_VERSION}",
        if_none_match=None,
    )
    with pytest.raises(AssertionError, match="request path"):
        assert_wire_case(case, fetched, bad, key, _VERSION)
