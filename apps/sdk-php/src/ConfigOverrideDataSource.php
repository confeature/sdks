<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Full-config override source — holds a complete parsed `config_v6`
 * blob (`{p, f, s}`) and routes through the real evaluator offline.
 *
 * Spec 135 / #432 (epic #382, US3): the rule-bearing sibling of
 * {@see MapOverrideDataSource}. Where the map source emits value-only
 * settings, this source retains the WHOLE `{p, f, s}` config — salt
 * (`p.s`) + segments (`s`) + rule-bearing settings (`f`) — so the
 * `Confeature\Internal\Evaluator` can resolve targeting rules / segments /
 * prerequisites / percentage options purely from the supplied config, no
 * network fetch.
 *
 * Additive extension (Principle II): ConfigCat's official PHP SDK only
 * exposes a *file-based* full-config override
 * (`ConfigCat\Override\LocalFileDataSource`). This in-memory form is the
 * runtime-agnostic equivalent, mirroring the JS federation's
 * `ConfigOverrideDataSource` / `createFlagOverridesFromConfig`, sdk-python's
 * `ConfigOverrideDataSource`, and sdk-dotnet's `ConfigOverrideDataSource`.
 * No ConfigCat-named member is renamed or retyped.
 *
 * The whole config array is retained (never just `f`) — INV-4, the spec-129
 * dropped-salt regression guard: percentage bucketing reads `p.s` and segment
 * conditions read `s`.
 *
 * `getOverridesSync()` returns the value-only base envelopes of the settings
 * (each setting's `v`) so `getAllKeys` / `getAllValues` can enumerate the
 * override's flag keys; rule resolution itself never goes through this flat
 * map — the override router ({@see \Confeature\Internal\OverrideEval}) dispatches
 * on the source TYPE so a `ConfigOverrideDataSource` always routes the FULL
 * config through the evaluator, never the flat-map path.
 */
final class ConfigOverrideDataSource implements OverrideDataSource
{
    /** @var array<string, mixed> */
    private readonly array $config;

    /** @var array<string, SettingValue> */
    private readonly array $baseValues;

    /**
     * @param array<string, mixed> $config The parsed full `config_v6` blob (`{p, f, s}`).
     */
    public function __construct(array $config)
    {
        $this->config = $config;

        $baseValues = [];
        $settings = $config['f'] ?? null;
        if (\is_array($settings)) {
            foreach ($settings as $key => $setting) {
                if (!\is_string($key) || !\is_array($setting)) {
                    continue;
                }
                $value = self::baseValueOf($setting['v'] ?? null);
                if ($value !== null) {
                    $baseValues[$key] = $value;
                }
            }
        }
        $this->baseValues = $baseValues;
    }

    /**
     * The full parsed `config_v6` blob (`{p, f, s}`). Consumed by the
     * full-config override router; never read for the flat-map path.
     *
     * @return array<string, mixed>
     */
    public function config(): array
    {
        return $this->config;
    }

    /**
     * Returns the value-only base envelopes of the settings (each setting's
     * `v`), so `getAllKeys` / `getAllValues` can enumerate the override's flag
     * keys. Resolution itself never goes through this map — the router
     * evaluates the full config through the real evaluator.
     *
     * @return array<string, SettingValue>
     */
    public function getOverridesSync(): ?array
    {
        return $this->baseValues;
    }

    private static function baseValueOf(mixed $raw): ?SettingValue
    {
        if (!\is_array($raw)) {
            return null;
        }
        $b = \is_bool($raw['b'] ?? null) ? $raw['b'] : null;
        $s = \is_string($raw['s'] ?? null) ? $raw['s'] : null;
        $i = \is_int($raw['i'] ?? null) ? $raw['i'] : null;
        $d = \is_float($raw['d'] ?? null) ? $raw['d'] : (\is_int($raw['d'] ?? null) ? (float) $raw['d'] : null);

        if ($b === null && $s === null && $i === null && $d === null) {
            return null;
        }

        return new SettingValue(b: $b, s: $s, i: $i, d: $d);
    }
}
