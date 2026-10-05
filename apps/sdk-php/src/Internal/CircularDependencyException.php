<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Raised on a detected prerequisite-flag cycle (FR-007, SC-004). Caught by
 * `Evaluator::evaluate`'s `catch (\Throwable)` rescue-all → fail-closed
 * `EVAL_EXCEPTION`. The cycle raise is what BOUNDS an otherwise unbounded
 * recursion: the visited-flags set is finite, so the second visit of any key
 * throws — never a hang, never a stack-overflow / fatal error escaping to the
 * caller.
 *
 * `$cycle` carries the bare `a -> b -> a` chain (no surrounding brackets) so
 * the eval-log ERROR 1002 (`circularDependency`) can render it as
 * `[a -> b -> a]` (ADR 0003 / epic #494).
 */
final class CircularDependencyException extends \RuntimeException
{
    public function __construct(string $message, public readonly string $cycle = '')
    {
        parent::__construct($message);
    }
}
