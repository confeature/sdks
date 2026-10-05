# SPDX-License-Identifier: MIT
"""`ConfeatureClient` + `ConfeatureSnapshot` — the public top-level surface.

Lifecycle (sync path):
    1. customer constructs `ConfeatureClient(sdk_key, polling_mode=AutoPoll(), ...)`.
    2. AutoPoll spawns its daemon thread immediately; LazyLoad / ManualPoll
       record the fetch callback but spawn nothing.
    3. First `get_value()` triggers a fetch in LazyLoad (if stale);
       in AutoPoll the initial fetch happened during `start()`; in
       ManualPoll the caller must `force_refresh()` first.
    4. `close()` signals the poll thread and joins with a 5-second
       timeout. `__del__` finaliser calls `close()` as a safety net.

`get_value(key, default, user=None)` round-trips the default through the
four-type evaluator (spec 072): the resolved native type follows the
`SettingType` discriminator on the cached setting (`bool` / `str` / `int` /
`float`). A default whose native type does not match the setting's type
falls through to that default with `TYPE_MISMATCH`.

The snapshot path is what carries the spec-036 fix: `snapshot().get_value`
consults `flag_overrides` SYNCHRONOUSLY via `evaluate_override_sync`
before consulting the cached config. The Python SDK inherits the
corrected behaviour from day one.
"""

from __future__ import annotations

import datetime
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from .cache import CacheEntry, FileCache, MemoryCache, make_cache, now_seconds
from .config_fetcher import ConfigFetcher, FetchResult
from .evaluation_details import EvaluationDetails
from .evaluator import evaluate as evaluator_evaluate
from .flag_overrides import FlagOverrides, OverrideBehaviour
from .hooks import Hooks
from .logger import Logger, default_logger
from .override_eval import (
    evaluate_full_config_override_details_sync,
    evaluate_override,
    evaluate_override_sync,
)
from .poll_service import (
    AutoPoll,
    PollingMode,
    PollService,
    RefreshResult,
    make_poll_service,
)
from .sdk_key import (
    derive_cache_key,
    is_utf8_encodable,
    is_valid_confeature_key_format,
    redact_sdk_key,
)
from .user import User

if TYPE_CHECKING:
    import os
    from types import TracebackType

T = TypeVar("T")


def _get_version() -> str:
    # Lazy import: the package's `__init__.py` re-exports symbols from this
    # module, so importing `__version__` at the top would form a cycle.
    from . import __version__  # noqa: PLC0415 — circular-import workaround

    return __version__


