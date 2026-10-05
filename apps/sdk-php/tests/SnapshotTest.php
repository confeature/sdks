<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\Snapshot;
use PHPUnit\Framework\TestCase;

/**
 * Direct unit coverage for `Snapshot` (the parity corpus exercises it
 * via the client, but a few branches — `getAllKeys`, null-config,
 * overrides-only — are easier to pin here).
 */
final class SnapshotTest extends TestCase
{
    public function testGetValueWithNullConfigReturnsDefault(): void
    {
        $snapshot = new Snapshot(config: null, flagOverrides: null);
        self::assertSame('default', $snapshot->getValue('feature.dark', 'default'));
    }

    public function testGetValueWithLocalOnlyOverrideShortCircuits(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.dark' => true]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        $snapshot = new Snapshot(config: null, flagOverrides: $fo);
        self::assertTrue($snapshot->getValue('feature.dark', false));
    }

    public function testGetValueWithConfigOnly(): void
    {
        $config = [
            'f' => [
                'feature.dark' => ['t' => 0, 'v' => ['b' => true]],
            ],
        ];
        $snapshot = new Snapshot(config: $config, flagOverrides: null);
        self::assertTrue($snapshot->getValue('feature.dark', false));
    }

    public function testGetAllKeysMergesConfigAndOverrides(): void
    {
        $config = [
            'f' => [
                'feature.a' => ['t' => 0, 'v' => ['b' => true]],
                'feature.b' => ['t' => 0, 'v' => ['b' => false]],
            ],
        ];
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap([
                'feature.b' => true,
                'feature.c' => false,
            ]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        $snapshot = new Snapshot(config: $config, flagOverrides: $fo);
        self::assertSame(['feature.a', 'feature.b', 'feature.c'], $snapshot->getAllKeys());
    }

    public function testGetAllKeysWithNoConfigOrOverridesIsEmpty(): void
    {
        $snapshot = new Snapshot(config: null, flagOverrides: null);
        self::assertSame([], $snapshot->getAllKeys());
    }

    public function testGetAllKeysWithMalformedConfigIgnoresIt(): void
    {
        $snapshot = new Snapshot(config: ['no-f-key' => 'oops'], flagOverrides: null);
        self::assertSame([], $snapshot->getAllKeys());
    }
}
