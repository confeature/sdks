<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Confeature\EvaluationDetails;

/** @internal Carries the failure classification alongside the native hook payload. */
final class DetailsEvaluationResult
{
    public function __construct(
        public readonly EvaluationDetails $details,
        public readonly ?EvaluationFailure $failure,
    ) {
    }
}