class ConfeatureSnapshot:
    """Immutable view of the last-fetched config + a reference to overrides.

    All methods are synchronous. `get_value` consults overrides FIRST
    via `evaluate_override_sync`, then falls through to the cached
    config + boolean evaluator. This is the spec-036 correctness path
    that the Python SDK inherits from day one.
    """

    def __init__(
        self,
        config: dict[str, Any] | None,
        flag_overrides: FlagOverrides | None,
        default_user: User | None,
        fetch_time: datetime.datetime | None = None,
    ) -> None:
        self._config = config
        self._flag_overrides = flag_overrides
        self._default_user = default_user
        # Captured at snapshot construction; surfaced via
        # EvaluationDetails.fetch_time. Immutable across the snapshot's
        # life (spec 079 / #266). `None` until a config has loaded.
        self._fetch_time = fetch_time

    def get_value(
        self,
        key: str,
        default: T,
        user: User | None = None,
    ) -> T:
        # Override path FIRST — spec 036 correctness. Route through the
        # full-config-aware router (spec 135 / #428) so a rule-bearing override
        # source resolves targeting rules; the flat-map source is unchanged.
        effective_user = user if user is not None else self._default_user
        override = evaluate_override(self._flag_overrides, key, default, effective_user)
        if override is not None:
            return override
        # Fall through to the cached config.
        result = evaluator_evaluate(self._config, key, default, effective_user)
        return result.value

    def get_all_keys(self) -> list[str]:
        keys: set[str] = set()
        if self._config is not None:
            settings = self._config.get("f")
            if isinstance(settings, dict):
                keys.update(settings.keys())
        if self._flag_overrides is not None:
            try:
                override_map = self._flag_overrides.data_source.get_overrides_sync()
            except Exception:
                override_map = None
            if override_map is not None:
                keys.update(override_map.keys())
        return sorted(keys)

    def get_value_details(
        self,
        key: str,
        default: T,
        user: User | None = None,
    ) -> EvaluationDetails[T]:
        """Mirrors :meth:`get_value` but returns the typed envelope.

        For consumers configured with ``OverrideBehaviour.LOCAL_ONLY``,
        the override map is the only source of truth: a key present in
        the map yields the typed value with ``error=None``; a missing
        key yields the default with ``error="KEY_NOT_FOUND"``. Without
        overrides (or with non-LocalOnly behaviour), the evaluator's
        result is reported directly. Spec 079 / #266.
        """
        effective_user = user if user is not None else self._default_user
        is_local_only = (
            self._flag_overrides is not None
            and self._flag_overrides.behaviour is OverrideBehaviour.LOCAL_ONLY
        )
        if is_local_only:
            # Full-config override source → resolve through the real evaluator
            # so targeting rules apply AND the served `variation_id` survives
            # to the PUBLIC details envelope (spec 152 / #475, US2; closes the
            # #395 gap class). Dispatch on the source TYPE, never the resolved
            # value, mirroring `get_value`'s `evaluate_override` router.
            full_config_details = evaluate_full_config_override_details_sync(
                self._flag_overrides, key, default, effective_user
            )
            if full_config_details is not None:
                return EvaluationDetails(
                    key=key,
                    value=full_config_details.value,
                    variation_id=full_config_details.variation_id,
                    user=effective_user,
                    is_default_value=full_config_details.error is not None,
                    error=full_config_details.error,
                    fetch_time=self._fetch_time,
                )
            override = evaluate_override_sync(self._flag_overrides, key, default)
            # LocalOnly contract: distinguish "override hit" from "missing
            # key returning default". We re-query the map to disambiguate
            # — `evaluate_override_sync` returns the default on both
            # KEY_NOT_FOUND and TYPE_MISMATCH branches, indistinguishable
            # from a legitimate override whose value equals the default.
            data_source = self._flag_overrides.data_source  # type: ignore[union-attr]
            sync_getter = getattr(data_source, "get_overrides_sync", None)
            overrides_map = sync_getter() if callable(sync_getter) else None
            present = overrides_map is not None and key in overrides_map
            if present and override is not None:
                return EvaluationDetails(
                    key=key,
                    value=override,
                    user=effective_user,
                    fetch_time=self._fetch_time,
                )
            return EvaluationDetails(
                key=key,
                value=default,
                is_default_value=True,
                error="KEY_NOT_FOUND",
                user=effective_user,
                fetch_time=self._fetch_time,
            )
        result = evaluator_evaluate(self._config, key, default, effective_user)
        return EvaluationDetails(
            key=key,
            value=result.value,
            variation_id=result.variation_id,
            user=effective_user,
            is_default_value=result.error is not None,
            error=result.error,
            fetch_time=self._fetch_time,
        )


