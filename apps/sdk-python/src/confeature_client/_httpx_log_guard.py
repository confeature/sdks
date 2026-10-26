# SPDX-License-Identifier: MIT
"""Keep httpx's per-request INFO line out of the logs for the SDK's own fetches (#835).

httpx logs every request URL at INFO on the ``httpx`` logger
(``httpx/_client.py`` ``_send_single_request``, sync and async, once per
redirect hop), and the config URL carries the SDK key (ConfigCat's wire
protocol, #803). Upstream ConfigCat python (requests / urllib3) logs the
request line at DEBUG only, so it is silent at INFO; a host app logging at
INFO would otherwise record the key on every poll.

One filter on the ``httpx`` logger drops a record only while a ContextVar is
set, and the SDK sets it only around its own ``get()``. A ContextVar is
per-thread and per-asyncio-task, so the host app's own httpx traffic — on any
thread or task — logs exactly as before; redirect hops run inside the same
``get()`` and are covered too. The logger's level, handlers and propagation
are untouched, and no other record is altered.

A transport or event hook cannot prevent the line: httpx writes it after the
transport returns. Bypassing the Client would mean rebuilding redirect
handling and the https -> http downgrade guard.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_IN_SDK_SEND: ContextVar[bool] = ContextVar("confeature_sdk_send", default=False)
_LOCK = threading.Lock()


class _DropSdkRequestLine(logging.Filter):
    """Drops a record logged while the SDK is sending; passes every other one."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not _IN_SDK_SEND.get()


def install() -> None:
    """Add the filter to the ``httpx`` logger once per process. Idempotent."""
    target = logging.getLogger("httpx")
    with _LOCK:
        if not any(isinstance(f, _DropSdkRequestLine) for f in target.filters):
            target.addFilter(_DropSdkRequestLine())


@contextmanager
def sdk_send() -> Iterator[None]:
    """Mark the enclosed request as the SDK's own, for the duration of the block.

    Safe across an ``await``: an asyncio task runs in its own context.
    """
    token = _IN_SDK_SEND.set(True)
    try:
        yield
    finally:
        _IN_SDK_SEND.reset(token)
