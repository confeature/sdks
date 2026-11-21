<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\OpenFeature;

use Confeature\ConfeatureClient;
use Confeature\Internal\EvaluationFailure;
use Confeature\User;
use OpenFeature\implementation\provider\AbstractProvider;
use OpenFeature\implementation\provider\ResolutionDetails;
use OpenFeature\implementation\provider\ResolutionError;
use OpenFeature\interfaces\flags\EvaluationContext;
use OpenFeature\interfaces\provider\ErrorCode;
use OpenFeature\interfaces\provider\Reason;

/** Resolves flags through a borrowed client whose polling and lifetime belong to the application. */
final class ConfeatureProvider extends AbstractProvider
{
    protected static string $NAME = 'Confeature';

    private const EVALUATION_FAILED = 'Confeature could not evaluate the flag.';
    private const RESERVED_ATTRIBUTES = ['targetingKey', 'Identifier', 'Email', 'Country'];

    public function __construct(private readonly ConfeatureClient $client)
    {
    }

    public function resolveBooleanValue(
        string $flagKey,
        bool $defaultValue,
        ?EvaluationContext $context = null,
    ): ResolutionDetails {
        return $this->resolve($flagKey, $defaultValue, $context);
    }

    public function resolveStringValue(
        string $flagKey,
        string $defaultValue,
        ?EvaluationContext $context = null,
    ): ResolutionDetails {
        return $this->resolve($flagKey, $defaultValue, $context);
    }

    public function resolveIntegerValue(
        string $flagKey,
        int $defaultValue,
        ?EvaluationContext $context = null,
    ): ResolutionDetails {
        return $this->resolve($flagKey, $defaultValue, $context);
    }

    public function resolveFloatValue(
        string $flagKey,
        float $defaultValue,
        ?EvaluationContext $context = null,
    ): ResolutionDetails {
        return $this->resolve($flagKey, $defaultValue, $context);
    }

    /** @param mixed[] $defaultValue */
    public function resolveObjectValue(
        string $flagKey,
        array $defaultValue,
        ?EvaluationContext $context = null,
    ): ResolutionDetails {
        return self::failure($defaultValue, EvaluationFailure::TypeMismatch);
    }

    private function resolve(
        string $key,
        bool|string|int|float $default,
        ?EvaluationContext $context,
    ): ResolutionDetails {
        try {
            $outcome = $this->client->getValueDetailsForProvider($key, $default, self::toUser($context));
        } catch (\Throwable) {
            // Context implementations and SDK extensions can throw with application data.
            $this->logger?->warning(self::EVALUATION_FAILED);

            return self::failure($default, EvaluationFailure::General);
        }

        $details = $outcome->details;
        if ($outcome->failure !== null || $details->isDefaultValue()) {
            return self::failure($default, $outcome->failure ?? EvaluationFailure::General);
        }

        $resolution = new ResolutionDetails();
        $resolution->setValue($details->getValue());
        $resolution->setVariant($details->getVariationId());
        $resolution->setReason(match (true) {
            $details->getMatchedPercentageOption() !== null => Reason::SPLIT,
            $details->getMatchedTargetingRule() !== null => Reason::TARGETING_MATCH,
            default => Reason::DEFAULT,
        });

        return $resolution;
    }

    /** @param bool|string|int|float|mixed[] $default */
    private static function failure(bool|string|int|float|array $default, EvaluationFailure $failure): ResolutionDetails
    {
        [$code, $message] = match ($failure) {
            EvaluationFailure::FlagNotFound => [ErrorCode::FLAG_NOT_FOUND(), 'Confeature flag was not found.'],
            EvaluationFailure::NotReady => [ErrorCode::PROVIDER_NOT_READY(), 'Confeature has no available flag data.'],
            EvaluationFailure::TypeMismatch => [ErrorCode::TYPE_MISMATCH(), 'Confeature flag type does not match.'],
            EvaluationFailure::ParseError => [ErrorCode::PARSE_ERROR(), 'Confeature flag data is malformed.'],
            EvaluationFailure::General => [ErrorCode::GENERAL(), self::EVALUATION_FAILED],
        };
        $resolution = new ResolutionDetails();
        $resolution->setValue($default);
        $resolution->setReason(Reason::ERROR);
        $resolution->setError(new ResolutionError($code, $message));

        return $resolution;
    }

    /** Only the targeting key may supply the SDK identifier. */
    private static function toUser(?EvaluationContext $context): ?User
    {
        if ($context === null) {
            return null;
        }
        $identifier = $context->getTargetingKey();
        $attributes = $context->getAttributes()->toArray();
        $email = $attributes['Email'] ?? null;
        $country = $attributes['Country'] ?? null;
        $email = \is_string($email) ? $email : null;
        $country = \is_string($country) ? $country : null;

        $custom = [];
        foreach ($attributes as $name => $value) {
            if (!\is_string($name) || \in_array($name, self::RESERVED_ATTRIBUTES, true)) {
                continue;
            }
            $copied = self::copyAttribute($value);
            if ($copied !== null) {
                $custom[$name] = $copied;
            }
        }
        if ($identifier === null && $email === null && $country === null && $custom === []) {
            return null;
        }

        return new User($identifier ?? '', $email, $country, $custom);
    }

    /** @return bool|string|int|float|\DateTimeImmutable|list<string>|null */
    private static function copyAttribute(mixed $value): bool|string|int|float|\DateTimeImmutable|array|null
    {
        if (\is_scalar($value)) {
            return $value;
        }
        if ($value instanceof \DateTimeInterface) {
            return \DateTimeImmutable::createFromInterface($value);
        }
        if (!\is_array($value) || !array_is_list($value)) {
            return null;
        }

        $strings = [];
        foreach ($value as $item) {
            if (!\is_string($item)) {
                return null;
            }
            $strings[] = $item;
        }

        return $strings;
    }
}
