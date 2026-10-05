<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * The 36 ConfigCat `UserComparator` operations + attribute conversion.
 * Ported field-for-field from the spec-117 TS reference
 * (`packages/sdk-shared/src/comparators.ts`), cross-checked against the
 * spec-118/119/120 Python / Go / Ruby ports, itself verified against
 * common-js `RolloutEvaluator.ts` (`configcat-common@9.4.1`).
 *
 * Each comparator returns a three-valued outcome: `true` (match), `false`
 * (no match), or a {@link ValidationError} (a validation / conversion
 * failure — bad semver, non-numeric number, non-array array). An error
 * short-circuits the AND group like `false` but is surfaced rather than
 * silently swallowed (FR-010).
 *
 * The six families: text (cleartext, case-SENSITIVE, no trim); sensitive
 * text (SHA-256 SALTED, length-prefixed slice variants); semver (on
 * {@link Semver::parse}); number (strict whole-string parse, `,`→`.`);
 * datetime (Before/After, Unix seconds); array (contains/notContains,
 * cleartext + sensitive).
 */
final class Comparators
{
    // UserComparator discriminators (mirror config-json.ts UserComparator).
    public const TEXT_IS_ONE_OF = 0;
    public const TEXT_IS_NOT_ONE_OF = 1;
    public const TEXT_CONTAINS_ANY_OF = 2;
    public const TEXT_NOT_CONTAINS_ANY_OF = 3;
    public const SEMVER_IS_ONE_OF = 4;
    public const SEMVER_IS_NOT_ONE_OF = 5;
    public const SEMVER_LESS = 6;
    public const SEMVER_LESS_OR_EQUALS = 7;
    public const SEMVER_GREATER = 8;
    public const SEMVER_GREATER_OR_EQUALS = 9;
    public const NUMBER_EQUALS = 10;
    public const NUMBER_NOT_EQUALS = 11;
    public const NUMBER_LESS = 12;
    public const NUMBER_LESS_OR_EQUALS = 13;
    public const NUMBER_GREATER = 14;
    public const NUMBER_GREATER_OR_EQUALS = 15;
    public const SENSITIVE_TEXT_IS_ONE_OF = 16;
    public const SENSITIVE_TEXT_IS_NOT_ONE_OF = 17;
    public const DATETIME_BEFORE = 18;
    public const DATETIME_AFTER = 19;
    public const SENSITIVE_TEXT_EQUALS = 20;
    public const SENSITIVE_TEXT_NOT_EQUALS = 21;
    public const SENSITIVE_TEXT_STARTS_WITH_ANY_OF = 22;
    public const SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF = 23;
    public const SENSITIVE_TEXT_ENDS_WITH_ANY_OF = 24;
    public const SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF = 25;
    public const SENSITIVE_ARRAY_CONTAINS_ANY_OF = 26;
    public const SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF = 27;
    public const TEXT_EQUALS = 28;
    public const TEXT_NOT_EQUALS = 29;
    public const TEXT_STARTS_WITH_ANY_OF = 30;
    public const TEXT_NOT_STARTS_WITH_ANY_OF = 31;
    public const TEXT_ENDS_WITH_ANY_OF = 32;
    public const TEXT_NOT_ENDS_WITH_ANY_OF = 33;
    public const ARRAY_CONTAINS_ANY_OF = 34;
    public const ARRAY_NOT_CONTAINS_ANY_OF = 35;

    private function __construct()
    {
    }

    public static function error(string $message): ValidationError
    {
        return new ValidationError($message);
    }

