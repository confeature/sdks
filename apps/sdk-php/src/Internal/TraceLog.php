<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Internal logger adapter threaded through the evaluation context (ADR 0003 /
 * epic #494, PHP slice of #501). Mirrors logger.ts `LoggerWrapper`: a null
 * inner means tracing is off (zero cost), and every helper is level-gated at
 * the boundary.
 *
 * The WARN / ERROR / INFO strings are ported VERBATIM from
 * `packages/sdk-shared/src/logger.ts` (Principle II — byte-identical to the
 * canonical), cross-checked against the Python / Ruby / Go ports. The capture
 * format the parity test reconstructs is `"<LEVEL>: [<eventId>] <message>"` per
 * emitted call, joined by "\n", with the INFO 5000 entry carrying the
 * multi-line indented trace.
 */
final class TraceLog
{
    public function __construct(private readonly ?TraceSink $inner = null)
    {
    }

    public function enabled(int $level): bool
    {
        if ($this->inner === null) {
            return false;
        }
        $threshold = $this->inner->level();
        if ($threshold === TraceLevel::OFF) {
            return false;
        }

        return $level <= $threshold;
    }

    /** WARN 3001 (verbatim from logger.ts `userObjectIsMissing`). */
    public function userObjectIsMissing(string $key): void
    {
        $this->emit(
            TraceLevel::WARN,
            '3001',
            "cannot evaluate targeting rules and % options for setting '{$key}' "
            . '(User Object is missing); you should pass a User Object to the evaluation '
            . 'methods like `getValue()` in order to make targeting work properly; read more: '
            . 'https://configcat.com/docs/advanced/user-object/',
        );
    }

    /** WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`). */
    public function userObjectAttributeIsMissing(string $key, string $attributeName): void
    {
        $this->emit(
            TraceLevel::WARN,
            '3003',
            "cannot evaluate certain targeting rules of setting '{$key}' "
            . "(the User.{$attributeName} attribute is missing); you should set the "
            . "User.{$attributeName} attribute in order to make targeting work properly; "
            . 'read more: https://configcat.com/docs/advanced/user-object/',
        );
    }

    /** WARN 3003, % options variant (verbatim from logger.ts). */
    public function userObjectAttributeIsMissingForPercentage(string $key, string $attributeName): void
    {
        $this->emit(
            TraceLevel::WARN,
            '3003',
            "cannot evaluate % options for setting '{$key}' "
            . "(the User.{$attributeName} attribute is missing); you should set the "
            . "User.{$attributeName} attribute in order to make targeting work properly; "
            . 'read more: https://configcat.com/docs/advanced/user-object/',
        );
    }

    /** WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`). */
    public function userObjectAttributeIsInvalid(string $key, string $attributeName, string $reason): void
    {
        $this->emit(
            TraceLevel::WARN,
            '3004',
            "cannot evaluate certain targeting rules of setting '{$key}' "
            . "(the User.{$attributeName} attribute is invalid ({$reason})); please check the "
            . "User.{$attributeName} attribute and make sure that its value corresponds to the "
            . 'comparison operator',
        );
    }

    /**
     * WARN 3004, malformed config operand (#509). Note there is NO "please check
     * the User.<attr>…" suffix (verbatim from logger.ts `comparisonValueIsInvalid`).
     * `$innerMessage` is the full `comparison value '<v>' is invalid (<reason>)` text.
     */
    public function comparisonValueIsInvalid(string $key, string $innerMessage): void
    {
        $this->emit(
            TraceLevel::WARN,
            '3004',
            "cannot evaluate certain targeting rules of setting '{$key}' ({$innerMessage})",
        );
    }

    /** ERROR 1002 (verbatim from logger.ts `circularDependency`). */
    public function circularDependency(string $key, string $cycle): void
    {
        $this->emit(
            TraceLevel::ERROR,
            '1002',
            "failed to evaluate setting '{$key}' (circular dependency detected between the "
            . "following depending flags: [{$cycle}])",
        );
    }

    /** INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`. */
    public function info(string $eventId, string $message): void
    {
        $this->emit(TraceLevel::INFO, $eventId, $message);
    }

    private function emit(int $level, string $eventId, string $message): void
    {
        if (!$this->enabled($level)) {
            return;
        }
        $this->inner?->log($level, $eventId, $message);
    }
}
