<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\NullLogger;

/**
 * Spec 098 / #267 — slice 9/14 — sdk-php online/offline triplet.
 *
 * Mirrors upstream ConfigCat\ConfigCatClient::setOnline() /
 * ::setOffline() / ::isOffline(). Conformance lives in
 * ApiSurfaceConformanceTest; this file exercises behaviour.
 */
final class OnlineOfflineTest extends TestCase
{
    private static function buildManualClient(?OnlineOfflineCapturingLogger $logger = null): ConfeatureClient
    {
        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => $logger ?? new NullLogger(),
        ]);
    }

    private static function buildLocalOnlyClient(?OnlineOfflineCapturingLogger $logger = null): ConfeatureClient
    {
        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap(['feature.x' => true]),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'cache' => null,
            'logger' => $logger ?? new NullLogger(),
        ]);
    }

    // ── default state ────────────────────────────────────────────────────

    public function testFreshlyConstructedClientIsOnline(): void
    {
        $client = self::buildManualClient();
        self::assertFalse($client->isOffline());
        $client->close();
    }

    // ── basic transitions ────────────────────────────────────────────────

    public function testSetOfflineFlipsTheFlag(): void
    {
        $client = self::buildManualClient();
        $client->setOffline();
        self::assertTrue($client->isOffline());
        $client->close();
    }

    public function testSetOnlineResetsTheFlag(): void
    {
        $client = self::buildManualClient();
        $client->setOffline();
        self::assertTrue($client->isOffline());
        $client->setOnline();
        self::assertFalse($client->isOffline());
        $client->close();
    }

    public function testSettersAreIdempotent(): void
    {
        $client = self::buildManualClient();
        $client->setOffline();
        $client->setOffline();
        $client->setOffline();
        self::assertTrue($client->isOffline());
        $client->setOnline();
        $client->setOnline();
        $client->setOnline();
        self::assertFalse($client->isOffline());
        $client->close();
    }

    // ── forceRefresh ─────────────────────────────────────────────────────

    public function testForceRefreshReturnsFalseWhileOffline(): void
    {
        $client = self::buildManualClient();
        $client->setOffline();
        self::assertFalse($client->forceRefresh());
        $client->close();
    }

    // ── LocalOnly ────────────────────────────────────────────────────────

    public function testLocalOnlyClientIsOfflineByDefinition(): void
    {
        $client = self::buildLocalOnlyClient();
        self::assertTrue($client->isOffline());
        $client->close();
    }

    public function testLocalOnlySetOnlineLogsWarning(): void
    {
        $logger = new OnlineOfflineCapturingLogger();
        $client = self::buildLocalOnlyClient($logger);
        $client->setOnline();
        self::assertTrue($client->isOffline(), 'LocalOnly still offline=true');
        $found = false;
        foreach ($logger->messages as $m) {
            if (str_contains($m, 'WARN') && str_contains($m, 'LOCAL_ONLY')) {
                $found = true;
                break;
            }
        }
        self::assertTrue($found, 'expected WARN with LOCAL_ONLY substring');
        $client->close();
    }

    public function testLocalOnlySetOfflineIsSilentNoOp(): void
    {
        $logger = new OnlineOfflineCapturingLogger();
        $client = self::buildLocalOnlyClient($logger);
        $client->setOffline();
        self::assertTrue($client->isOffline());
        foreach ($logger->messages as $m) {
            self::assertStringNotContainsString(
                'setOffline',
                $m,
                'LocalOnly setOffline must be silent'
            );
        }
        $client->close();
    }

    // ── closed client ────────────────────────────────────────────────────

    public function testClosedClientReportsOffline(): void
    {
        $client = self::buildManualClient();
        $client->close();
        self::assertTrue($client->isOffline());
    }

    public function testClosedClientSetOnlineLogsWarning(): void
    {
        $logger = new OnlineOfflineCapturingLogger();
        $client = self::buildManualClient($logger);
        $client->close();
        $client->setOnline();
        $found = false;
        foreach ($logger->messages as $m) {
            if (str_contains($m, 'WARN') && str_contains($m, 'setOnline')) {
                $found = true;
                break;
            }
        }
        self::assertTrue($found, 'expected WARN with setOnline substring');
    }

    public function testClosedClientSetOfflineLogsWarning(): void
    {
        $logger = new OnlineOfflineCapturingLogger();
        $client = self::buildManualClient($logger);
        $client->close();
        $client->setOffline();
        $found = false;
        foreach ($logger->messages as $m) {
            if (str_contains($m, 'WARN') && str_contains($m, 'setOffline')) {
                $found = true;
                break;
            }
        }
        self::assertTrue($found, 'expected WARN with setOffline substring');
    }
}

/**
 * In-memory PSR-3 logger — captures every log message for assertion.
 */
final class OnlineOfflineCapturingLogger extends AbstractLogger
{
    /** @var array<int, string> */
    public array $messages = [];

    public function log($level, string|\Stringable $message, array $context = []): void
    {
        $this->messages[] = sprintf('%s %s', strtoupper((string) $level), $message);
    }
}
