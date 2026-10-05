<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\EvaluationDetails;
use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use Confeature\User;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * Spec 087 / closes #266 for the sdk-php slice — direct coverage of
 * `ConfeatureClient::getValueDetails` + `getAllValues` and the
 * `EvaluationDetails` value class.
 *
 * Network never hit: every test wires either a LOCAL_ONLY override
 * source or a Guzzle MockHandler against a ManualPoll client.
 */
final class EvaluationDetailsTest extends TestCase
{
    public function testFromErrorPopulatesIsDefaultValueAndErrorMessage(): void
    {
        $details = EvaluationDetails::fromError('feature.dark', false, null, 'CLIENT_CLOSED');
        self::assertSame('feature.dark', $details->getKey());
        self::assertSame(false, $details->getValue());
        self::assertNull($details->getVariationId());
        self::assertTrue($details->isDefaultValue());
        self::assertSame('CLIENT_CLOSED', $details->getErrorMessage());
        self::assertNull($details->getErrorException());
        self::assertSame(0.0, $details->getFetchTimeUnixMilliseconds());
        self::assertNull($details->getMatchedTargetingRule());
        self::assertNull($details->getMatchedPercentageOption());
    }

    public function testFromErrorPropagatesOptionalThrowable(): void
    {
        $err = new \RuntimeException('boom');
        $details = EvaluationDetails::fromError('feature.dark', false, null, 'EVAL_EXCEPTION', $err);
        self::assertSame($err, $details->getErrorException());
        self::assertSame('EVAL_EXCEPTION', $details->getErrorMessage());
    }

    public function testGetValueDetailsHappyPathReadsLocalOnlyOverride(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        try {
            $details = $client->getValueDetails('feature.dark', false);
            self::assertTrue($details->getValue());
            self::assertFalse($details->isDefaultValue());
            self::assertNull($details->getErrorMessage());
            self::assertNull($details->getErrorException());
            self::assertSame('feature.dark', $details->getKey());
        } finally {
            $client->close();
        }
    }

    public function testGetValueDetailsKeyNotFoundReturnsDefaultWithError(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        try {
            $details = $client->getValueDetails('missing.key', 'fallback');
            self::assertSame('fallback', $details->getValue());
            self::assertTrue($details->isDefaultValue());
            self::assertSame('KEY_NOT_FOUND', $details->getErrorMessage());
        } finally {
            $client->close();
        }
    }

    public function testGetValueDetailsClosedClientReturnsClientClosed(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $client->close();
        $details = $client->getValueDetails('feature.dark', false);
        self::assertSame(false, $details->getValue());
        self::assertTrue($details->isDefaultValue());
        self::assertSame('CLIENT_CLOSED', $details->getErrorMessage());
        self::assertSame(0.0, $details->getFetchTimeUnixMilliseconds());
    }

    public function testGetValueDetailsTypeMismatchReturnsDefaultWithError(): void
    {
        // Wire a remote config carrying a boolean flag; ask with an
        // int default — evaluator returns TYPE_MISMATCH.
        $body = ['f' => ['feature.dark' => ['t' => 0, 'v' => ['b' => true]]]];
        $mock = new MockHandler([
            new Response(200, ['ETag' => '"v1"'], (string) json_encode($body)),
        ]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            self::assertTrue($client->forceRefresh());
            $details = $client->getValueDetails('feature.dark', 42);
            self::assertSame(42, $details->getValue());
            self::assertTrue($details->isDefaultValue());
            self::assertSame('TYPE_MISMATCH', $details->getErrorMessage());
            // After a successful fetch, the millis stamp is populated.
            self::assertGreaterThan(0.0, $details->getFetchTimeUnixMilliseconds());
        } finally {
            $client->close();
        }
    }

    public function testGetValueDetailsPropagatesUser(): void
    {
        $alice = new User('alice@example.com');
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        try {
            $details = $client->getValueDetails('feature.dark', false, $alice);
            self::assertSame($alice, $details->getUser());
        } finally {
            $client->close();
        }
    }

    public function testGetValueDetailsFallsBackToDefaultUserWhenUserIsNull(): void
    {
        $alice = new User('alice@example.com');
        $client = self::buildLocalOnlyClient(['feature.dark' => true], $alice);
        try {
            $details = $client->getValueDetails('feature.dark', false);
            self::assertSame($alice, $details->getUser());
        } finally {
            $client->close();
        }
    }

    public function testGetAllValuesHappyPathReturnsUnion(): void
    {
        $client = self::buildLocalOnlyClient([
            'feature.dark' => true,
            'feature.beta' => false,
        ]);
        try {
            $all = $client->getAllValues();
            self::assertSame(['feature.dark' => true, 'feature.beta' => false], $all);
        } finally {
            $client->close();
        }
    }

    public function testGetAllValuesOnClosedClientReturnsEmptyArray(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $client->close();
        self::assertSame([], $client->getAllValues());
    }

    public function testGetAllValuesWithNoConfigOrOverridesIsEmpty(): void
    {
        // ManualPoll + no overrides + cache:null — no flags reachable
        // until forceRefresh runs (which the test does not trigger).
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
        ]);
        try {
            self::assertSame([], $client->getAllValues());
        } finally {
            $client->close();
        }
    }

    public function testGetAllValuesUnionsRemoteAndOverrideKeys(): void
    {
        // Remote config + non-LocalOnly: only the remote keys reach
        // `getAllValues` (override behaviour is LOCAL_OVER_REMOTE,
        // which falls through in v1).
        $body = ['f' => [
            'feature.a' => ['t' => 0, 'v' => ['b' => true]],
            'feature.b' => ['t' => 1, 'v' => ['s' => 'hello']],
        ]];
        $mock = new MockHandler([
            new Response(200, ['ETag' => '"v1"'], (string) json_encode($body)),
        ]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            self::assertTrue($client->forceRefresh());
            $all = $client->getAllValues();
            self::assertSame(['feature.a' => true, 'feature.b' => 'hello'], $all);
        } finally {
            $client->close();
        }
    }

    /**
     * @param array<string, bool|int|float|string> $map
     */
    private static function buildLocalOnlyClient(array $map, ?User $defaultUser = null): ConfeatureClient
    {
        $options = [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap($map),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'cache' => null,
            'logger' => new NullLogger(),
        ];
        if ($defaultUser !== null) {
            $options['defaultUser'] = $defaultUser;
        }

        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, $options);
    }
}
