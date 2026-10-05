<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Confeature\ConfigOverrideDataSource;
use Confeature\FlagOverrides;
use Confeature\OverrideBehaviour;
use Confeature\User;

/**
 * Synchronous override evaluation — PHP port of `EvaluateSync`.
 *
 * Byte-identical 7-branch decision tree from:
 *   - `apps/sdk-go/internal/overrideeval/eval.go` (Go reference port)
 *   - `packages/sdk-shared/src/override-eval.ts` (TS canonical)
 *   - `apps/sdk-python/src/confeature_client/override_eval.py`
 *   - `apps/sdk-ruby/lib/confeature/internal/override_eval.rb`
 *
 * The helper is intentionally pure: no logger access, no SDK-key
 * access, no I/O. Pure data in → `[bool $found, mixed $value]` out.
 *
 * Returns:
 *   - `[false, null]` when overrides are absent, behaviour is
 *     non-LocalOnly, or no synchronous data source is available
 *     (Branches 1-3: caller falls through to the cache).
 *   - `[true, <value>]` when overrides + LocalOnly + key match
 *     (Branch 7 — typed override value); also `[true, $defaultValue]`
 *     for the LocalOnly fallback branches 4-6.
 */
final class OverrideEval
{
    /**
     * Prevent instantiation — pure helper.
     */
    private function __construct()
    {
    }

    /**
     * Walk the 7-branch decision tree.
     *
     * @return array{0: bool, 1: mixed} A `[found, value]` tuple.
     */
    public static function evaluateSync(
        ?FlagOverrides $flagOverrides,
        string $key,
        mixed $defaultValue,
    ): array {
        // Branch 1: no overrides configured → caller falls through.
        if ($flagOverrides === null) {
            return [false, null];
        }

        // Branch 2: non-LocalOnly behaviours short-circuit (spec 031 §R8).
        if ($flagOverrides->behaviour !== OverrideBehaviour::LOCAL_ONLY) {
            return [false, null];
        }

        // Branch 3: no synchronous data source or nil map → fall through.
        $dataSource = $flagOverrides->dataSource;
        $map = $dataSource->getOverridesSync();
        if ($map === null) {
            return [false, null];
        }

        // From here we are committed to the LocalOnly contract: NEVER
        // fall through to the cache — return either the typed override
        // or the supplied default.

        // Branch 4: key absent → return default.
        if (!\array_key_exists($key, $map)) {
            return [true, $defaultValue];
        }

        // Branch 5: override slot empty → return default.
        $candidate = $map[$key]->picked();
        if ($candidate === null) {
            return [true, $defaultValue];
        }

        // Branch 6: TYPE_MISMATCH — primitive types diverge → return default.
        // A `null` default intentionally bypasses the check (matches
        // configcat-js's `defaultValue !== null` ternary). PHP's
        // `gettype()` distinguishes bool/int/double/string cleanly —
        // we use it instead of `is_*` chains for stable single-string
        // comparison.
        if ($defaultValue !== null && !self::sameKind($candidate, $defaultValue)) {
            return [true, $defaultValue];
        }

        // Branch 7: happy path — typed override value.
        return [true, $candidate];
    }

    /**
     * Shared override router — PHP port of `evaluateOverride`
     * (spec 135 / #432, epic #382, US3).
     *
     * Dispatches between the flat-map path and the full-config path so the
     * `getValue` call site changes minimally: a {@see ConfigOverrideDataSource}
     * routes the FULL config through the real evaluator (so targeting rules /
     * segments / prerequisites / percentage options apply offline); every
     * other source (map / custom) keeps the existing byte-identical flat-map
     * resolution.
     *
     * Dispatch is on the source TYPE, not the resolved value — a full-config
     * source whose evaluator returns the default still stays on the rule path,
     * NEVER falling back to the flat-map path (which would mis-read rule-bearing
     * settings as value-only). Both paths preserve the LocalOnly no-fall-through
     * contract.
     *
     * @return array{0: bool, 1: mixed} A `[found, value]` tuple; `[false, null]`
     *                                  means "fall through to the cache".
     */
    public static function evaluate(
        ?FlagOverrides $flagOverrides,
        string $key,
        mixed $defaultValue,
        ?User $user,
    ): array {
        if (
            $flagOverrides !== null
            && $flagOverrides->behaviour === OverrideBehaviour::LOCAL_ONLY
            && $flagOverrides->dataSource instanceof ConfigOverrideDataSource
        ) {
            return self::evaluateFullConfigSync(
                $flagOverrides->dataSource,
                $key,
                $defaultValue,
                $user,
            );
        }

        // Every other source (map / custom) keeps the byte-identical flat-map
        // path; the user is irrelevant there (value-only resolution).
        return self::evaluateSync($flagOverrides, $key, $defaultValue);
    }

    /**
     * Full-config override resolution — PHP port of
     * `evaluateFullConfigOverrideSync` (spec 135 / #432).
     *
     * Resolves `$key` through the real `Confeature\Internal\Evaluator` so
     * targeting rules / segments / prerequisites / percentage options apply
     * offline — the rule-bearing sibling of {@see evaluateSync}'s flat lookup.
     *
     * The evaluator receives the FULL config array (`{p, f, s}`) — salt
     * (`p.s`) + segments (`s`), never just `f` (INV-4, the spec-129
     * dropped-salt regression class). The evaluator never throws; any failure
     * resolves to `$defaultValue`. LocalOnly contract: the result is always
     * `[true, <value>]`, never falling through to the cache.
     *
     * @return array{0: bool, 1: mixed} Always `[true, <value>]`.
     */
    private static function evaluateFullConfigSync(
        ConfigOverrideDataSource $dataSource,
        string $key,
        mixed $defaultValue,
        ?User $user,
    ): array {
        $result = Evaluator::evaluate($dataSource->config(), $key, $defaultValue, $user);

        return [true, $result->value];
    }

    private static function sameKind(mixed $a, mixed $b): bool
    {
        return get_debug_type($a) === get_debug_type($b);
    }
}
