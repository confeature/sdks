<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Mutable evaluation-scoped state shared across the recursion. `$evalError`
 * carries the first surfaced informational rule-engine reason (missing user /
 * missing attribute / validation) up to the caller (FR-016); it never changes
 * the fail-closed `EvaluationResult::error`.
 */
final class EvalState
{
    /**
     * `$missingUserObjectLogged` dedups the no-user WARN 3001 to once per
     * context (common-js parity): a prerequisite flag evaluates in its OWN
     * context, so a prereq referenced by N rules logs the WARN N times, but a
     * single rule with multiple no-user conditions logs it once (ADR 0003).
     */
    public function __construct(
        public ?string $evalError = null,
        public bool $missingUserObjectLogged = false,
    ) {
    }
}
