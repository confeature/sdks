<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\EvaluationDetails;
use Confeature\FlagOverrides;
use Confeature\Internal\EvaluationFailure;
use Confeature\OverrideBehaviour;
use Confeature\OverrideDataSource;
use Confeature\SettingValue;
use Confeature\User;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\NullLogger;

final class ProviderEvaluationDetailsTest extends TestCase
{
    public function testProviderReadsFlatOverridesOnceAndPreservesNativeBehavior(): void
    {
        $source = new class () implements OverrideDataSource {
            public int $reads = 0;

            public function getOverridesSync(): ?array
            {
                ++$this->reads;

                return [
                    'flag' => new SettingValue(b: true),
                    'empty' => new SettingValue(),
                    'ambiguous' => new SettingValue(b: true, i: 1),
                ];
            }
        };
        $defaultUser = new User('native-default');
        $client = self::client(new FlagOverrides($source, OverrideBehaviour::LOCAL_ONLY), $defaultUser);
        $evaluated = [];
        $client->hooks()->addOnFlagEvaluated(static function (EvaluationDetails $details) use (&$evaluated): void {
            $evaluated[] = $details;
        });

        $native = $client->getValueDetails('flag', 'caller-default');
        self::assertSame(2, $source->reads);
        self::assertSame('caller-default', $native->getValue());
        self::assertFalse($native->isDefaultValue());
        self::assertSame($defaultUser, $native->getUser());

        $wrongType = $client->getValueDetailsForProvider('flag', 'caller-default', null);
        self::assertSame(3, $source->reads);
        self::assertSame(EvaluationFailure::TypeMismatch, $wrongType->failure);
        self::assertSame('caller-default', $wrongType->details->getValue());
        self::assertTrue($wrongType->details->isDefaultValue());
        self::assertNull($wrongType->details->getUser());

        $missing = $client->getValueDetailsForProvider('missing', false, null);
        $malformed = $client->getValueDetailsForProvider('empty', false, null);
        $ambiguous = $client->getValueDetailsForProvider('ambiguous', false, null);
        $success = $client->getValueDetailsForProvider('flag', true, null);
        self::assertSame(7, $source->reads);
        self::assertSame(EvaluationFailure::FlagNotFound, $missing->failure);
        self::assertSame(EvaluationFailure::ParseError, $malformed->failure);
        self::assertSame(EvaluationFailure::ParseError, $ambiguous->failure);
        self::assertNull($success->failure);
        self::assertTrue($success->details->getValue());
        self::assertFalse($success->details->isDefaultValue());
        self::assertSame([
            $native,
            $wrongType->details,
            $missing->details,
            $malformed->details,
            $ambiguous->details,
            $success->details,
        ], $evaluated);
    }

    public function testProviderPreservesConfigDoubleNormalizationAndNativeErrorMessage(): void
    {
        $client = self::client(FlagOverrides::localConfig([
            'f' => [
                'double' => ['t' => 3, 'v' => ['d' => 5], 'i' => 'double-variant'],
                'broken' => ['t' => 0, 'v' => ['b' => 'true']],
            ],
        ], OverrideBehaviour::LOCAL_ONLY));

        $success = $client->getValueDetailsForProvider('double', 5.0, null);
        self::assertNull($success->failure);
        self::assertSame(5.0, $success->details->getValue());
        self::assertSame('double-variant', $success->details->getVariationId());
        self::assertSame(
            EvaluationFailure::TypeMismatch,
            $client->getValueDetailsForProvider('double', 5, null)->failure,
        );

        $malformed = $client->getValueDetailsForProvider('broken', false, null);
        self::assertSame(EvaluationFailure::ParseError, $malformed->failure);
        self::assertSame('VALUE_NOT_BOOL', $malformed->details->getErrorMessage());
        self::assertSame('VALUE_NOT_BOOL', $client->getValueDetails('broken', false)->getErrorMessage());
    }

    public function testLegacyOverridePresenceFailurePreservesFallbackAndLogsFixedMessage(): void
    {
        $source = new class () implements OverrideDataSource {
            private int $reads = 0;

            public function getOverridesSync(): ?array
            {
                if (++$this->reads > 1) {
                    throw new \RuntimeException('synthetic sensitive source detail');
                }

                return ['flag' => new SettingValue(b: true)];
            }
        };
        $logger = new class () extends AbstractLogger {
            public array $messages = [];

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                $this->messages[] = [$level, (string) $message, $context];
            }
        };
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'flagOverrides' => new FlagOverrides($source, OverrideBehaviour::LOCAL_ONLY),
            'cache' => null,
            'logger' => $logger,
        ]);

        $result = $client->getValueDetails('flag', false);
        self::assertTrue($result->isDefaultValue());
        self::assertFalse($result->getValue());
        self::assertSame('KEY_NOT_FOUND', $result->getErrorMessage());
        self::assertSame([
            ['warning', 'ConfeatureClient: LocalOnly override presence check failed.', []],
        ], $logger->messages);
    }

    private static function client(FlagOverrides $overrides, ?User $defaultUser = null): ConfeatureClient
    {
        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'flagOverrides' => $overrides,
            'defaultUser' => $defaultUser,
            'cache' => null,
            'logger' => new NullLogger(),
        ]);
    }
}
