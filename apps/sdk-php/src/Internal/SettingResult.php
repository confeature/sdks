<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * Raw result of `Evaluator::evaluateSetting`: the resolved `v` envelope plus
 * the matched-rule / matched-option identity. It deliberately does NOT select
 * the typed primitive — the existing typed-widening guard runs identically on
 * rule-served, percentage-served, and statically served envelopes.
 */
final class SettingResult
{
    /**
     * @param ?array<string, mixed> $matchedRule
     * @param ?array<string, mixed> $matchedOption
     */
    public function __construct(
        public readonly mixed $value,
        public readonly ?string $variationId = null,
        public readonly ?array $matchedRule = null,
        public readonly ?array $matchedOption = null,
    ) {
    }
}
