<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Result of `Evaluator::evaluate`.
 *
 * Mirrors the equivalent `EvaluationResult` struct/dataclass from the
 * Python, Go, .NET, Rust and Ruby ports.
 *
 * `$error` carries the reason-coded fail-closed signal (`KEY_NOT_FOUND`,
 * `TYPE_MISMATCH`, `EVAL_EXCEPTION`, …) — null whenever a value was cleanly
 * resolved (incl. via a targeting rule, percentage option, or served
 * fallback).
 *
 * Spec 121 (additive — Principle II surface compatibility preserved):
 *   - `$matchedTargetingRule` / `$matchedPercentageOption` — the matched
 *     rule / percentage option that decided the value, or null. They
 *     populate the public `EvaluationDetails` placeholder arrays (FR-011).
 *   - `$evalError` — the informational rule-engine reason (e.g. "User Object
 *     is missing") surfaced when a rule could not be evaluated but a value
 *     WAS still resolved (FR-016). It never changes `$error`.
 */
final class EvaluationResult
{
    /**
     * @param ?array<string, mixed> $matchedTargetingRule
     * @param ?array<string, mixed> $matchedPercentageOption
     */
    public function __construct(
        public readonly mixed $value,
        public readonly ?string $error = null,
        public readonly ?string $variationId = null,
        public readonly ?array $matchedTargetingRule = null,
        public readonly ?array $matchedPercentageOption = null,
        public readonly ?string $evalError = null,
    ) {
    }

    public function ok(): bool
    {
        return $this->error === null;
    }
}
