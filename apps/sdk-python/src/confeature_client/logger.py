# SPDX-License-Identifier: MIT
"""Pluggable logger surface for the Confeature Python SDK.

Customers integrate by either:
  - keeping the default stderr-via-`logging` logger (logger name
    `confeature_client`) and configuring stdlib `logging` themselves, or
  - implementing the `Logger` ABC and passing the instance via the
    client's `logger=` constructor arg (research §R9).

The `LogLevel` enum's int values align with Python's stdlib `logging`
level constants so customers can swap between Confeature levels and
stdlib levels transparently.
"""

from __future__ import annotations

import abc
import enum
import logging


class LogLevel(enum.IntEnum):
    """Confeature log levels — int values mirror stdlib `logging`."""

    OFF = 100
    ERROR = logging.ERROR  # 40
    WARNING = logging.WARNING  # 30
    INFO = logging.INFO  # 20
    DEBUG = logging.DEBUG  # 10


class Logger(abc.ABC):
    """ABC for SDK loggers. Default impl is `StderrLogger`."""

    @abc.abstractmethod
    def error(self, message: str) -> None: ...

    @abc.abstractmethod
    def warning(self, message: str) -> None: ...

    @abc.abstractmethod
    def info(self, message: str) -> None: ...

    @abc.abstractmethod
    def debug(self, message: str) -> None: ...


class StderrLogger(Logger):
    """Default logger — writes to stderr via Python's `logging` module.

    Logger name is `confeature_client`. Customers who configure
    `logging.getLogger("confeature_client")` see the SDK's emissions
    through their normal handlers.
    """

    def __init__(self, level: LogLevel = LogLevel.WARNING) -> None:
        self._level = level
        self._logger = logging.getLogger("confeature_client")
        # Don't reconfigure if the customer has already set up handlers
        # on the root logger or on `confeature_client` directly — let
        # their dictConfig win.
        if not self._logger.handlers and not logging.getLogger().handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(
                logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s")
            )
            self._logger.addHandler(handler)
        # Map LogLevel.OFF (100) → logging.CRITICAL+1 so nothing fires.
        stdlib_level = int(level) if level is not LogLevel.OFF else logging.CRITICAL + 1
        self._logger.setLevel(stdlib_level)

    @property
    def level(self) -> LogLevel:
        return self._level

    def error(self, message: str) -> None:
        if self._level <= LogLevel.ERROR:
            self._logger.error(message)

    def warning(self, message: str) -> None:
        if self._level <= LogLevel.WARNING:
            self._logger.warning(message)

    def info(self, message: str) -> None:
        if self._level <= LogLevel.INFO:
            self._logger.info(message)

    def debug(self, message: str) -> None:
        if self._level <= LogLevel.DEBUG:
            self._logger.debug(message)


def default_logger() -> Logger:
    """Construct the default stderr-backed logger at WARNING level."""
    return StderrLogger()
