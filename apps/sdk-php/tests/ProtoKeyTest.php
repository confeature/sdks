<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * #826 — ConfigCat reserves no setting key, so the api serves `__proto__`
 * as an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
 * settings into a plain object; these tests hold the PHP SDK to keeping it
 * from the served bytes and from a local override.
 */
final class ProtoKeyTest extends TestCase
{
    private const SERVED = '{"p":{"u":"","r":0,"s":"salt"},'
        . '"f":{"__proto__":{"t":0,"v":{"b":true},"i":"v-proto","r":[]}},"s":[]}';

    public function testAServedProtoFlagReturnsItsServedValue(): void
    {
        $mock = new MockHandler([new Response(200, ['ETag' => '"v1"'], self::SERVED)]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            self::assertTrue($client->forceRefresh());
            self::assertTrue($client->getValue('__proto__', false));
        } finally {
            $client->close();
        }
    }

    public function testALocalOnlyOverrideKeyedProtoReturnsTheOverride(): void
    {
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap(['__proto__' => true]),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'cache' => null,
            'logger' => new NullLogger(),
        ]);

        try {
            self::assertTrue($client->getValue('__proto__', false));
        } finally {
            $client->close();
        }
    }
}
