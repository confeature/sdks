<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Public SDK version, surfaced as the `User-Agent` token and exposed
 * as `Confeature\Version::SDK`. The major version tracks the
 * Confeature API contract major version this SDK implements
 * (Constitution Principle VI).
 */
final class Version
{
    public const SDK = '0.1.0';

    /**
     * Prevent instantiation — this is a value holder, not a service.
     */
    private function __construct()
    {
    }
}
