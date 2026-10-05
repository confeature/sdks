# SPDX-License-Identifier: MIT
"""Filesystem + memory cache for the latest `config_v6.json` body + ETag.

Default cache dir: `platformdirs.user_cache_dir("confeature")`. Customers
override via the `cache_dir` client option (FR-011). When the cache
directory is not writable, the implementation emits a single
WARNING-level log entry and falls back to a process-local memory cache
without further filesystem attempts (FR-012).
"""

from __future__ import annotations

import dataclasses
import json
import os
import time
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import platformdirs

from .logger import Logger
from .sdk_key import redact_sdk_key


@dataclasses.dataclass
class CacheEntry:
    """One on-disk cache record."""

    body: dict[str, Any]
    etag: str | None
    fetched_at: float


@runtime_checkable
class Cache(Protocol):
    """Cache protocol — both FileCache and MemoryCache implement this."""

    def read(self) -> CacheEntry | None: ...

    def write(self, entry: CacheEntry) -> None: ...


class MemoryCache:
    """In-process cache — also the fallback when the filesystem refuses."""

    def __init__(self) -> None:
        self._entry: CacheEntry | None = None

    def read(self) -> CacheEntry | None:
        return self._entry

    def write(self, entry: CacheEntry) -> None:
        self._entry = entry


class FileCache:
    """Persists CacheEntry as JSON at `{cache_dir}/confeature-{cache_key}.json`.

    On OSError during write, switches the instance into memory-only mode
    and emits a single WARNING log entry. Subsequent reads/writes use
    the in-memory entry — the filesystem is never retried (per FR-012).
    """

    def __init__(
        self,
        cache_dir: str | os.PathLike[str] | Path | None,
        cache_key: str,
        sdk_key: str,
        logger: Logger,
    ) -> None:
        self._sdk_key = sdk_key
        self._logger = logger
        resolved_dir = (
            Path(cache_dir)
            if cache_dir is not None
            else Path(platformdirs.user_cache_dir("confeature"))
        )
        # Strip the envelope prefix for the filename so the on-disk
        # entry name remains short + opaque.
        cache_key_tail = cache_key.rsplit(":", maxsplit=1)[-1] or cache_key
        self._cache_dir = resolved_dir
        self._file_path = resolved_dir / f"confeature-{cache_key_tail}.json"
        self._memory: MemoryCache = MemoryCache()
        self._fallback_triggered = False

    @property
    def file_path(self) -> Path:
        return self._file_path

    def read(self) -> CacheEntry | None:
        if self._fallback_triggered:
            return self._memory.read()
        if not self._file_path.exists():
            return self._memory.read()
        try:
            payload = json.loads(self._file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self._logger.warning(
                f"FileCache.read: failed to load {self._file_path} "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {exc!r}"
            )
            return self._memory.read()
        try:
            return CacheEntry(
                body=payload["body"],
                etag=payload.get("etag"),
                fetched_at=float(payload.get("fetched_at", 0.0)),
            )
        except (KeyError, TypeError) as exc:
            self._logger.warning(
                f"FileCache.read: malformed cache file {self._file_path} "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {exc!r}"
            )
            return None

    def write(self, entry: CacheEntry) -> None:
        # Always mirror to memory first so reads after a write succeed
        # even if the filesystem path fails.
        self._memory.write(entry)
        if self._fallback_triggered:
            return
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "body": entry.body,
                "etag": entry.etag,
                "fetched_at": entry.fetched_at,
            }
            tmp = self._file_path.with_suffix(self._file_path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self._file_path)
        except OSError as exc:
            self._fallback_triggered = True
            self._logger.warning(
                f"FileCache.write: filesystem unwritable for "
                f"{self._file_path} (sdkKey={redact_sdk_key(self._sdk_key)}): "
                f"{exc!r}. Falling back to memory-only cache for this client."
            )


def make_cache(
    cache_dir: str | os.PathLike[str] | Path | None,
    cache_key: str,
    sdk_key: str,
    logger: Logger,
) -> Cache:
    """Factory: returns MemoryCache when cache_dir is explicitly None,
    otherwise FileCache (which lazily falls back to memory)."""
    if cache_dir is None and not _default_cache_dir_allowed():
        return MemoryCache()
    if cache_dir is None:
        # Use the platformdirs default; FileCache will resolve it
        # internally so caller doesn't need to know the platform path.
        return FileCache(None, cache_key, sdk_key, logger)
    return FileCache(cache_dir, cache_key, sdk_key, logger)


def _default_cache_dir_allowed() -> bool:
    """Best-effort feasibility check for the default platform cache dir.

    Returns False only when probing the default raises immediately
    (extremely rare). The FileCache itself handles the dominant
    "writable now, OSError on first write" case via its fallback path.
    """
    try:
        _ = platformdirs.user_cache_dir("confeature")
        return True
    except Exception:  # pragma: no cover — defensive guard
        return False


def now_seconds() -> float:
    return time.time()
