<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\ConfigOverrideDataSource;
use Confeature\EvaluationDetails;
use Confeature\FlagOverrides;
use Confeature\Logger;
use Confeature\LogLevel;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\OverrideDataSource;
use Confeature\PollingMode;
use Confeature\SettingValue;
use Confeature\Snapshot;
use Confeature\User;
use Confeature\Version;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

/**
 * Smoke-check the SDK's public PSR-4 autoload surface.
 *
 * The PHP composer manifest declares `Confeature\\ => src/`. This
 * test asserts every class the README documents is resolvable via
 * the autoloader and that the `Version::SDK` constant matches the
 * expected semver shape.
 *
 * If you add a new public class, list it here too — that keeps the
 * public surface auditable.
 */
final class PublicImportTest extends TestCase
{
    public function testVersionConstantMatchesSemverShape(): void
    {
        self::assertMatchesRegularExpression(
            '/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/',
            Version::SDK,
        );
    }

    public function testEveryPublicClassIsAutoloadable(): void
    {
        $classes = [
            ConfeatureClient::class,
            ConfigOverrideDataSource::class,
            EvaluationDetails::class,
            FlagOverrides::class,
            Logger::class,
            LogLevel::class,
            MapOverrideDataSource::class,
            OverrideBehaviour::class,
            OverrideDataSource::class,
            PollingMode::class,
            SettingValue::class,
            Snapshot::class,
            User::class,
            Version::class,
        ];
        foreach ($classes as $fqcn) {
            self::assertTrue(
                class_exists($fqcn) || interface_exists($fqcn),
                "expected {$fqcn} to be autoloadable",
            );
        }
    }

    public function testDefaultLoggerImplementsPsr3(): void
    {
        $logger = Logger::default();
        self::assertInstanceOf(LoggerInterface::class, $logger);
    }

    public function testLogLevelConstantsExposed(): void
    {
        self::assertSame(0, LogLevel::DEBUG);
        self::assertSame(1, LogLevel::INFO);
        self::assertSame(2, LogLevel::WARNING);
        self::assertSame(3, LogLevel::ERROR);
        self::assertSame(6, LogLevel::OFF);
    }

    public function testOverrideBehaviourConstantsExposed(): void
    {
        self::assertSame(0, OverrideBehaviour::LOCAL_ONLY);
        self::assertSame(1, OverrideBehaviour::LOCAL_OVER_REMOTE);
        self::assertSame(2, OverrideBehaviour::REMOTE_OVER_LOCAL);
    }

    public function testPollingModeFactories(): void
    {
        self::assertSame(PollingMode::KIND_AUTO_POLL, PollingMode::autoPoll()->kind);
        self::assertSame(PollingMode::KIND_LAZY_LOAD, PollingMode::lazyLoad()->kind);
        self::assertSame(PollingMode::KIND_MANUAL_POLL, PollingMode::manualPoll()->kind);
    }

    public function testUserConstructorIsStrict(): void
    {
        $user = new User('alice', 'alice@example.com', 'FR', ['plan' => 'pro']);
        self::assertSame('alice', $user->identifier);
        self::assertSame('alice@example.com', $user->email);
        self::assertSame('FR', $user->country);
        self::assertSame(['plan' => 'pro'], $user->custom);
    }
}
