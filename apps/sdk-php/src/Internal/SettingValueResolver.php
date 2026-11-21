<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/** @internal Enforces Config V2 value types for static, targeted and percentage values. */
final class SettingValueResolver
{
    public const SETTING_TYPE_BOOL = 0;
    public const SETTING_TYPE_STRING = 1;
    public const SETTING_TYPE_INT = 2;
    public const SETTING_TYPE_DOUBLE = 3;

    public static function matchesType(int $settingType, mixed $value): bool
    {
        return match ($settingType) {
            self::SETTING_TYPE_BOOL => \is_bool($value),
            self::SETTING_TYPE_STRING => \is_string($value),
            self::SETTING_TYPE_INT => \is_int($value),
            self::SETTING_TYPE_DOUBLE => \is_float($value),
            // Unknown discriminators keep their legacy UNSUPPORTED_TYPE evaluation path.
            default => true,
        };
    }

    /**
     * @param array<string, mixed> $valueSlot
     */
    public static function resolve(
        int $settingType,
        array $valueSlot,
        mixed $defaultValue,
        ?string $variationId,
        SettingResult $result,
        ?string $evalError,
    ): EvaluationResult {
        $field = match ($settingType) {
            self::SETTING_TYPE_BOOL => 'b',
            self::SETTING_TYPE_STRING => 's',
            self::SETTING_TYPE_INT => 'i',
            self::SETTING_TYPE_DOUBLE => 'd',
            default => null,
        };
        if ($field === null) {
            return EvaluationResult::failed($defaultValue, 'UNSUPPORTED_TYPE', EvaluationFailure::ParseError);
        }

        $value = $valueSlot[$field] ?? null;
        // JSON decoding represents integral numbers as integers, even in a double setting.
        if ($settingType === self::SETTING_TYPE_DOUBLE && \is_int($value)) {
            $value = (float) $value;
        }
        if (!self::matchesType($settingType, $value)) {
            $error = $settingType === self::SETTING_TYPE_BOOL ? 'VALUE_NOT_BOOL' : 'MALFORMED_VALUE';

            return EvaluationResult::failed($defaultValue, $error, EvaluationFailure::ParseError);
        }

        return new EvaluationResult(
            $value,
            null,
            $variationId,
            $result->matchedRule,
            $result->matchedOption,
            $evalError,
        );
    }

    private function __construct()
    {
    }
}
