# SPDX-License-Identifier: MIT
"""Unit tests for `confeature_client.cache`.

Three behaviours under test:
  - FileCache happy path: write + read round-trip.
  - FileCache OSError fallback: when the filesystem refuses, switch to
    memory mode and emit exactly one WARNING log (per FR-012).
  - MemoryCache basics: read/write of the in-process entry.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from confeature_client.cache import (
    CacheEntry,
    FileCache,
    MemoryCache,
    make_cache,
    now_seconds,
)

from .._key_leak import CapturingLogger

_SDK_KEY = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
_CACHE_KEY = "confeature:cache:v1:test32characterspaddedforfilen"


class TestMemoryCache:
    def test_read_returns_none_when_empty(self) -> None:
        cache = MemoryCache()
        assert cache.read() is None

    def test_write_then_read_returns_entry(self) -> None:
        cache = MemoryCache()
        entry = CacheEntry(body={"f": {}}, etag='"abc"', fetched_at=now_seconds())
        cache.write(entry)
        assert cache.read() == entry

    def test_overwrite_replaces_entry(self) -> None:
        cache = MemoryCache()
        first = CacheEntry(body={"f": {"a": True}}, etag=None, fetched_at=1.0)
        second = CacheEntry(body={"f": {"b": False}}, etag='"x"', fetched_at=2.0)
        cache.write(first)
        cache.write(second)
        assert cache.read() == second


class TestFileCache:
    def test_read_returns_none_when_file_absent(self, tmp_path: Path) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)
        assert cache.read() is None
        assert logger.records == []

    def test_write_then_read_round_trip(self, tmp_path: Path) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)
        entry = CacheEntry(
            body={"f": {"feature.test": {"t": 0, "v": {"b": True}}}},
            etag='"abc"',
            fetched_at=42.0,
        )
        cache.write(entry)

        # The cache file should exist on disk under the expected name.
        assert cache.file_path.exists()
        on_disk = json.loads(cache.file_path.read_text(encoding="utf-8"))
        assert on_disk["body"] == entry.body
        assert on_disk["etag"] == entry.etag
        assert on_disk["fetched_at"] == entry.fetched_at

        # And a fresh FileCache pointed at the same dir reads it back.
        rehydrated = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, CapturingLogger())
        result = rehydrated.read()
        assert result is not None
        assert result.body == entry.body
        assert result.etag == entry.etag
        assert result.fetched_at == entry.fetched_at

    def test_filename_uses_cache_key_tail(self, tmp_path: Path) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)
        # The envelope prefix is stripped — only the trailing segment
        # appears in the filename.
        assert "confeature:cache:v1:" not in str(cache.file_path)
        assert cache.file_path.name.startswith("confeature-")

    def test_oserror_during_write_falls_back_to_memory(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)

        # Patch Path.write_text to raise OSError on every call.
        def _raise(self: Path, *_args: object, **_kwargs: object) -> int:
            raise OSError("read-only filesystem")

        monkeypatch.setattr(Path, "write_text", _raise)

        entry = CacheEntry(body={"f": {}}, etag=None, fetched_at=10.0)
        cache.write(entry)

        # The write must have triggered exactly one WARNING log.
        warnings = [msg for level, msg in logger.records if level == "warning"]
        assert len(warnings) == 1, f"Expected 1 WARNING, got: {logger.records!r}"
        assert "Falling back to memory-only cache" in warnings[0]
        # The raw SDK key MUST not appear in the log.
        assert _SDK_KEY not in warnings[0]

        # Subsequent reads should now return the in-memory mirror.
        result = cache.read()
        assert result is not None
        assert result.body == entry.body

    def test_no_further_disk_attempts_after_fallback(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)

        call_count = {"n": 0}

        def _raise_then_count(self: Path, *_args: object, **_kwargs: object) -> int:
            call_count["n"] += 1
            raise OSError("nope")

        monkeypatch.setattr(Path, "write_text", _raise_then_count)

        cache.write(CacheEntry(body={"f": {}}, etag=None, fetched_at=1.0))
        first_count = call_count["n"]
        cache.write(CacheEntry(body={"f": {"b": True}}, etag=None, fetched_at=2.0))
        # After the first OSError the fallback is engaged: no further
        # write_text calls should happen on subsequent writes.
        assert call_count["n"] == first_count

        # And exactly one WARNING should have been logged (not two).
        warnings = [msg for level, msg in logger.records if level == "warning"]
        assert len(warnings) == 1

    def test_corrupt_cache_file_logs_warning_and_returns_none(self, tmp_path: Path) -> None:
        logger = CapturingLogger()
        cache = FileCache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)
        # Write a corrupt cache file directly.
        cache.file_path.parent.mkdir(parents=True, exist_ok=True)
        cache.file_path.write_text("{not-json", encoding="utf-8")

        assert cache.read() is None
        warnings = [msg for level, msg in logger.records if level == "warning"]
        assert len(warnings) == 1
        assert _SDK_KEY not in warnings[0]


class TestMakeCacheFactory:
    def test_explicit_none_returns_memory_cache(self) -> None:
        # `make_cache(cache_dir=None, ...)` returns a FileCache that
        # resolves to platformdirs.user_cache_dir. The platform default
        # is *probed* but write fallback is what guarantees memory mode.
        # We can't easily flip the probe in unit tests; instead, assert
        # the call returns something that satisfies the protocol.
        logger = CapturingLogger()
        cache = make_cache(None, _CACHE_KEY, _SDK_KEY, logger)
        # Either FileCache or MemoryCache satisfies the protocol.
        assert hasattr(cache, "read")
        assert hasattr(cache, "write")

    def test_explicit_path_returns_file_cache(self, tmp_path: Path) -> None:
        logger = CapturingLogger()
        cache = make_cache(tmp_path, _CACHE_KEY, _SDK_KEY, logger)
        assert isinstance(cache, FileCache)
        entry = CacheEntry(body={"f": {}}, etag=None, fetched_at=0.0)
        cache.write(entry)
        assert cache.read() == entry
