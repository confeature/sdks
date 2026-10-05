<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * A malformed CONFIG comparison value (#509). configcat-common validates the
 * operand BEFORE the user attribute for the semver relations, number
 * relations, and datetime comparators; a malformed operand surfaces this
 * distinct `comparison value '<v>' is invalid (<reason>)` outcome (NO "please
 * check the User.<attr>…" suffix — the fault is in the config, not the user)
 * which wins even when the attribute is ALSO malformed. It short-circuits the
 * AND group like `false`.
 *
 * Mirrors the spec-117 TS `ComparisonValueError` arm and the Python /
 * Ruby ports. Distinct from {@link ValidationError} only so the trace seam can
 * route it to the WARN 3004 `comparisonValueIsInvalid` log site rather than the
 * `userObjectAttributeIsInvalid` one.
 */
final class ComparisonValueError
{
    public function __construct(
        public readonly string $message,
    ) {
    }
}
