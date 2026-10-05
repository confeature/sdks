<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * A validation / conversion failure outcome (surfaced, not silent). The
 * condition dispatch returns one of these instead of `true`/`false` when a
 * typed-attribute conversion fails (FR-010). Mirrors the spec-117 TS
 * `ConditionOutcome`'s `{ error }` arm and the Ruby `ValidationError`
 * struct. An error short-circuits the AND group like `false` but is
 * surfaced via `EvaluationResult::evalError`.
 */
final class ValidationError
{
    public function __construct(
        public readonly string $message,
    ) {
    }
}