    /**
     * True iff `$value` is a list whose every element is a string
     * (common-js `isStringArray`).
     */
    public static function isStringArray(mixed $value): bool
    {
        if (!\is_array($value)) {
            return false;
        }
        foreach ($value as $e) {
            if (!\is_string($e)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Stringify a user-attribute value (ConfigCat
     * `RolloutEvaluator::userAttributeValueToString`): string verbatim;
     * number → canonical string; `DateTimeInterface` → epoch-seconds canonical
     * string (the second-based Unix timestamp); string array → JSON (compact,
     * no spaces); bool → "true"/"false"; else cast to string.
     *
     * Ordering mirrors upstream: the numeric branch precedes the DateTime
     * branch, and a bool (which is neither string/number/Date/array) falls
     * through to the lowercase literal.
     */
    public static function userAttributeValueToString(mixed $value): string
    {
        if (\is_string($value)) {
            return $value;
        }
        if ((\is_int($value) || \is_float($value)) && !\is_bool($value)) {
            return self::numberToCanonicalString((float) $value);
        }
        if ($value instanceof \DateTimeInterface) {
            $seconds = self::dateTimeToUnixTimeSeconds($value);
            if ($seconds !== null) {
                return self::numberToCanonicalString($seconds);
            }
        }
        if (\is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (self::isStringArray($value)) {
            $json = json_encode($value, \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE);

            return $json === false ? '' : $json;
        }

        return (string) $value; // @phpstan-ignore-line cast.string
    }

    /**
     * Convert a `DateTimeInterface` to a second-based Unix timestamp, mirroring
     * ConfigCat `Utils::dateTimeToUnixTimeSeconds` exactly: `format('U\.v')`
     * yields `seconds.milliseconds` (millisecond precision), and values outside
     * `0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z` are rejected
     * (returns null).
     */
    private static function dateTimeToUnixTimeSeconds(\DateTimeInterface $dateTime): ?float
    {
        $timestamp = (float) $dateTime->format('U\.v');

        return ($timestamp < -62135596800 || $timestamp >= 253402300800) ? null : $timestamp;
    }

    /**
     * Stringify a number as ConfigCat's canonical string (JS
     * `Number::toString`). NaN / ±Infinity print as "NaN" / "Infinity" /
     * "-Infinity"; otherwise the SHORTEST round-tripping digit sequence,
     * fixed-point unless the magnitude warrants exponential. The corpus
     * `numberToStringConversion*` cases hinge on this — e.g.
     * `-1.23456789e+96` must NOT expand to its full integer form.
     */
    public static function numberToCanonicalString(float $value): string
    {
        if (is_nan($value)) {
            return 'NaN';
        }
        if (is_infinite($value)) {
            return $value > 0 ? 'Infinity' : '-Infinity';
        }
        if ($value === 0.0) {
            return '0';
        }

        return self::jsNumberToString($value);
    }

    /**
     * Render a finite non-zero float exactly as ECMAScript
     * `Number::toString`.
     */
    private static function jsNumberToString(float $value): string
    {
        $sign = $value < 0 ? '-' : '';
        $av = abs($value);
        [$digits, $point] = self::shortestDigitsAndPoint($av);
        $k = \strlen($digits);
        $n = $point;

        if ($n >= $k && $n <= 21) {
            return $sign . $digits . str_repeat('0', $n - $k);
        }
        if ($n > 0 && $n <= 21) {
            return $sign . substr($digits, 0, $n) . '.' . substr($digits, $n);
        }
        if ($n > -6 && $n <= 0) {
            return $sign . '0.' . str_repeat('0', -$n) . $digits;
        }
        $e = $n - 1;
        $expSign = $e >= 0 ? '+' : '-';
        $mant = $k === 1 ? $digits[0] : $digits[0] . '.' . substr($digits, 1);

        return $sign . $mant . 'e' . $expSign . abs($e);
    }

    /**
     * Decompose the shortest round-tripping repr of a positive float into
     * `[digits, point]` — `point` is the count of significant digits before
     * the decimal point in normalized form (the ECMAScript `n`). PHP's
     * `serialize_precision = -1` (default) makes `json_encode` /
     * `(string)` produce the shortest round-tripping representation.
     *
     * @return array{0: string, 1: int}
     */
    private static function shortestDigitsAndPoint(float $av): array
    {
        $shortest = self::shortestRepr($av);
        if (str_contains($shortest, 'e') || str_contains($shortest, 'E')) {
            $parts = explode('e', strtolower($shortest), 2);
            $mant = $parts[0];
            $expVal = (int) ($parts[1] ?? '0');
        } else {
            $mant = $shortest;
            $expVal = 0;
        }
        if (str_contains($mant, '.')) {
            [$intPart, $fracPart] = explode('.', $mant, 2);
        } else {
            $intPart = $mant;
            $fracPart = '';
        }
        $raw = $intPart . $fracPart;
        $point = \strlen($intPart) + $expVal;

        // Strip leading zeros (adjusting point), then trailing zeros.
        $lead = 0;
        $rawLen = \strlen($raw);
        while ($lead < $rawLen - 1 && $raw[$lead] === '0') {
            ++$lead;
            --$point;
        }
        $raw = substr($raw, $lead);
        $raw = rtrim($raw, '0');
        if ($raw === '') {
            $raw = '0';
        }

        return [$raw, $point];
    }

    /**
     * Shortest decimal representation of a positive finite float. PHP's
     * default `serialize_precision = -1` makes `var_export`-style output
     * shortest round-tripping; `(string)` casts honor `precision` (14) and
     * may lose digits, so we route through `json_encode` which honors
     * `serialize_precision`.
     */
    private static function shortestRepr(float $av): string
    {
        $json = json_encode($av);
        if ($json === false) {
            return (string) $av;
        }

        return $json;
    }

    /**
     * Strict whole-string float parse (common-js `parseFloatStrict`). Rejects
     * empty / all-whitespace and a leading `0` followed by a
     * non-digit/non-`.`/non-`e` (octal / hex). Returns NAN on rejection. JS's
     * `parseFloat` is too forgiving (prefix parse), so "12abc" is NaN.
     */
    public static function parseFloatStrict(string $value): float
    {
        if ($value === '' || preg_match('/^\s*$|^\s*0[^\d.eE]/', $value) === 1) {
            return \NAN;
        }

        // JS `+value` accepts "Infinity"/"-Infinity" and full-string floats.
        $stripped = trim($value);
        if ($stripped === 'Infinity') {
            return \INF;
        }
        if ($stripped === '-Infinity') {
            return -\INF;
        }
        if ($stripped === 'NaN') {
            return \NAN;
        }
        if (preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $stripped) !== 1) {
            return \NAN;
        }

        return (float) $stripped;
    }

    // -----------------------------------------------------------------------
    // Text — cleartext (case-sensitive, no trim)
    // -----------------------------------------------------------------------

    public static function evaluateTextEquals(string $text, string $comparisonValue, bool $negate): bool
    {
        return ($text === $comparisonValue) !== $negate;
    }

    /**
     * @param list<string> $comparisonValues
     */
    public static function evaluateTextIsOneOf(string $text, array $comparisonValues, bool $negate): bool
    {
        return \in_array($text, $comparisonValues, true) !== $negate;
    }

    /**
     * @param list<string> $comparisonValues
     */
    public static function evaluateTextContainsAnyOf(string $text, array $comparisonValues, bool $negate): bool
    {
        foreach ($comparisonValues as $item) {
            if (str_contains($text, $item)) {
                return !$negate;
            }
        }

        return $negate;
    }

    /**
     * Cleartext startsWith/endsWith-any-of. Items longer than text skipped.
     *
     * @param list<string> $comparisonValues
     */
    public static function evaluateTextSliceEqualsAnyOf(
        string $text,
        array $comparisonValues,
        bool $startsWith,
        bool $negate,
    ): bool {
        foreach ($comparisonValues as $item) {
            if (\strlen($text) < \strlen($item)) {
                continue;
            }
            $matched = $startsWith ? str_starts_with($text, $item) : str_ends_with($text, $item);
            if ($matched) {
                return !$negate;
            }
        }

        return $negate;
    }

    // -----------------------------------------------------------------------
    // Text — sensitive (SHA-256 salted)
    // -----------------------------------------------------------------------

    public static function evaluateSensitiveTextEquals(
        string $text,
        string $comparisonValue,
        string $configSalt,
        string $contextSalt,
        bool $negate,
    ): bool {
        $hash = Hashing::hashComparisonValue($text, $configSalt, $contextSalt);

        return ($hash === $comparisonValue) !== $negate;
    }

    /**
     * @param list<string> $comparisonValues
     */
    public static function evaluateSensitiveTextIsOneOf(
        string $text,
        array $comparisonValues,
        string $configSalt,
        string $contextSalt,
        bool $negate,
    ): bool {
        $hash = Hashing::hashComparisonValue($text, $configSalt, $contextSalt);

        return \in_array($hash, $comparisonValues, true) !== $negate;
    }

    /**
     * Sensitive startsWith/endsWith-any-of. Each operand is
     * "<byteLen>_<hash>"; the SDK hashes the matching-length BYTE
     * prefix/suffix of the attribute and compares to <hash>. Slicing is over
     * the UTF-8 byte sequence (not code points), matching common-js.
     *
     * @param list<string> $comparisonValues
     */
    public static function evaluateSensitiveTextSliceEqualsAnyOf(
        string $text,
        array $comparisonValues,
        string $configSalt,
        string $contextSalt,
        bool $startsWith,
        bool $negate,
    ): bool {
        $textLen = \strlen($text); // byte length — PHP strings are byte arrays
        foreach ($comparisonValues as $item) {
            $index = strpos($item, '_');
            if ($index === false) {
                continue;
            }
            $sliceLengthStr = substr($item, 0, $index);
            if (preg_match('/^\d+$/', $sliceLengthStr) !== 1) {
                continue;
            }
            $sliceLength = (int) $sliceLengthStr;
            if ($textLen < $sliceLength) {
                continue;
            }
            $sliceUtf8 = $startsWith
                ? substr($text, 0, $sliceLength)
                : substr($text, $textLen - $sliceLength);
            $hash = Hashing::hashComparisonValueSlice($sliceUtf8, $configSalt, $contextSalt);
            if ($hash === substr($item, $index + 1)) {
                return !$negate;
            }
        }

        return $negate;
    }

    // -----------------------------------------------------------------------
    // Semver
    // -----------------------------------------------------------------------

    /**
     * Semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5). Each operand is
     * trimmed first; an operand that is empty AFTER trimming (incl.
     * whitespace-only) is skipped — matching ConfigCat, which trims before the
     * empty check. A non-empty but unparseable operand makes the whole
     * comparator `false` (backward-compat). Iterates ALL operands (no
     * early-out on match).
     *
     * @param list<string> $comparisonValues
     */
    public static function evaluateSemverIsOneOf(Semver $version, array $comparisonValues, bool $negate): bool
    {
        $result = false;
        foreach ($comparisonValues as $item) {
            $item = trim($item);
            if ($item === '') {
                continue;
            }
            $version2 = Semver::parse($item);
            if ($version2 === null) {
                return false;
            }
            if (!$result && $version->compare($version2) === 0) {
                $result = true;
            }
        }

        return $result !== $negate;
    }

    /**
     * Semver relations (comparators 6-9). Unparseable operand → `false`.
     */
    public static function evaluateSemverRelation(Semver $version, int $comparator, string $comparisonValue): bool
    {
        $version2 = Semver::parse(trim($comparisonValue));
        if ($version2 === null) {
            return false;
        }
        $cmp = $version->compare($version2);

        return match ($comparator) {
            self::SEMVER_LESS => $cmp < 0,
            self::SEMVER_LESS_OR_EQUALS => $cmp <= 0,
            self::SEMVER_GREATER => $cmp > 0,
            self::SEMVER_GREATER_OR_EQUALS => $cmp >= 0,
            default => false,
        };
    }

    // -----------------------------------------------------------------------
    // Number
    // -----------------------------------------------------------------------

    public static function evaluateNumberRelation(float $num, int $comparator, float $comparisonValue): bool
    {
        return match ($comparator) {
            self::NUMBER_EQUALS => $num === $comparisonValue,
            self::NUMBER_NOT_EQUALS => $num !== $comparisonValue,
            self::NUMBER_LESS => $num < $comparisonValue,
            self::NUMBER_LESS_OR_EQUALS => $num <= $comparisonValue,
            self::NUMBER_GREATER => $num > $comparisonValue,
            self::NUMBER_GREATER_OR_EQUALS => $num >= $comparisonValue,
            default => false,
        };
    }

    // -----------------------------------------------------------------------
    // Datetime (Unix seconds)
    // -----------------------------------------------------------------------

    public static function evaluateDatetimeRelation(float $seconds, float $comparisonValue, bool $before): bool
    {
        return $before ? $seconds < $comparisonValue : $seconds > $comparisonValue;
    }

    // -----------------------------------------------------------------------
    // Array (cleartext + sensitive)
    // -----------------------------------------------------------------------

    /**
     * @param list<string> $array
     * @param list<string> $comparisonValues
     */
    public static function evaluateArrayContainsAnyOf(array $array, array $comparisonValues, bool $negate): bool
    {
        foreach ($array as $item) {
            if (\in_array($item, $comparisonValues, true)) {
                return !$negate;
            }
        }

        return $negate;
    }

    /**
     * @param list<string> $array
     * @param list<string> $comparisonValues
     */
    public static function evaluateSensitiveArrayContainsAnyOf(
        array $array,
        array $comparisonValues,
        string $configSalt,
        string $contextSalt,
        bool $negate,
    ): bool {
        foreach ($array as $item) {
            $hash = Hashing::hashComparisonValue($item, $configSalt, $contextSalt);
            if (\in_array($hash, $comparisonValues, true)) {
                return !$negate;
            }
        }

        return $negate;
    }

    // -----------------------------------------------------------------------
    // Attribute → typed value, with three-valued error outcome (FR-010)
    // -----------------------------------------------------------------------

    private static function invalidAttr(string $attr, string $reason): ValidationError
    {
        return self::error("cannot evaluate, the User.{$attr} attribute is invalid ({$reason})");
    }

    /** Attribute → text (string verbatim; else stringified — never errors). */
    public static function attributeAsText(mixed $value): string
    {
        return \is_string($value) ? $value : self::userAttributeValueToString($value);
    }

    /** Attribute → semver, or a validation error. */
    public static function attributeAsSemver(string $attr, mixed $value): Semver|ValidationError
    {
        if (\is_string($value)) {
            $version = Semver::parse(trim($value));
            if ($version !== null) {
                return $version;
            }
        }

        return self::invalidAttr(
            $attr,
            "'" . self::userAttributeValueToString($value) . "' is not a valid semantic version",
        );
    }

    /** Attribute → number, or a validation error. */
    public static function attributeAsNumber(string $attr, mixed $value): float|ValidationError
    {
        if (self::isNumericNonBool($value)) {
            return (float) $value;
        }
        if (\is_string($value)) {
            $num = self::parseFloatStrict(str_replace(',', '.', $value));
            if (!is_nan($num) || trim($value) === 'NaN') {
                return $num;
            }
        }

        return self::invalidAttr(
            $attr,
            "'" . self::userAttributeValueToString($value) . "' is not a valid decimal number",
        );
    }

    /**
     * Attribute → Unix seconds, or a validation error. A numeric attribute is
     * already seconds; a string is parsed strictly.
     */
    public static function attributeAsUnixTimeSeconds(string $attr, mixed $value): float|ValidationError
    {
        if ($value instanceof \DateTimeInterface) {
            $seconds = self::dateTimeToUnixTimeSeconds($value);
            if ($seconds !== null) {
                return $seconds;
            }
        }
        if (self::isNumericNonBool($value)) {
            return (float) $value;
        }
        if (\is_string($value)) {
            $num = self::parseFloatStrict(str_replace(',', '.', $value));
            if (!is_nan($num) || trim($value) === 'NaN') {
                return $num;
            }
        }

        return self::invalidAttr(
            $attr,
            "'" . self::userAttributeValueToString($value)
            . "' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)",
        );
    }

    /**
     * Attribute → string array, or a validation error. A string attribute is
     * JSON-parsed; the result must be a string array.
     *
     * @return list<string>|ValidationError
     */
    public static function attributeAsStringArray(string $attr, mixed $value): array|ValidationError
    {
        $arr = $value;
        if (\is_string($arr)) {
            $decoded = json_decode($arr, true);
            // A null decode result — whether from invalid JSON or the literal
            // JSON null `"null"` — falls through identically: neither yields a
            // valid string array (matches common-js no-op catch), so it lands
            // on the validation error below.
            if ($decoded !== null) {
                $arr = $decoded;
            }
        }
        if (self::isStringArray($arr)) {
            /** @var list<string> $arr */
            return array_values($arr);
        }

        return self::invalidAttr(
            $attr,
            "'" . self::userAttributeValueToString($value) . "' is not a valid string array",
        );
    }

    private static function isNumericNonBool(mixed $value): bool
    {
        return (\is_int($value) || \is_float($value)) && !\is_bool($value);
    }

    // -----------------------------------------------------------------------
    // Config comparison-value validation (#509) — operand validated BEFORE
    // the user attribute for the semver / number / datetime relations.
    // -----------------------------------------------------------------------

    private static function invalidComparisonValue(string $value, string $reason): ComparisonValueError
    {
        return new ComparisonValueError("comparison value '{$value}' is invalid ({$reason})");
    }

    /**
     * Config semver operand → semver, or a comparison-value error. The operand
     * is trimmed before parsing (parity with {@link evaluateSemverRelation});
     * the error reports the UNTRIMMED operand.
     */
    public static function comparisonValueAsSemver(string $value): Semver|ComparisonValueError
    {
        $version = Semver::parse(trim($value));
        if ($version !== null) {
            return $version;
        }

        return self::invalidComparisonValue($value, "'{$value}' is not a valid semantic version");
    }

    /**
     * Render a numeric operand for the comparison-value error message. Mirrors
     * TS's `String(value)`: an absent operand prints "undefined", otherwise the
     * canonical number string.
     */
    private static function comparisonValueNumberString(?float $value): string
    {
        if ($value === null) {
            return 'undefined';
        }

        return self::numberToCanonicalString($value);
    }

    /**
     * Config number operand → number, or a comparison-value error. `$value` is
     * the condition's `d` slot (null when absent).
     */
    public static function comparisonValueAsNumber(?float $value): float|ComparisonValueError
    {
        if ($value !== null && !is_nan($value)) {
            return $value;
        }
        $s = self::comparisonValueNumberString($value);

        return self::invalidComparisonValue($s, "'{$s}' is not a valid decimal number");
    }

    /**
     * Config datetime operand → Unix seconds, or a comparison-value error.
     */
    public static function comparisonValueAsUnixTimeSeconds(?float $value): float|ComparisonValueError
    {
        if ($value !== null && !is_nan($value)) {
            return $value;
        }
        $s = self::comparisonValueNumberString($value);

        return self::invalidComparisonValue(
            $s,
            "'{$s}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)",
        );
    }
}
