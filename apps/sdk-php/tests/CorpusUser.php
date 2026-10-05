<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

/**
 * Targeting-context value object for the upstream conformance corpus whose
 * custom attributes stay TYPED (spec 121).
 *
 * The public `Confeature\User` stringifies custom values (its documented
 * contract); the conversion-driver cases feed numbers / arrays / epochs that
 * MUST reach the comparator layer un-stringified. The evaluator reads
 * attributes duck-typed (`identifier`/`email`/`country`/`custom` properties —
 * see `Evaluator::getUserAttribute`), so this stand-in is sufficient and
 * avoids redesigning the public surface. Mirrors the Ruby `CorpusUser`
 * struct / the Python conformance harness `User`.
 */
final class CorpusUser
{
    /**
     * @param ?array<string, mixed> $custom
     */
    public function __construct(
        public readonly string $identifier = '',
        public readonly ?string $email = null,
        public readonly ?string $country = null,
        public readonly ?array $custom = null,
    ) {
    }
}
