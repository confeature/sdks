<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

use Confeature\Internal\Evaluator;
use Confeature\Internal\OverrideEval;

/**
 * Immutable view of the last-fetched config + a reference to overrides.
 *
 * All methods are synchronous. `getValue` consults overrides FIRST
 * via `OverrideEval::evaluate` (the full-config-aware router, spec 135 /
 * #432), then falls through to the cached config + evaluator. This is the
 * spec-036 correctness path that the PHP SDK inherits from day one.
 */
final class Snapshot
{
    public function __construct(
        /** @var array<string, mixed>|null */
        private readonly ?array $config,
        private readonly ?FlagOverrides $flagOverrides,
        private readonly ?User $defaultUser = null,
    ) {
    }

    public function getValue(string $key, mixed $default, ?User $user = null): mixed
    {
        $effectiveUser = $user ?? $this->defaultUser;

        // Override path FIRST — spec 036 correctness. The router (spec 135 /
        // #432) threads the user so a full-config override source resolves
        // targeting rules through the real evaluator; the flat-map source keeps
        // the byte-identical value-only path.
        [$found, $value] = OverrideEval::evaluate($this->flagOverrides, $key, $default, $effectiveUser);
        if ($found) {
            return $value;
        }

        return Evaluator::evaluate($this->config, $key, $default, $effectiveUser)->value;
    }

    /**
     * @return list<string>
     */
    public function getAllKeys(): array
    {
        $keys = [];
        if (\is_array($this->config) && isset($this->config['f']) && \is_array($this->config['f'])) {
            foreach (array_keys($this->config['f']) as $k) {
                if (\is_string($k)) {
                    $keys[] = $k;
                }
            }
        }
        if ($this->flagOverrides !== null) {
            try {
                $overrideMap = $this->flagOverrides->dataSource->getOverridesSync();
            } catch (\Throwable) {
                $overrideMap = null;
            }
            if (\is_array($overrideMap)) {
                foreach (array_keys($overrideMap) as $k) {
                    if (\is_string($k)) {
                        $keys[] = $k;
                    }
                }
            }
        }
        $keys = array_values(array_unique($keys));
        sort($keys);

        return $keys;
    }
}
