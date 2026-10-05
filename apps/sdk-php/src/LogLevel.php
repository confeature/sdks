<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Confeature log severity levels.
 *
 * Int values align with PSR-3 / RFC 5424 priority intent (lower
 * value = more verbose), but the API is a stable constant surface
 * — customers compare against these constants rather than the
 * underlying integers. `OFF` is the sentinel that disables
 * logging entirely.
 *
 * Mirrors `Confeature\LogLevel` from the upstream `configcat/
 * configcat-php-sdk` package (Constitution Principle II).
 */
final class LogLevel
{
    public const DEBUG = 0;
    public const INFO = 1;
    public const WARNING = 2;
    public const ERROR = 3;
    public const OFF = 6;

    /**
     * Prevent instantiation — this is a constant holder.
     */
    private function __construct()
    {
    }

    /**
     * @return list<int>
     */
    public static function all(): array
    {
        return [self::DEBUG, self::INFO, self::WARNING, self::ERROR, self::OFF];
    }
}
