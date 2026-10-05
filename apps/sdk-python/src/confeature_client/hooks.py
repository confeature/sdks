# SPDX-License-Identifier: MIT
"""Hooks/events bus for ConfeatureClient.

Mirrors `configcatclient.configcatoptions.Hooks` 1:1 at the public API surface
(constitution Principle II, epic #268). Exposes the four hook points the JS-family
reference contract emits: ``clientReady``, ``configChanged``, ``flagEvaluated``,
``clientError``.

Listener registration is thread-safe via a `threading.Lock`; listener exceptions
are caught and logged — never escape to the emitter.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from .logger import Logger, default_logger


class Hooks:
    """Subscribe to client lifecycle events.

    Obtain via :meth:`ConfeatureClient.get_hooks`. Methods mirror upstream
    ``configcatclient`` exactly so a migrating consumer's subscription call
    sites compile unchanged (Principle II — drop-in compatibility).
    """

    def __init__(self, logger: Logger | None = None) -> None:
        self._logger: Logger = logger if logger is not None else default_logger()
        self._lock = threading.Lock()
        self._on_client_ready: list[Callable[[], None]] = []
        self._on_config_changed: list[Callable[[Any], None]] = []
        self._on_flag_evaluated: list[Callable[[Any], None]] = []
        self._on_error: list[Callable[[str], None]] = []

    def add_on_client_ready(self, callback: Callable[[], None]) -> None:
        """Subscribe to the first successful config load (cache hydration or fetch)."""
        with self._lock:
            self._on_client_ready.append(callback)

    def add_on_config_changed(self, callback: Callable[[Any], None]) -> None:
        """Subscribe to every fetched config. Receives the settings dict."""
        with self._lock:
            self._on_config_changed.append(callback)

    def add_on_flag_evaluated(self, callback: Callable[[Any], None]) -> None:
        """Subscribe to every :class:`EvaluationDetails` produced by ``get_value_details``."""
        with self._lock:
            self._on_flag_evaluated.append(callback)

    def add_on_error(self, callback: Callable[[str], None]) -> None:
        """Subscribe to non-fatal SDK errors (HTTP failures, cache I/O)."""
        with self._lock:
            self._on_error.append(callback)

    # --- internal invokers --------------------------------------------------

    def invoke_on_client_ready(self) -> None:
        with self._lock:
            callbacks = list(self._on_client_ready)
        for cb in callbacks:
            try:
                cb()
            except Exception as exc:
                self._logger.error(f"Hooks: on_client_ready listener raised: {exc!r}")

    def invoke_on_config_changed(self, config: Any) -> None:
        with self._lock:
            callbacks = list(self._on_config_changed)
        for cb in callbacks:
            try:
                cb(config)
            except Exception as exc:
                self._logger.error(f"Hooks: on_config_changed listener raised: {exc!r}")

    def invoke_on_flag_evaluated(self, evaluation_details: Any) -> None:
        with self._lock:
            callbacks = list(self._on_flag_evaluated)
        for cb in callbacks:
            try:
                cb(evaluation_details)
            except Exception as exc:
                self._logger.error(f"Hooks: on_flag_evaluated listener raised: {exc!r}")

    def invoke_on_error(self, error: str) -> None:
        with self._lock:
            callbacks = list(self._on_error)
        for cb in callbacks:
            try:
                cb(error)
            except Exception as exc:
                self._logger.error(f"Hooks: on_error listener raised: {exc!r}")
