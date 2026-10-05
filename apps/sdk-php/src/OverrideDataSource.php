<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Contract every override data source MUST implement.
 *
 * `getOverridesSync` returns a flat map of `string => SettingValue`
 * (or `null` when no synchronous data is available — Branch 3 of the
 * 7-branch override-eval decision tree).
 *
 * Mirrors `Confeature\Override\OverrideDataSource` from the upstream
 * `configcat/configcat-php-sdk` package (Constitution Principle II).
 */
interface OverrideDataSource
{
    /**
     * @return array<string, SettingValue>|null
     */
    public function getOverridesSync(): ?array;
}
