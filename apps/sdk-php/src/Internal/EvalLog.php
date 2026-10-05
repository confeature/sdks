<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
 * PHP slice of #501).
 *
 * PHP port of the spec-117 TS reference
 * (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder`), the Python
 * (`apps/sdk-python/src/confeature_client/eval_log.py`), Ruby
 * (`apps/sdk-ruby/lib/confeature/internal/eval_log.rb`), Go, .NET, and Rust
 * ports. Produces the byte-identical indented textual trace ConfigCat's SDKs
 * emit during flag evaluation — its `evaluationlog/` corpus (replayed via
 * `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is the
 * byte-oracle. This builder mirrors the TS class line-for-line so the federation
 * ports stay consistent.
 *
 * The trace is emitted via the trace logger at INFO under event id 5000
 * (ConfigCat's verbosity contract) — see `Evaluator::evaluateTraced`. The
 * strings are ported VERBATIM from the canonical (Principle II).
 */
final class EvalLog
{
    /** ConfigCat's event id for the "config evaluated" INFO log line. */
    public const EVAL_LOG_EVENT_ID = '5000';

    /** ConfigCat indents each nested eval-log line by two spaces per level. */
    public const INDENT_UNIT = '  ';

    // Placeholders ConfigCat substitutes for malformed condition parts (parity
    // with configcat-common's EvaluateLogBuilder).
    public const INVALID_VALUE_PLACEHOLDER = '<invalid value>';
    public const INVALID_NAME_PLACEHOLDER = '<invalid name>';
    public const INVALID_OPERATOR_PLACEHOLDER = '<invalid operator>';

    /** Max IS-ONE-OF / list items rendered before truncation (configcat parity). */
    public const STRING_LIST_MAX_LENGTH = 10;

    private function __construct()
    {
    }

    /**
     * Per-comparator eval-log metadata (configcat-common parity), as
     * `[token, kind, sensitive]` — `token` is the operator rendering, `kind`
     * selects the condition value slot ("l"=list, "s"=string, "n"=number,
     * "dt"=datetime), `sensitive` masks the value as `<hashed value>`. One table
     * drives the condition rendering, mirroring eval-log.ts COMPARATOR_META.
     *
     * @return array<int, array{0: string, 1: string, 2: bool}>
     */
    public static function comparatorMeta(): array
    {
        $c = Comparators::class;

        return [
            $c::TEXT_IS_ONE_OF => ['IS ONE OF', 'l', false],
            $c::TEXT_IS_NOT_ONE_OF => ['IS NOT ONE OF', 'l', false],
            $c::TEXT_CONTAINS_ANY_OF => ['CONTAINS ANY OF', 'l', false],
            $c::TEXT_NOT_CONTAINS_ANY_OF => ['NOT CONTAINS ANY OF', 'l', false],
            $c::SEMVER_IS_ONE_OF => ['IS ONE OF', 'l', false],
            $c::SEMVER_IS_NOT_ONE_OF => ['IS NOT ONE OF', 'l', false],
            $c::SEMVER_LESS => ['<', 's', false],
            $c::SEMVER_LESS_OR_EQUALS => ['<=', 's', false],
            $c::SEMVER_GREATER => ['>', 's', false],
            $c::SEMVER_GREATER_OR_EQUALS => ['>=', 's', false],
            $c::NUMBER_EQUALS => ['=', 'n', false],
            $c::NUMBER_NOT_EQUALS => ['!=', 'n', false],
            $c::NUMBER_LESS => ['<', 'n', false],
            $c::NUMBER_LESS_OR_EQUALS => ['<=', 'n', false],
            $c::NUMBER_GREATER => ['>', 'n', false],
            $c::NUMBER_GREATER_OR_EQUALS => ['>=', 'n', false],
            $c::SENSITIVE_TEXT_IS_ONE_OF => ['IS ONE OF', 'l', true],
            $c::SENSITIVE_TEXT_IS_NOT_ONE_OF => ['IS NOT ONE OF', 'l', true],
            $c::DATETIME_BEFORE => ['BEFORE', 'dt', false],
            $c::DATETIME_AFTER => ['AFTER', 'dt', false],
            $c::SENSITIVE_TEXT_EQUALS => ['EQUALS', 's', true],
            $c::SENSITIVE_TEXT_NOT_EQUALS => ['NOT EQUALS', 's', true],
            $c::SENSITIVE_TEXT_STARTS_WITH_ANY_OF => ['STARTS WITH ANY OF', 'l', true],
            $c::SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF => ['NOT STARTS WITH ANY OF', 'l', true],
            $c::SENSITIVE_TEXT_ENDS_WITH_ANY_OF => ['ENDS WITH ANY OF', 'l', true],
            $c::SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF => ['NOT ENDS WITH ANY OF', 'l', true],
            $c::SENSITIVE_ARRAY_CONTAINS_ANY_OF => ['ARRAY CONTAINS ANY OF', 'l', true],
            $c::SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF => ['ARRAY NOT CONTAINS ANY OF', 'l', true],
            $c::TEXT_EQUALS => ['EQUALS', 's', false],
            $c::TEXT_NOT_EQUALS => ['NOT EQUALS', 's', false],
            $c::TEXT_STARTS_WITH_ANY_OF => ['STARTS WITH ANY OF', 'l', false],
            $c::TEXT_NOT_STARTS_WITH_ANY_OF => ['NOT STARTS WITH ANY OF', 'l', false],
            $c::TEXT_ENDS_WITH_ANY_OF => ['ENDS WITH ANY OF', 'l', false],
            $c::TEXT_NOT_ENDS_WITH_ANY_OF => ['NOT ENDS WITH ANY OF', 'l', false],
            $c::ARRAY_CONTAINS_ANY_OF => ['ARRAY CONTAINS ANY OF', 'l', false],
            $c::ARRAY_NOT_CONTAINS_ANY_OF => ['ARRAY NOT CONTAINS ANY OF', 'l', false],
        ];
    }

    /** Render a `UserComparator` as ConfigCat's eval-log operator token. */
    public static function formatUserComparator(int $comparator): string
    {
        $meta = self::comparatorMeta()[$comparator] ?? null;

        return $meta === null ? self::INVALID_OPERATOR_PLACEHOLDER : $meta[0];
    }

    /**
     * Format a string list exactly as configcat-common's `formatStringList`:
     * `'a', 'b'` joined by `, `, with an optional truncation appendix once
     * `$maxLength` is exceeded.
     *
     * @param list<string> $items
     */
    public static function formatStringList(array $items, int $maxLength): string
    {
        if ($items === []) {
            return '';
        }
        $appendix = '';
        $shown = $items;
        if ($maxLength > 0 && \count($items) > $maxLength) {
            $shown = \array_slice($items, 0, $maxLength);
            $count = \count($items) - $maxLength;
            $word = $count === 1 ? 'value' : 'values';
            $appendix = ", ... <{$count} more {$word}>";
        }

        return "'" . implode("', '", $shown) . "'" . $appendix;
    }

    /**
     * Format a resolved SETTING value for the eval log (ConfigCat parity):
     * boolean → `true`/`false` (lowercase), string → verbatim, number → its
     * canonical decimal string. Mirrors the `'<value>'` token in ConfigCat's
     * `Returning '<value>'.` footer (eval-log.ts `settingValueToString`).
     */
    public static function settingValueToLogString(mixed $value): string
    {
        if (\is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (\is_string($value)) {
            return $value;
        }
        if ((\is_int($value) || \is_float($value)) && !\is_bool($value)) {
            return Comparators::numberToCanonicalString((float) $value);
        }

        return '';
    }

    /**
     * Render a Unix-seconds value as ConfigCat's eval-log datetime suffix:
     * JS `new Date(value*1000).toISOString()`, e.g. `2023-04-01T00:00:00.000Z`
     * (always millisecond precision, UTC). Returns null for non-finite values
     * (NaN / ±Inf), matching the JS `isNaN(date)` guard.
     */
    public static function unixSecondsToIso(float $seconds): ?string
    {
        if (is_nan($seconds) || is_infinite($seconds)) {
            return null;
        }
        $ms = (int) round($seconds * 1000);
        $whole = intdiv($ms, 1000);
        $millis = $ms - ($whole * 1000);
        if ($millis < 0) {
            $millis += 1000;
            --$whole;
        }
        $dt = (new \DateTimeImmutable('@' . $whole))->setTimezone(new \DateTimeZone('UTC'));

        return $dt->format('Y-m-d\TH:i:s') . '.' . sprintf('%03d', $millis) . 'Z';
    }

    public static function boolToLogString(bool $value): string
    {
        return $value ? 'true' : 'false';
    }
}
