<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature;

/**
 * Typed result envelope returned by
 * `ConfeatureClient::getValueDetails` (spec 087 / closes #266 for the
 * sdk-php slice).
 *
 * Drop-in mirror of upstream `ConfigCat\EvaluationDetails` from
 * `configcat/configcat-client` ^9.2: same 10 readonly properties in
 * the same constructor order, same getters, same `fromError` factory
 * signature. Confeature Constitution Principle II — a consumer
 * migrating from ConfigCat by swapping the namespace keeps every
 * call site working unchanged.
 *
 * Stable error codes populating `$errorMessage` on fail branches
 * match the evaluator's tier-0 set:
 *   `KEY_NOT_FOUND` / `TYPE_MISMATCH` / `MALFORMED_VALUE` /
 *   `UNSUPPORTED_TYPE` / `NO_CONFIG` / `MALFORMED_CONFIG` /
 *   `VALUE_NOT_BOOL` / `CLIENT_CLOSED`.
 *
 * `$fetchTimeUnixMilliseconds` is millis-since-epoch (float, matching
 * upstream's `float` return type) — `0.0` until the active config
 * has loaded.
 *
 * `$matchedTargetingRule` + `$matchedPercentageOption` are v1
 * placeholders (always `null`); a future spec lands the wire-level
 * targeting tree and populates them.
 */
final class EvaluationDetails
{
    /**
     * @param ?array<string, mixed> $matchedTargetingRule
     * @param ?array<string, mixed> $matchedPercentageOption
     */
    public function __construct(
        private readonly string $key,
        private readonly ?string $variationId,
        private readonly mixed $value,
        private readonly ?User $user,
        private readonly bool $isDefaultValue,
        private readonly ?string $errorMessage,
        private readonly ?\Throwable $errorException,
        private readonly float $fetchTimeUnixMilliseconds,
        private readonly ?array $matchedTargetingRule,
        private readonly ?array $matchedPercentageOption,
    ) {
    }

    /**
     * Convenience factory for fail-closed branches: closed client,
     * caller-supplied invalid input, etc. Mirrors upstream
     * `ConfigCat\EvaluationDetails::fromError` 1:1, including the
     * optional `$errorException` argument.
     */
    public static function fromError(
        string $key,
        mixed $value,
        ?User $user,
        string $errorMessage,
        ?\Throwable $errorException = null,
    ): self {
        return new self(
            $key,
            null,
            $value,
            $user,
            true,
            $errorMessage,
            $errorException,
            0.0,
            null,
            null,
        );
    }

    public function getKey(): string
    {
        return $this->key;
    }

    public function getVariationId(): ?string
    {
        return $this->variationId;
    }

    public function getValue(): mixed
    {
        return $this->value;
    }

    public function getUser(): ?User
    {
        return $this->user;
    }

    public function isDefaultValue(): bool
    {
        return $this->isDefaultValue;
    }

    public function getErrorMessage(): ?string
    {
        return $this->errorMessage;
    }

    public function getErrorException(): ?\Throwable
    {
        return $this->errorException;
    }

    public function getFetchTimeUnixMilliseconds(): float
    {
        return $this->fetchTimeUnixMilliseconds;
    }

    /**
     * @return ?array<string, mixed>
     */
    public function getMatchedTargetingRule(): ?array
    {
        return $this->matchedTargetingRule;
    }

    /**
     * @return ?array<string, mixed>
     */
    public function getMatchedPercentageOption(): ?array
    {
        return $this->matchedPercentageOption;
    }
}
