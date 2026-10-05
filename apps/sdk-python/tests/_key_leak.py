# SPDX-License-Identifier: MIT
"""The ONE set of key-leak test helpers (#803 FR-002/FR-004).

Every suite that asserts "nothing that can carry the SDK key escapes" judges
with these — a capturing logger that records everything a real logger would
print, and the list of secrets a key is made of. They lived twice (the
fetcher and the client suites) and the copies drifted: the client's logger
recorded only ``repr`` of a passed exception, never its traceback or cause
chain, so it judged less than the fetcher's did.
"""

from __future__ import annotations

import re
import sys
import traceback
from typing import Any

from confeature_client.logger import Logger

#: A key no UTF-8 encoder accepts: a lone surrogate, as a stray byte read
#: from an env var with ``surrogateescape`` produces. Shaped like a
#: ConfigCat key so each 22-character part can be checked for a leak.
SURROGATE_KEY = "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3n\udcff/pQ5rS7tU9vW1xY3zA5bC7d"


#: The bytes Go's ``url.PathEscape`` keeps — ``A-Z a-z 0-9 - _ . ~`` and
#: ``$ & + : = @`` (#803 FR-001). Written out here rather than borrowed from
#: the fetcher's escaper: the leak oracle must not share the code it judges.
_GO_PATH_SAFE = frozenset(
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~$&+:=@"
)

#: Each secret part of both key shapes, searched for anywhere in the key so a
#: key carrying a stray space, newline or surrogate still yields its parts.
_SECRET_PARTS = (
    re.compile(r"configcat-sdk-1/([^/]{22})/([^/]{22})", re.DOTALL),
    re.compile(r"confeature-sdk-1-(.{32})-(.{32})", re.DOTALL),
)


def go_path_escape(text: str) -> str:
    """``text`` as Go's ``url.PathEscape`` writes it: every UTF-8 byte outside
    ``_GO_PATH_SAFE`` as uppercase ``%XX``. A lone surrogate is escaped by its
    ``surrogatepass`` bytes, so even a key no URL can carry has a form to
    search for."""
    return "".join(
        chr(byte) if byte in _GO_PATH_SAFE else f"%{byte:02X}"
        for byte in text.encode("utf-8", "surrogatepass")
    )


def secrets_of(key: str) -> list[str]:
    """Every string whose presence in an output leaks ``key``.

    - the raw key;
    - its request-path forms as ``ConfigFetcher.url`` escapes it — the whole
      key as ONE escaped segment (a malformed key) and each ``/``-separated
      part escaped on its own (a well-shaped key). Both are searched, so the
      oracle need not decide which shape the fetcher saw: a log line quoting
      the keyed URL leaks the key in whichever form it was sent;
    - each secret part of a ConfigCat-shaped (``configcat-sdk-1/<22>/<22>``)
      or legacy (``confeature-sdk-1-<32>-<32>``) key, raw and escaped — a
      part alone is as much a leak as the whole key.
    """
    parts = [
        part for pattern in _SECRET_PARTS for m in pattern.finditer(key) for part in m.groups()
    ]
    found = [
        key,
        go_path_escape(key),
        "/".join(go_path_escape(segment) for segment in key.split("/")),
        *parts,
        *(go_path_escape(part) for part in parts),
    ]
    return list(dict.fromkeys(found))


def render(value: Any) -> str:
    """Everything a real logger could print for one logged value: an
    exception (or ``exc_info``) as its full traceback — message, args and the
    whole ``__cause__`` / ``__context__`` chain — anything else as repr + str."""
    if value is True:  # ``exc_info=True``: the exception being handled.
        value = sys.exc_info()[1]
    if isinstance(value, tuple) and len(value) == 3 and isinstance(value[1], BaseException):
        value = value[1]
    if isinstance(value, BaseException):
        # The traceback renders each link's str(); a link's repr and args can
        # hold more (a UnicodeEncodeError's str() omits the string it failed on).
        chain: list[BaseException] = []
        link: BaseException | None = value
        while link is not None and link not in chain:
            chain.append(link)
            link = link.__cause__ or link.__context__
        return "".join(
            [
                *traceback.format_exception(type(value), value, value.__traceback__),
                *(f"{e!r} {e.args!r}" for e in chain),
            ]
        )
    return f"{value!r} {value!s}"


class CapturingLogger(Logger):
    """Test double that records every log call.

    ``Logger``'s contract is message-only, but a call that slips an exception
    or ``exc_info`` through (a positional arg, a keyword) is recorded in full
    in ``rendered`` too, so the key-free assertions judge everything a real
    logger would print — not just the message (#803 brief item 2)."""

    def __init__(self) -> None:
        self.records: list[tuple[str, str]] = []
        self.rendered: list[str] = []

    def _record(self, level: str, message: str, args: Any, kwargs: Any) -> None:
        self.records.append((level, message))
        self.rendered.append(message)
        self.rendered.extend(render(value) for value in (*args, *kwargs.values()))

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._record("error", message, args, kwargs)

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._record("warning", message, args, kwargs)

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._record("info", message, args, kwargs)

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._record("debug", message, args, kwargs)

    @property
    def messages(self) -> list[str]:
        return [msg for _, msg in self.records]
