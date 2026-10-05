# SPDX-License-Identifier: MIT
"""Evaluation logger surface (ADR 0003 / epic #494, Python slice of #501).

The WARN / ERROR / INFO lines the federated evaluator emits during a trace,
ported from ``packages/sdk-shared/src/logger.ts`` (the ``LoggerWrapper`` helpers
``userObjectIsMissing`` / ``userObjectAttributeIsMissing`` /
``userObjectAttributeIsMissingForPercentage`` / ``userObjectAttributeIsInvalid``
/ ``comparisonValueIsInvalid`` / ``circularDependency``) and the INFO 5000 trace
emission point in ``evaluator.ts``. Mirrors the Go port
(``apps/sdk-go/internal/evaluator/eval_logger.go``) so the federation ports stay
consistent.

The strings are ported VERBATIM from ``logger.ts`` (Principle II — byte-identical
to the canonical). The capture format the parity test reconstructs is
``"<LEVEL>: [<eventId>] <message>"`` per emitted call, joined by ``"\n"``, with
the INFO 5000 entry carrying the multi-line indented trace — see
``parity-upstream.test.ts`` ``assertEvalLogTrace``.

This trace-logging seam is intentionally distinct from the public
:mod:`confeature_client.logger` ``Logger`` ABC: a customer-supplied logger has
the ``error/warning/info/debug`` shape, while the trace test taps a structured
``(level, event_id, message)`` recorder. Keeping them separate matches the Go
factoring (its ``TraceLogger`` is likewise independent of the SDK's public
logger surface) and keeps the no-trace hot path zero-cost.
"""

from __future__ import annotations

import enum
from typing import Protocol


class LogLevel(enum.IntEnum):
    """Mirrors configcat-common's numeric ordering (logger.ts ``LogLevel``).

    Level filtering ("Info and above") works identically across SDKs.
    """

    OFF = -1
    ERROR = 1
    WARN = 2
    INFO = 3
    DEBUG = 4


class TraceLogger(Protocol):
    """Captures the evaluator's structured log calls.

    Each call is one ``(level, event_id, message)`` tuple; an INFO-enabled
    logger drives the eval-log trace (the multi-line INFO 5000 line) plus the
    WARN/ERROR lines emitted during the walk. This is the seam the parity test
    taps to reconstruct ConfigCat's byte-identical capture string.
    """

    def level(self) -> LogLevel:
        """Report the configured threshold (``LogLevel.INFO`` enables tracing)."""
        ...

    def log(self, level: LogLevel, event_id: str, message: str) -> None:
        """Record one emitted line."""
        ...


class _TraceLog:
    """Internal logger adapter threaded through the evaluation context.

    Mirrors logger.ts ``LoggerWrapper``: a ``None`` inner means tracing is off
    (zero cost), and every helper is level-gated at the boundary.
    """

    __slots__ = ("_inner",)

    def __init__(self, inner: TraceLogger | None) -> None:
        self._inner = inner

    def enabled(self, level: LogLevel) -> bool:
        if self._inner is None:
            return False
        threshold = self._inner.level()
        if threshold == LogLevel.OFF:
            return False
        return level <= threshold

    def _emit(self, level: LogLevel, event_id: str, message: str) -> None:
        if not self.enabled(level):
            return
        assert self._inner is not None  # narrowed by enabled()
        self._inner.log(level, event_id, message)

    def user_object_is_missing(self, key: str) -> None:
        """WARN 3001 (verbatim from logger.ts ``userObjectIsMissing``)."""
        self._emit(
            LogLevel.WARN,
            "3001",
            f"cannot evaluate targeting rules and % options for setting '{key}' "
            "(User Object is missing); you should pass a User Object to the evaluation "
            "methods like `getValue()` in order to make targeting work properly; read more: "
            "https://configcat.com/docs/advanced/user-object/",
        )

    def user_object_attribute_is_missing(self, key: str, attribute_name: str) -> None:
        """WARN 3003 (verbatim from logger.ts ``userObjectAttributeIsMissing``)."""
        self._emit(
            LogLevel.WARN,
            "3003",
            f"cannot evaluate certain targeting rules of setting '{key}' "
            f"(the User.{attribute_name} attribute is missing); you should set the "
            f"User.{attribute_name} attribute in order to make targeting work properly; "
            "read more: https://configcat.com/docs/advanced/user-object/",
        )

    def user_object_attribute_is_missing_for_percentage(
        self, key: str, attribute_name: str
    ) -> None:
        """WARN 3003, % options variant (verbatim from logger.ts)."""
        self._emit(
            LogLevel.WARN,
            "3003",
            f"cannot evaluate % options for setting '{key}' "
            f"(the User.{attribute_name} attribute is missing); you should set the "
            f"User.{attribute_name} attribute in order to make targeting work properly; "
            "read more: https://configcat.com/docs/advanced/user-object/",
        )

    def user_object_attribute_is_invalid(self, key: str, attribute_name: str, reason: str) -> None:
        """WARN 3004 (verbatim from logger.ts ``userObjectAttributeIsInvalid``)."""
        self._emit(
            LogLevel.WARN,
            "3004",
            f"cannot evaluate certain targeting rules of setting '{key}' "
            f"(the User.{attribute_name} attribute is invalid ({reason})); please check the "
            f"User.{attribute_name} attribute and make sure that its value corresponds to the "
            "comparison operator",
        )

    def comparison_value_is_invalid(self, key: str, inner_message: str) -> None:
        """WARN 3004, malformed config operand (#509).

        Note there is NO "please check the User.<attr>…" suffix (verbatim from
        logger.ts ``comparisonValueIsInvalid``). ``inner_message`` is the full
        ``comparison value '<v>' is invalid (<reason>)`` text.
        """
        self._emit(
            LogLevel.WARN,
            "3004",
            f"cannot evaluate certain targeting rules of setting '{key}' ({inner_message})",
        )

    def circular_dependency(self, key: str, cycle: str) -> None:
        """ERROR 1002 (verbatim from logger.ts ``circularDependency``)."""
        self._emit(
            LogLevel.ERROR,
            "1002",
            f"failed to evaluate setting '{key}' (circular dependency detected between the "
            f"following depending flags: [{cycle}])",
        )

    def info(self, event_id: str, message: str) -> None:
        """INFO line (the 5000 trace). Mirrors logger.ts ``LoggerWrapper.info``."""
        self._emit(LogLevel.INFO, event_id, message)
