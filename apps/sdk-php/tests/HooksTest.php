<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\EvaluationDetails;
use Confeature\FlagOverrides;
use Confeature\Hooks;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use PHPUnit\Framework\TestCase;

/**
 * Spec 109 / #268 — slice 7/14 — sdk-php hooks/events bus.
 *
 * Mirrors upstream ConfigCat\Hooks — three hook points (configChanged,
 * flagEvaluated, error). Conformance lives in ApiSurfaceConformanceTest;
 * this file exercises behaviour.
 */
final class HooksTest extends TestCase
{
    private static function buildLocalOnlyClient(): ConfeatureClient
    {
        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap(['feature.dark-mode' => true]),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'pollingMode' => PollingMode::manualPoll(),
        ]);
    }

    public function testHooksReturnsTheSameInstanceAcrossCalls(): void
    {
        $client = self::buildLocalOnlyClient();
        try {
            self::assertInstanceOf(Hooks::class, $client->hooks());
            self::assertSame($client->hooks(), $client->hooks());
        } finally {
            $client->close();
        }
    }

    public function testAddOnConfigChangedReceivesPayload(): void
    {
        $hooks = new Hooks();
        $captured = [];
        $hooks->addOnConfigChanged(function (array $settings) use (&$captured): void {
            $captured[] = $settings;
        });
        $hooks->fireOnConfigChanged(['feature.x' => ['v' => true]]);
        self::assertSame([['feature.x' => ['v' => true]]], $captured);
    }

    public function testAddOnFlagEvaluatedReceivesDetails(): void
    {
        $hooks = new Hooks();
        $captured = [];
        $hooks->addOnFlagEvaluated(function (EvaluationDetails $d) use (&$captured): void {
            $captured[] = $d->getKey();
        });
        $hooks->fireOnFlagEvaluated(EvaluationDetails::fromError('feature.x', false, null, 'KEY_NOT_FOUND'));
        self::assertSame(['feature.x'], $captured);
    }

    public function testAddOnErrorReceivesMessage(): void
    {
        $hooks = new Hooks();
        $captured = [];
        $hooks->addOnError(function (string $msg, ?\Throwable $ex) use (&$captured): void {
            $captured[] = [$msg, $ex];
        });
        $hooks->fireOnError('Config fetch failed.', null);
        self::assertSame([['Config fetch failed.', null]], $captured);
    }

    public function testListenerExceptionIsCaughtAndDoesNotBreakOthers(): void
    {
        $hooks = new Hooks();
        $downstream = 0;
        $hooks->addOnError(function (string $_m): void {
            throw new \RuntimeException('boom');
        });
        $hooks->addOnError(function (string $_m) use (&$downstream): void {
            ++$downstream;
        });
        $hooks->fireOnError('test', null);
        self::assertSame(1, $downstream);
    }

    public function testFlagEvaluatedFiresOnGetValueDetails(): void
    {
        $client = self::buildLocalOnlyClient();
        $fires = 0;
        try {
            $client->hooks()->addOnFlagEvaluated(function (EvaluationDetails $_d) use (&$fires): void {
                ++$fires;
            });
            $client->getValueDetails('feature.dark-mode', false);
            $client->getValueDetails('feature.unknown', false);
            self::assertSame(2, $fires);
        } finally {
            $client->close();
        }
    }
}
