<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

use Confeature\ConfigOverrideDataSource;
use Confeature\FlagOverrides;
use Confeature\OverrideBehaviour;
use Confeature\SettingValue;
use Confeature\User;
use Psr\Log\LoggerInterface;

/**
 * Synchronous override evaluation — PHP port of `EvaluateSync`.
 *
 * Byte-identical 7-branch decision tree from:
 *   - `apps/sdk-go/internal/overrideeval/eval.go` (Go reference port)
 *   - `packages/sdk-shared/src/override-eval.ts` (TS canonical)
 *   - `apps/sdk-python/src/confeature_client/override_eval.py`
 *   - `apps/sdk-ruby/lib/confeature/internal/override_eval.rb`
 *
 * The value-only path takes override data and returns a [bool $found, mixed $value]
 * tuple. The strict details path also classifies source failures.
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

    /** @internal Resolves LocalOnly details, preserving the native flat override contract. */
    public static function evaluateDetails(
        FlagOverrides $overrides,
        string $key,
        mixed $default,
        ?User $user,
        bool $strict,
        LoggerInterface $logger,
    ): EvaluationResult {
        if ($overrides->dataSource instanceof ConfigOverrideDataSource) {
            return Evaluator::evaluate($overrides->dataSource->config(), $key, $default, $user);
        }

        if ($strict) {
            return self::evaluateStrictDetails($overrides, $key, $default, $logger);
        }

        [$found, $value] = self::evaluateSync($overrides, $key, $default);
        // Legacy details recheck presence because the value-only path returns
        // the default both for a missing slot and for a mistyped value.
        try {
            $map = $overrides->dataSource->getOverridesSync();
            $present = $map !== null && \array_key_exists($key, $map);
        } catch (\Throwable) {
            // The native details contract treats a failed presence recheck as a missing key.
            $logger->warning('ConfeatureClient: LocalOnly override presence check failed.');
            $present = false;
        }

        return $found && $present
            ? new EvaluationResult($value)
            : EvaluationResult::failed($default, 'KEY_NOT_FOUND', EvaluationFailure::FlagNotFound);
    }

    private static function evaluateStrictDetails(
        FlagOverrides $overrides,
        string $key,
        mixed $default,
        LoggerInterface $logger,
    ): EvaluationResult {
        // A custom source can return a different map on each read. Derive
        // presence, type and value from one snapshot for provider details.
        try {
            $map = $overrides->dataSource->getOverridesSync();
        } catch (\Throwable) {
            $logger->warning('ConfeatureClient: LocalOnly override source failed.');

            return EvaluationResult::failed($default, 'OVERRIDE_SOURCE_ERROR', EvaluationFailure::General);
        }

        if ($map === null) {
            return EvaluationResult::failed($default, 'NO_CONFIG', EvaluationFailure::NotReady);
        }
        if (!\array_key_exists($key, $map)) {
            return EvaluationResult::failed($default, 'KEY_NOT_FOUND', EvaluationFailure::FlagNotFound);
        }

        $slot = $map[$key];
        if (!$slot instanceof SettingValue || !self::hasSingleValue($slot)) {
            return EvaluationResult::failed($default, 'MALFORMED_VALUE', EvaluationFailure::ParseError);
        }
        $value = $slot->picked();
        if (!self::sameKind($value, $default)) {
            return EvaluationResult::failed($default, 'TYPE_MISMATCH', EvaluationFailure::TypeMismatch);
        }

        return new EvaluationResult($value);
    }

    private static function hasSingleValue(SettingValue $slot): bool
    {
        $populated = (int) ($slot->b !== null) + (int) ($slot->s !== null)
            + (int) ($slot->i !== null) + (int) ($slot->d !== null);

        return $populated === 1;
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
