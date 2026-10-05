<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * In-memory map-backed override source — the production default.
 *
 * Converts each primitive value to a `SettingValue` slot once at
 * construction time and returns the same map on every call (stable
 * identity).
 *
 * Mirrors `Confeature\Override\MapOverrideDataSource` from the
 * upstream `configcat/configcat-php-sdk` package, with a static
 * `ofMap` factory matching the Java/PHP idiom in the ConfigCat
 * surface.
 */
final class MapOverrideDataSource implements OverrideDataSource
{
    /** @var array<string, SettingValue> */
    private readonly array $map;

    /**
     * @param array<string, SettingValue> $map
     */
    private function __construct(array $map)
    {
        $this->map = $map;
    }

    /**
     * Build a MapOverrideDataSource from a flat `key => primitive` map.
     *
     * Accepted primitive value types: `bool`, `int`, `float`, `string`.
     * Anything else raises `InvalidArgumentException` at construction —
     * fail loud, never silently coerce.
     *
     * @param array<string, bool|int|float|string> $map
     */
    public static function ofMap(array $map): self
    {
        $out = [];
        foreach ($map as $key => $value) {
            $out[(string) $key] = self::toSettingValue($value);
        }

        return new self($out);
    }

    /**
     * @return array<string, SettingValue>
     */
    public function getOverridesSync(): ?array
    {
        return $this->map;
    }

    private static function toSettingValue(mixed $value): SettingValue
    {
        // Order matters — `is_int(true)` is false in PHP, but checking
        // `is_bool` first is more legible and mirrors the Python /
        // Ruby ports.
        if (\is_bool($value)) {
            return new SettingValue(b: $value);
        }
        if (\is_int($value)) {
            return new SettingValue(i: $value);
        }
        if (\is_float($value)) {
            return new SettingValue(d: $value);
        }
        if (\is_string($value)) {
            return new SettingValue(s: $value);
        }

        throw new \InvalidArgumentException(
            'Unsupported override value type: ' . get_debug_type($value)
            . '. Supported types are bool, int, float, string.'
        );
    }
}
