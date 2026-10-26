# SPDX-License-Identifier: MIT
"""HTTP layer for fetching `config_v6.json` from a Confeature CDN.

Wraps `httpx.Client` + `httpx.AsyncClient` with:
  - User-Agent: `confeature-python-sdk/{__version__}` (FR-006).
  - If-None-Match support for 304 reuse (FR-005).
  - Configurable request timeout (default 30s, FR-007).
  - SDK key redaction in every log line (FR-008): the raw key is NEVER
    interpolated into messages; `redact_sdk_key` is the only path. The
    request URL carries the key (ConfigCat's wire protocol), so a failure
    is reported by a fixed code or an exception's TYPE name — never a
    library message, which may quote the URL (#803 FR-002).

`FetchResult.status` is one of:
  - "fetched": HTTP 200, fresh body + new ETag.
  - "not_modified": HTTP 304, caller keeps its cached body.
  - "failed": network error / non-2xx / timeout / refused key / refused
    base URL / refused https -> http redirect. `error` is ``HTTP <status>``,
    ``MALFORMED_JSON``, ``INVALID_SDK_KEY``, ``INVALID_REQUEST``,
    ``INSECURE_REDIRECT`` or an exception's type name — never carrying the
    SDK key.
"""

from __future__ import annotations

import dataclasses
from typing import Any, Literal
from urllib.parse import quote

import httpx

from . import _httpx_log_guard
from .logger import Logger
from .sdk_key import is_utf8_encodable, is_valid_confeature_key_format, redact_sdk_key

FetchStatus = Literal["fetched", "not_modified", "failed"]

#: Keys no escaper keeps inside their path segment: they collapse it or
#: climb out of it (#803 FR-001). The fetcher refuses to request them.
_UNSEGMENTABLE_KEYS = frozenset({"", ".", ".."})

#: What Go's ``url.PathEscape`` keeps besides ``quote``'s always-safe
#: ``A-Z a-z 0-9 _ . - ~``: the sub-delims ``$ & + : = @`` (#803 FR-001).
#: Every other byte of the key's UTF-8 becomes ``%XX``, uppercase.
_GO_PATH_SEGMENT_SAFE = "$&+:=@"


def _path_escape(segment: str) -> str:
    """Escape ``segment`` into ONE URL path segment, byte for byte as Go's
    ``url.PathEscape`` — the federation's single escaper (#803 FR-001), so
    every SDK requests the same path for the same malformed key. The caller
    guarantees ``segment`` is UTF-8 encodable."""
    return quote(segment, safe=_GO_PATH_SEGMENT_SAFE)


class _InsecureRedirect(Exception):
    """Raised by the request hook to stop an https -> http redirect hop.

    Carries no message — nothing of the URL, so nothing of the key; the
    fetch turns it into the fixed code ``INSECURE_REDIRECT``."""


@dataclasses.dataclass(frozen=True)
class FetchResult:
    """Outcome of a `ConfigFetcher.fetch[_async]` call."""

    status: FetchStatus
    body: dict[str, Any] | None = None
    etag: str | None = None
    error: str | None = None