class ConfeatureClient:
    """Top-level entry point — drop-in equivalent of `configcat-client`.

    Constructor args mirror configcat-client's option set:
        sdk_key: required non-empty Confeature SDK key.
        polling_mode: AutoPoll() | LazyLoad() | ManualPoll(). Default AutoPoll().
        cache_dir: filesystem cache dir. `None` → memory-only.
        request_timeout_seconds: per-request timeout. Default 30.
        logger: a `Logger` instance. Default = stderr logger at WARNING.
        flag_overrides: optional `FlagOverrides` (LocalOnly only in v1).
        base_url: CDN base URL. Override for a proxy or a local CDN. A base
            URL holding a query or fragment (``?``, ``#``) would move the
            key out of the request path, so every fetch fails with
            ``INVALID_REQUEST`` and nothing is sent.
        default_user: optional default `User` consulted when get_value's
            `user` arg is None.
    """

    def __init__(
        self,
        sdk_key: str,
        polling_mode: PollingMode | None = None,
        *,
        cache_dir: str | os.PathLike[str] | Path | None = None,
        request_timeout_seconds: float = 30.0,
        logger: Logger | None = None,
        flag_overrides: FlagOverrides | None = None,
        base_url: str | None = None,
        default_user: User | None = None,
    ) -> None:
        if not isinstance(sdk_key, str) or sdk_key == "":
            raise ValueError("sdk_key is required and must be a non-empty string.")
        # Unlike a merely malformed key (logged, lenient), a lone surrogate can
        # be neither hashed into the cache key nor sent in the URL: refuse it
        # here, as ConfigCat refuses a bad key at creation. Checked by a
        # predicate, never by catching UnicodeEncodeError — that exception's
        # repr holds the whole key, and raising inside its handler would chain
        # it onto this one (#803 FR-002).
        if not is_utf8_encodable(sdk_key):
            raise ValueError("sdk_key must be valid Unicode text (it holds a lone surrogate).")
        if request_timeout_seconds <= 0:
            raise ValueError(
                f"request_timeout_seconds must be > 0; got {request_timeout_seconds!r}."
            )
        if flag_overrides is not None and not isinstance(flag_overrides, FlagOverrides):
            raise TypeError("flag_overrides must be a FlagOverrides instance or None.")
        if logger is not None and not isinstance(logger, Logger):
            raise TypeError("logger must be a Logger instance or None.")

        self._sdk_key = sdk_key
        self._logger: Logger = logger if logger is not None else default_logger()
        self._flag_overrides = flag_overrides
        self._default_user = default_user
        self._closed = False
        self._lock = threading.Lock()
        # Spec 107 / #268 — mirrors configcatclient.configcatoptions.Hooks. The four
        # hook points (clientReady, configChanged, flagEvaluated, clientError) are
        # wired below in _fetch_and_apply / get_value_details / __init__ cache restore.
        self._hooks = Hooks(self._logger)
        self._client_ready_fired = False

        if not is_valid_confeature_key_format(sdk_key):
            self._logger.warning(
                f"INVALID_SDK_KEY format for sdkKey={redact_sdk_key(sdk_key)}. "
                "Continuing — the SDK is lenient about key format at runtime."
            )

        self._cache_key = derive_cache_key(sdk_key)
        self._cache = make_cache(cache_dir, self._cache_key, sdk_key, self._logger)
        self._config: dict[str, Any] | None = None
        self._etag: str | None = None
        # Wall-clock time of the active config's last successful fetch /
        # cache restore. Surfaced via EvaluationDetails.fetch_time
        # (spec 079 / #266). `None` until a config loads.
        self._fetch_time: datetime.datetime | None = None
        # Restore from any existing cache entry so first get_value can
        # return cached values without waiting for the first fetch.
        existing = self._cache.read()
        if existing is not None:
            self._config = existing.body
            self._etag = existing.etag
            self._fetch_time = datetime.datetime.fromtimestamp(
                existing.fetched_at, tz=datetime.timezone.utc
            )
            # Hook bus (spec 107 / #268) — cache hit fires clientReady once.
            self._fire_client_ready_once()

        self._mode: PollingMode = polling_mode if polling_mode is not None else AutoPoll()
        self._fetcher = ConfigFetcher(
            sdk_key=sdk_key,
            version=_get_version(),
            logger=self._logger,
            base_url=base_url,
            request_timeout_seconds=request_timeout_seconds,
        )
        self._service: PollService = make_poll_service(self._mode)

        # When flag_overrides is configured with LOCAL_ONLY we don't
        # need to fetch — the override-eval path handles every call
        # without consulting the cache. Skipping `service.start()` keeps
        # tests + LocalOnly customers offline.
        if self._is_local_only_mode():
            return

        self._service.start(self._fetch_and_apply)

    # ---- Internals -----------------------------------------------------

    def _is_local_only_mode(self) -> bool:
        if self._flag_overrides is None:
            return False
        return self._flag_overrides.behaviour is OverrideBehaviour.LOCAL_ONLY

    def _fetch_and_apply(self) -> FetchResult:
        result = self._fetcher.fetch(self._etag)
        new_config: dict[str, Any] | None = None
        with self._lock:
            if result.status == "fetched" and result.body is not None:
                self._config = result.body
                self._etag = result.etag
                # Stamp fetch_time for EvaluationDetails (spec 079 / #266).
                self._fetch_time = datetime.datetime.now(tz=datetime.timezone.utc)
                new_config = result.body
                if isinstance(self._cache, (FileCache, MemoryCache)):
                    self._cache.write(
                        CacheEntry(
                            body=result.body,
                            etag=result.etag,
                            fetched_at=now_seconds(),
                        )
                    )
            elif result.status == "not_modified":
                # Keep the existing body; refresh ETag if provided.
                if result.etag is not None:
                    self._etag = result.etag
                # `not_modified` still confirms freshness — update stamp.
                self._fetch_time = datetime.datetime.now(tz=datetime.timezone.utc)
        # Hook bus (spec 107 / #268) — fire outside the lock so listeners can
        # re-enter the client without deadlock.
        if result.status == "fetched" and new_config is not None:
            self._hooks.invoke_on_config_changed(new_config)
            self._fire_client_ready_once()
        elif result.status == "not_modified":
            self._fire_client_ready_once()
        elif result.status == "failed":
            self._hooks.invoke_on_error(result.error or "Config fetch failed.")
        return result

    def _fire_client_ready_once(self) -> None:
        with self._lock:
            if self._client_ready_fired:
                return
            self._client_ready_fired = True
        self._hooks.invoke_on_client_ready()

    # ---- Public API ----------------------------------------------------

    def get_value(self, key: str, default: T, user: User | None = None) -> T:
        if self._closed:
            return default
        # Override path FIRST — spec 036 correctness. The router (spec 135 /
        # #428) threads the user so a full-config override source resolves
        # targeting rules through the real evaluator; the flat-map source keeps
        # the byte-identical value-only path.
        effective_user = user if user is not None else self._default_user
        override = evaluate_override(self._flag_overrides, key, default, effective_user)
        if override is not None:
            return override
        # LazyLoad triggers a fetch here when stale.
        try:
            self._service.maybe_fetch_for_get_value()
        except Exception as exc:
            self._logger.warning(
                f"get_value: maybe_fetch_for_get_value raised "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
            )
        result = evaluator_evaluate(
            self._config,
            key,
            default,
            user if user is not None else self._default_user,
        )
        return result.value

    async def get_value_async(self, key: str, default: T, user: User | None = None) -> T:
        # In v1 the async path reads the same in-memory config that the
        # daemon thread populates. We don't await a fetch here — the
        # poll service decides freshness.
        return self.get_value(key, default, user)

    def snapshot(self) -> ConfeatureSnapshot:
        return ConfeatureSnapshot(
            config=self._config,
            flag_overrides=self._flag_overrides,
            default_user=self._default_user,
            fetch_time=self._fetch_time,
        )

    def get_all_keys(self) -> list[str]:
        """Returns the union of cached-config + override keys, sorted.

        Mirrors ConfigCat's ``ConfigCatClient.get_all_keys()``. Closed
        clients return an empty list (matches the closed-client read
        semantics of :meth:`get_value`).
        """
        if self._closed:
            return []
        return self.snapshot().get_all_keys()

    def get_value_details(
        self,
        key: str,
        default: T,
        user: User | None = None,
    ) -> EvaluationDetails[T]:
        """Like :meth:`get_value` but returns the typed envelope.

        Mirrors ``configcat-client``'s ``get_value_details``. Closed
        clients return ``EvaluationDetails`` with the default value,
        ``is_default_value=True``, and ``error="CLIENT_CLOSED"``
        (matches the closed-client read semantics of :meth:`get_value`).
        Spec 079 / #266.
        """
        if self._closed:
            return EvaluationDetails(
                key=key,
                value=default,
                is_default_value=True,
                error="CLIENT_CLOSED",
                user=user if user is not None else self._default_user,
                fetch_time=self._fetch_time,
            )
        try:
            self._service.maybe_fetch_for_get_value()
        except Exception as exc:
            self._logger.warning(
                f"get_value_details: maybe_fetch_for_get_value raised "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
            )
        details = self.snapshot().get_value_details(key, default, user)
        self._hooks.invoke_on_flag_evaluated(details)
        return details

    def get_hooks(self) -> Hooks:
        """Return the :class:`Hooks` bus for this client.

        Mirrors ``configcatclient.ConfigCatClient.get_hooks`` (Principle II, epic #268).
        """
        return self._hooks

    def get_all_values(self, user: User | None = None) -> dict[str, Any]:
        """Evaluates every known flag for ``user`` and returns the map.

        Iterates over the union of cached-config flag keys and override
        keys (the same set :meth:`get_all_keys` returns). Per-key value
        is resolved via :meth:`get_value` with ``None`` as default; keys
        whose resolved value is ``None`` are omitted, mirroring
        upstream's exclusion semantics. Closed clients return an empty
        dict. Spec 079 / #266.
        """
        if self._closed:
            return {}
        result: dict[str, Any] = {}
        for key in self.get_all_keys():
            value = self.get_value(key, None, user)
            if value is not None:
                result[key] = value
        return result

    def force_refresh(self) -> RefreshResult:
        if self._closed:
            return RefreshResult(success=False, error="CLIENT_CLOSED")
        if self._is_local_only_mode():
            # LocalOnly mode never fetches; nothing to refresh.
            return RefreshResult(success=True)
        # ManualPollService.start was deferred for LocalOnly; ensure the
        # service has the callback before forcing a refresh.
        if not getattr(self._service, "_callback", None):
            self._service.start(self._fetch_and_apply)
        return self._service.force_refresh()

    async def force_refresh_async(self) -> RefreshResult:
        if self._closed:
            return RefreshResult(success=False, error="CLIENT_CLOSED")
        if self._is_local_only_mode():
            return RefreshResult(success=True)
        if not getattr(self._service, "_callback", None):
            self._service.start(self._fetch_and_apply)
        return await self._service.force_refresh_async()

    def set_online(self) -> None:
        """Re-enable HTTP polling. Idempotent.

        No-op (with warning) for closed clients and for LOCAL_ONLY
        override clients. Mirrors `configcat-client.ConfigCatClient
        .set_online()` (spec 090 / #267).
        """
        if self._closed:
            self._logger.warning("Confeature client is closed — set_online() has no effect.")
            return
        if self._is_local_only_mode():
            self._logger.warning(
                "Confeature client uses LOCAL_ONLY overrides — set_online() has no effect."
            )
            return
        self._service.set_online()

    def set_offline(self) -> None:
        """Suspend HTTP polling; serve from the cached config. Idempotent.

        Silent no-op for LOCAL_ONLY override clients (parity with upstream).
        No-op (with warning) for closed clients. Mirrors `configcat-
        client.ConfigCatClient.set_offline()`.
        """
        if self._closed:
            self._logger.warning("Confeature client is closed — set_offline() has no effect.")
            return
        if self._is_local_only_mode():
            return
        self._service.set_offline()

    def is_offline(self) -> bool:
        """True if HTTP polling is suspended.

        Returns True for closed clients (defensive — the service is stopped).
        Returns True for LOCAL_ONLY override clients (no HTTP ever).
        Otherwise delegates to the underlying PollService.
        """
        if self._closed:
            return True
        if self._is_local_only_mode():
            return True
        return self._service.is_offline()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._service.stop(timeout=5.0)
        except Exception as exc:
            self._logger.warning(
                f"close: poll service stop raised (sdkKey={redact_sdk_key(self._sdk_key)}): "
                f"{type(exc).__name__}"
            )
        try:
            self._fetcher.close()
        except Exception as exc:
            self._logger.warning(
                f"close: fetcher close raised (sdkKey={redact_sdk_key(self._sdk_key)}): "
                f"{type(exc).__name__}"
            )

    async def close_async(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._service.stop(timeout=5.0)
        except Exception as exc:
            self._logger.warning(
                f"close_async: poll service stop raised "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
            )
        try:
            await self._fetcher.close_async()
        except Exception as exc:
            self._logger.warning(
                f"close_async: fetcher close raised "
                f"(sdkKey={redact_sdk_key(self._sdk_key)}): {type(exc).__name__}"
            )

    # ---- Context managers ---------------------------------------------

    def __enter__(self) -> ConfeatureClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()

    async def __aenter__(self) -> ConfeatureClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close_async()

    def __del__(self) -> None:
        # GC finaliser safety-net: never raise from __del__ (Python's
        # finaliser semantics), but never swallow silently either. A
        # constructor that raised leaves no `_closed`: nothing to close.
        try:
            if not getattr(self, "_closed", True):
                self.close()
        except Exception as exc:
            logger = getattr(self, "_logger", None)
            if logger is not None:
                logger.warning(f"__del__: close raised: {type(exc).__name__}")
