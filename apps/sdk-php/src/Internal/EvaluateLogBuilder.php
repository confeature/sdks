<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * PHP analogue of eval-log.ts `EvaluateLogBuilder`. indent / newLine / append
 * primitives + the condition-rendering helpers (ADR 0003 / epic #494, PHP slice
 * of #501). Mirrors the Python / Ruby / Go / .NET / Rust ports line-for-line.
 *
 * `$eol` defaults to "\n" — the byte the upstream oracle uses.
 */
final class EvaluateLogBuilder
{
    /** @var list<string> */
    private array $chunks = [];

    private int $indentLevel = 0;

    public function __construct(private readonly string $eol = "\n")
    {
    }

    /** Append text to the current line. */
    public function append(string $text): self
    {
        $this->chunks[] = $text;

        return $this;
    }

    /** Break to a new line at the current indent, then optionally append text. */
    public function newLine(?string $text = null): self
    {
        $this->chunks[] = $this->eol . str_repeat(EvalLog::INDENT_UNIT, $this->indentLevel);
        if ($text !== null) {
            $this->chunks[] = $text;
        }

        return $this;
    }

    public function increaseIndent(): self
    {
        ++$this->indentLevel;

        return $this;
    }

    public function decreaseIndent(): self
    {
        if ($this->indentLevel > 0) {
            --$this->indentLevel;
        }

        return $this;
    }

    // ---- condition formatting -----------------------------------------------

    /**
     * Render one user condition (`User.<attr> <COMP> <value>`). The compact
     * condition carries the value in `l` (list), `s` (string / sensitive-equals),
     * or `d` (number / datetime), selected by the comparator kind.
     *
     * @param array<string, mixed> $condition
     */
    public function appendUserCondition(array $condition): self
    {
        $rawAttr = $condition['a'] ?? null;
        $attr = \is_string($rawAttr) ? $rawAttr : EvalLog::INVALID_NAME_PLACEHOLDER;
        $cmp = $condition['c'] ?? null;
        if (!\is_int($cmp) || \is_bool($cmp)) {
            $cmp = -1;
        }
        $meta = EvalLog::comparatorMeta()[$cmp] ?? null;
        if ($meta === null) {
            return $this->appendUnknownUserCondition($attr, $cmp, $condition);
        }

        [, $kind, $sensitive] = $meta;

        return match ($kind) {
            'l' => $this->appendUserConditionStringList(
                $attr,
                $cmp,
                \is_array($condition['l'] ?? null) ? $this->stringList($condition['l']) : null,
                $sensitive,
            ),
            's' => $this->appendUserConditionString($attr, $cmp, $condition['s'] ?? null, $sensitive),
            'n' => $this->appendUserConditionNumber($attr, $cmp, $this->floatOrNull($condition['d'] ?? null), false),
            default => $this->appendUserConditionNumber($attr, $cmp, $this->floatOrNull($condition['d'] ?? null), true),
        };
    }

    /** Append a single condition's boolean result (` => true` / ` => false…`). */
    public function appendConditionConsequence(bool $result): self
    {
        $this->append(' => ' . EvalLog::boolToLogString($result));

        return $result ? $this : $this->append(', skipping the remaining AND conditions');
    }

    /**
     * Append a targeting rule's THEN consequence. `$thenValue` is the rule's
     * formatted served value (e.g. `Dog`) for a fixed-value rule, or null for a
     * rule serving `% options`. `$match` is MATCH / no match / an error.
     */
    public function appendTargetingRuleConsequence(?string $thenValue, MatchOrError $match, bool $newLine): self
    {
        $this->increaseIndent();
        // `$newLine` (the param) must NOT shadow the `newLine` builder method:
        // break to a fresh line when the rule had conditions, else a single
        // space before `THEN` (mirrors eval-log.ts appendTargetingRuleConsequence).
        if ($newLine) {
            $this->newLine();
        } else {
            $this->append(' ');
        }
        $this->append('THEN');
        $this->append($thenValue === null ? ' % options' : " '{$thenValue}'");
        $this->append(' => ');
        $this->append(match ($match->kind) {
            MatchOrError::MATCH => 'MATCH, applying rule',
            MatchOrError::NO_MATCH => 'no match',
            default => $match->errText,
        });

        return $this->decreaseIndent();
    }

    /** Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`). */
    public function appendPrerequisiteFlagCondition(string $prereqKey, int $comparator, string $comparisonValue): self
    {
        $op = $comparator === Prerequisites::PREREQUISITE_NOT_EQUALS ? 'NOT EQUALS' : 'EQUALS';

        return $this->append("Flag '{$prereqKey}' {$op} '{$comparisonValue}'");
    }

    /** Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`). */
    public function appendSegmentCondition(string $segmentName, int $comparator): self
    {
        $op = $comparator === Segments::SEGMENT_IS_NOT_IN ? 'IS NOT IN SEGMENT' : 'IS IN SEGMENT';

        return $this->append("User {$op} '{$segmentName}'");
    }

    /** Append a bare boolean condition result (`true` / `false`). */
    public function appendConditionResult(bool $result): self
    {
        return $this->append(EvalLog::boolToLogString($result));
    }

    public function __toString(): string
    {
        return implode('', $this->chunks);
    }

    // ---- internal -----------------------------------------------------------

    /**
     * Unknown comparator: fall back to the first present value slot.
     *
     * @param array<string, mixed> $condition
     */
    private function appendUnknownUserCondition(string $attr, int $cmp, array $condition): self
    {
        $sv = $condition['s'] ?? null;
        if (\is_string($sv)) {
            return $this->appendUserConditionCore($attr, $cmp, $sv);
        }
        $dv = $condition['d'] ?? null;
        if ($dv !== null && (\is_int($dv) || \is_float($dv))) {
            return $this->appendUserConditionCore($attr, $cmp, Comparators::numberToCanonicalString((float) $dv));
        }
        $lv = $condition['l'] ?? null;
        if (\is_array($lv) && $lv !== []) {
            $first = reset($lv);

            return $this->appendUserConditionCore($attr, $cmp, \is_string($first) ? $first : (string) $first); // @phpstan-ignore-line cast.string
        }

        return $this->appendUserConditionCore($attr, $cmp, '');
    }

    private function appendUserConditionCore(string $attr, int $comparator, string $value): self
    {
        if ($value === '') {
            $value = EvalLog::INVALID_VALUE_PLACEHOLDER;
        }

        return $this->append("User.{$attr} " . EvalLog::formatUserComparator($comparator) . " '{$value}'");
    }

    private function appendUserConditionString(string $attr, int $comparator, mixed $value, bool $isSensitive): self
    {
        if (!\is_string($value)) {
            return $this->appendUserConditionCore($attr, $comparator, '');
        }
        if ($isSensitive) {
            return $this->appendUserConditionCore($attr, $comparator, '<hashed value>');
        }

        return $this->appendUserConditionCore($attr, $comparator, $value);
    }

    /**
     * @param ?list<string> $values
     */
    private function appendUserConditionStringList(string $attr, int $comparator, ?array $values, bool $isSensitive): self
    {
        if ($values === null) {
            return $this->appendUserConditionCore($attr, $comparator, '');
        }
        $comparatorText = EvalLog::formatUserComparator($comparator);
        if ($isSensitive) {
            $word = \count($values) === 1 ? 'value' : 'values';

            return $this->append("User.{$attr} {$comparatorText} [<" . \count($values) . " hashed {$word}>]");
        }
        $listText = EvalLog::formatStringList($values, EvalLog::STRING_LIST_MAX_LENGTH);

        return $this->append("User.{$attr} {$comparatorText} [{$listText}]");
    }

    private function appendUserConditionNumber(string $attr, int $comparator, ?float $value, bool $isDatetime): self
    {
        if ($value === null) {
            return $this->appendUserConditionCore($attr, $comparator, '');
        }
        $comparatorText = EvalLog::formatUserComparator($comparator);
        $valueText = Comparators::numberToCanonicalString($value);
        if ($isDatetime) {
            $iso = EvalLog::unixSecondsToIso($value);
            if ($iso !== null) {
                return $this->append("User.{$attr} {$comparatorText} '{$valueText}' ({$iso} UTC)");
            }
        }

        return $this->append("User.{$attr} {$comparatorText} '{$valueText}'");
    }

    private function floatOrNull(mixed $value): ?float
    {
        if ($value === null) {
            return null;
        }

        return (\is_int($value) || \is_float($value)) ? (float) $value : null;
    }

    /**
     * @param array<int|string, mixed> $raw
     *
     * @return list<string>
     */
    private function stringList(array $raw): array
    {
        $out = [];
        foreach ($raw as $item) {
            $out[] = \is_string($item) ? $item : (string) $item; // @phpstan-ignore-line cast.string
        }

        return $out;
    }
}
