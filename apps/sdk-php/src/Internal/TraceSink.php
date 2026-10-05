<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Captures the evaluator's structured log calls (ADR 0003 / epic #494). Each
 * call is one `(level, eventId, message)` tuple; an INFO-enabled sink drives
 * the eval-log trace (the multi-line INFO 5000 line) plus the WARN / ERROR
 * lines emitted during the walk. This is the seam the parity test taps to
 * reconstruct ConfigCat's byte-identical capture string.
 *
 * Intentionally distinct from the public `Confeature\Logger`: a customer-
 * supplied logger has the `error/warning/info/debug` shape, while this trace
 * seam taps a structured `(level, eventId, message)` recorder. Keeping them
 * separate mirrors the Python / Ruby / Go factoring and keeps the no-trace hot
 * path zero-cost.
 */
interface TraceSink
{
    /** Report the configured threshold (a {@link TraceLevel} value). */
    public function level(): int;

    /** Record one emitted line. */
    public function log(int $level, string $eventId, string $message): void;
}