class ConfigFetcher:
    """HTTP-backed config fetcher with sync + async surfaces.

    The fetcher holds two `httpx` client objects (one sync, one async)
    so customers in either world get connection pooling without
    cross-paradigm gymnastics. `close()` shuts both down.
    """

    DEFAULT_BASE_URL = "https://cdn-global.confeature.io"

    def __init__(
        self,
        sdk_key: str,
        version: str,
        logger: Logger,
        base_url: str | None = None,
        request_timeout_seconds: float = 30.0,
    ) -> None:
        if request_timeout_seconds <= 0:
            raise ValueError(
                f"request_timeout_seconds must be > 0; got {request_timeout_seconds!r}."
            )
        self._sdk_key = sdk_key
        self._version = version
        self._logger = logger
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self._timeout = httpx.Timeout(timeout=request_timeout_seconds)
        self._user_agent = f"confeature-python-sdk/{version}"
        self._headers_base: dict[str, str] = {
            "User-Agent": self._user_agent,
            "Accept": "application/json",
        }
        self._sync_client: httpx.Client | None = None
        self._async_client: httpx.AsyncClient | None = None
        # httpx logs each request URL — the keyed one — at INFO (#835).
        _httpx_log_guard.install()

    @property
    def url(self) -> str | None:
        """The full CDN URL every fetch targets, or None when the key is refused.

        The ONE place the URL is built (#803 FR-001), so the version carrier
        (#807) lands here only. ConfigCat's shape —
        ``{base_url}/configuration-files/{sdk_key}/config_v6.json``, no
        version prefix, no hash of the key — which the CDN routes:

        - a well-shaped key (``is_valid_confeature_key_format``) travels RAW:
          its ``/``-separated parts each escaped (a no-op for a valid key),
          exactly configcat python-sdk's bytes
          (``configcatclient/configfetcher.py:152``). A ConfigCat-shaped key
          is three segments, the CDN's own route for it;
        - any other key is escaped into ONE segment (runtime is lenient) by
          Go's ``url.PathEscape`` rule, so a ``/``, ``?`` or ``#`` in it
          cannot leave it (``eval.ts:123``);
        - ``""``, ``"."`` and ``".."`` cannot be one segment, and a key that
          is not UTF-8 encodable (a lone surrogate) cannot be in a URL at
          all: None, no fetch — never a ``UnicodeEncodeError``, whose repr
          holds the whole key.

        ``?sdk=<version>`` carries the SDK version to the CDN's
        deprecation-signal telemetry (#151), as ConfigCat's ``getUrl()`` and
        sdk-node do (#379); ``quote(safe="")`` is defensive against a
        malformed version override.
        """
        if self._sdk_key in _UNSEGMENTABLE_KEYS or not is_utf8_encodable(self._sdk_key):
            return None
        if is_valid_confeature_key_format(self._sdk_key):
            key_path = "/".join(_path_escape(part) for part in self._sdk_key.split("/"))
        else:
            key_path = _path_escape(self._sdk_key)
        return (
            f"{self._base_url}/configuration-files/{key_path}/config_v6.json"
            f"?sdk={quote(self._version, safe='')}"
        )

    def _target(self) -> str | FetchResult:
        """The URL a fetch requests, or the fixed-code refusal that sends
        nothing.

        A base URL holding ``?`` or ``#`` would move the keyed path out of
        the path: into the query string — sent, and logged by proxies as a
        parameter — or the fragment, never sent at all. The key path never
        holds a raw ``?`` or ``#`` (a well-shaped key has none, the escaper
        escapes them), so the base URL is the only place one can come from;
        it is refused as ``INVALID_REQUEST``, as sdk-dart does (#803)."""
        url = self.url
        if url is None:
            return self._refuse()
        if "?" in self._base_url or "#" in self._base_url:
            return self._refuse_base_url()
        return url

    def _build_headers(self, etag: str | None) -> dict[str, str]:
        headers = dict(self._headers_base)
        if etag:
            headers["If-None-Match"] = etag
        return headers

    # Redirects are followed, as configcat python-sdk's ``requests.get`` and
    # Go's ``net/http`` do — but never from https down to http (see
    # ``_refuse_downgrade``). A loop ends in ``TooManyRedirects``, reported by
    # its type name like every other transport failure.
    def _sync(self) -> httpx.Client:
        if self._sync_client is None:
            self._sync_client = httpx.Client(
                timeout=self._timeout,
                follow_redirects=True,
                event_hooks={"request": [self._refuse_downgrade]},
            )
        return self._sync_client

    def _async(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(
                timeout=self._timeout,
                follow_redirects=True,
                event_hooks={"request": [self._refuse_downgrade_async]},
            )
        return self._async_client

    def _refuse_downgrade(self, request: httpx.Request) -> None:
        """An https fetch follows only https redirects (#803), as sdk-cpp's
        ``CURLOPT_REDIR_PROTOCOLS``: the URL carries the SDK key, and a
        redirect to http would re-send it in clear text.

        httpx runs request hooks before EACH hop is sent — the redirect's
        too — so raising here means the clear-text request never leaves.
        Every request this fetcher sends starts at ``self.url``, so its
        scheme is the origin's; it is only parsed for a non-https hop, and
        the origin request already parsed that same string successfully.
        An http origin (a local CDN) already sends the key in clear: its
        redirects are no downgrade."""
        if request.url.scheme == "https":
            return
        origin = self.url
        if origin is not None and httpx.URL(origin).scheme == "https":
            raise _InsecureRedirect

    async def _refuse_downgrade_async(self, request: httpx.Request) -> None:
        """``httpx.AsyncClient`` awaits its hooks: the same rule, awaitable."""
        self._refuse_downgrade(request)

    # ---- Public API ----------------------------------------------------

    def fetch(self, etag: str | None = None) -> FetchResult:
        """Fetch the config synchronously. Never raises — fail-closed."""
        try:
            target = self._target()
            if isinstance(target, FetchResult):
                return target
            with _httpx_log_guard.sdk_send():
                response = self._sync().get(target, headers=self._build_headers(etag))
            return self._parse(response)
        except _InsecureRedirect:
            return self._refuse_redirect()
        except Exception as exc:
            return self._handle_exception(exc)

    async def fetch_async(self, etag: str | None = None) -> FetchResult:
        """Fetch the config asynchronously. Never raises — fail-closed."""
        try:
            target = self._target()
            if isinstance(target, FetchResult):
                return target
            with _httpx_log_guard.sdk_send():
                response = await self._async().get(target, headers=self._build_headers(etag))
            return self._parse(response)
        except _InsecureRedirect:
            return self._refuse_redirect()
        except Exception as exc:
            return self._handle_exception(exc)

    def close(self) -> None:
        if self._sync_client is not None:
            try:
                self._sync_client.close()
            except Exception as exc:
                self._logger.warning(
                    f"ConfigFetcher.close: failed to close sync client "
                    f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
                )
            self._sync_client = None

    async def close_async(self) -> None:
        self.close()
        if self._async_client is not None:
            try:
                await self._async_client.aclose()
            except Exception as exc:
                self._logger.warning(
                    f"ConfigFetcher.close_async: failed to close async client "
                    f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
                )
            self._async_client = None

    # ---- Internals -----------------------------------------------------

    def _parse(self, response: httpx.Response) -> FetchResult:
        if response.status_code == 304:
            return FetchResult(status="not_modified", etag=response.headers.get("etag"))

        if response.status_code != 200:
            reason = f"HTTP {response.status_code}"
            self._logger.error(
                f"ConfigFetcher: fetch failed for sdkKey={redact_sdk_key(self._sdk_key)} "
                f"reason={reason}"
            )
            return FetchResult(status="failed", error=reason)

        try:
            body = response.json()
        except Exception as exc:
            self._logger.error(
                f"ConfigFetcher: fetch returned non-JSON body for "
                f"sdkKey={redact_sdk_key(self._sdk_key)}: {type(exc).__name__}"
            )
            return FetchResult(status="failed", error="MALFORMED_JSON")

        if not isinstance(body, dict):
            self._logger.error(
                f"ConfigFetcher: fetch returned non-object JSON for "
                f"sdkKey={redact_sdk_key(self._sdk_key)}"
            )
            return FetchResult(status="failed", error="MALFORMED_JSON")

        # Shape validation: a valid `config_v6.json` carries the
        # `{p, f, s}` top-level shape. sdk-node tightened the same
        # check via `isConfigShape` — this brings sdk-python to parity
        # so the corpus-wide ``wire-cases.json::wrong-shape-200`` case
        # surfaces the same `parseFailed` everywhere. A 200 with a body
        # that doesn't match the contract is a stronger signal of CDN
        # drift than a 5xx and deserves its own typed error class.
        if "f" not in body:
            self._logger.error(
                f"ConfigFetcher: fetch returned JSON without 'f' key for "
                f"sdkKey={redact_sdk_key(self._sdk_key)}"
            )
            return FetchResult(status="failed", error="MALFORMED_JSON")

        return FetchResult(status="fetched", body=body, etag=response.headers.get("etag"))

    def _refuse(self) -> FetchResult:
        """A key that cannot be one path segment is never requested."""
        self._logger.error(
            f"ConfigFetcher: INVALID_SDK_KEY for sdkKey={redact_sdk_key(self._sdk_key)} — "
            "the key cannot be a URL path segment; not fetching"
        )
        return FetchResult(status="failed", error="INVALID_SDK_KEY")

    def _refuse_base_url(self) -> FetchResult:
        """A base URL that would move the key out of the path is never used."""
        self._logger.error(
            f"ConfigFetcher: INVALID_REQUEST for sdkKey={redact_sdk_key(self._sdk_key)} — "
            "the base URL holds a query or fragment; not fetching"
        )
        return FetchResult(status="failed", error="INVALID_REQUEST")

    def _refuse_redirect(self) -> FetchResult:
        """A redirect from https down to http was refused before it was sent."""
        self._logger.error(
            f"ConfigFetcher: INSECURE_REDIRECT for sdkKey={redact_sdk_key(self._sdk_key)} — "
            "an https fetch was redirected to http; not following"
        )
        return FetchResult(status="failed", error="INSECURE_REDIRECT")

    def _handle_exception(self, exc: Exception) -> FetchResult:
        # Only the exception's TYPE is reported: httpx messages may quote the
        # request URL, which carries the SDK key (#803 FR-002).
        reason = type(exc).__name__
        self._logger.error(
            f"ConfigFetcher: fetch raised for sdkKey={redact_sdk_key(self._sdk_key)} "
            f"reason={reason}"
        )
        return FetchResult(status="failed", error=reason)
