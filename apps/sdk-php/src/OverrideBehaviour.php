<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * How flag overrides interact with the remote config.
 *
 * Only `LOCAL_ONLY` is wired in v1 — `LOCAL_OVER_REMOTE` and
 * `REMOTE_OVER_LOCAL` are accepted at the type level so customer
 * code referencing the constants compiles, but they fall through to
 * the non-override evaluation path (matches the Python / Go / Ruby
 * ports — see spec 031 §R8).
 *
 * Mirrors `Confeature\OverrideBehaviour` from the upstream
 * `configcat/configcat-php-sdk` package.
 */
final class OverrideBehaviour
{
    public const LOCAL_ONLY = 0;
    public const LOCAL_OVER_REMOTE = 1;
    public const REMOTE_OVER_LOCAL = 2;

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
        return [self::LOCAL_ONLY, self::LOCAL_OVER_REMOTE, self::REMOTE_OVER_LOCAL];
    }

    public static function isValid(int $behaviour): bool
    {
        return \in_array($behaviour, self::all(), true);
    }
}
