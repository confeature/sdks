<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Three-valued THEN consequence (MATCH / no match / error string) for the
 * eval-log trace. Mirrors the TS `boolean | string` union and the Python /
 * Ruby ports' `_MatchOrError`. `$kind` is {@link MATCH} / {@link NO_MATCH} /
 * {@link ERRORED}; `$errText` carries the reason for the error case.
 */
final class MatchOrError
{
    public const MATCH = 'match';
    public const NO_MATCH = 'no_match';
    public const ERRORED = 'errored';

    private function __construct(
        public readonly string $kind,
        public readonly string $errText = '',
    ) {
    }

    public static function match(): self
    {
        return new self(self::MATCH);
    }

    public static function noMatch(): self
    {
        return new self(self::NO_MATCH);
    }

    public static function error(string $text): self
    {
        return new self(self::ERRORED, $text);
    }
}
