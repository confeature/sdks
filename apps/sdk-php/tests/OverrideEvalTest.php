<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\FlagOverrides;
use Confeature\Internal\OverrideEval;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\OverrideDataSource;
use Confeature\SettingValue;
use PHPUnit\Framework\TestCase;

/**
 * Cover every branch of the 7-branch decision tree explicitly so a
 * future refactor that drops a branch fails loud.
 */
final class OverrideEvalTest extends TestCase
{
    public function testBranch1NullOverridesFallsThrough(): void
    {
        [$found, $value] = OverrideEval::evaluateSync(null, 'feature.dark', false);
        self::assertFalse($found);
        self::assertNull($value);
    }

    public function testBranch2NonLocalOnlyFallsThrough(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.dark' => true]),
            OverrideBehaviour::LOCAL_OVER_REMOTE,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertFalse($found);
        self::assertNull($value);
    }

    public function testBranch3NullSyncMapFallsThrough(): void
    {
        $emptyDataSource = new class () implements OverrideDataSource {
            public function getOverridesSync(): ?array
            {
                return null;
            }
        };
        $fo = new FlagOverrides($emptyDataSource, OverrideBehaviour::LOCAL_ONLY);
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertFalse($found);
        self::assertNull($value);
    }

    public function testBranch4KeyAbsentReturnsDefault(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.other' => true]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertTrue($found);
        self::assertFalse($value);
    }

    public function testBranch5EmptySlotReturnsDefault(): void
    {
        $emptyOverrideMap = new class () implements OverrideDataSource {
            public function getOverridesSync(): ?array
            {
                return ['feature.dark' => new SettingValue()];
            }
        };
        $fo = new FlagOverrides($emptyOverrideMap, OverrideBehaviour::LOCAL_ONLY);
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertTrue($found);
        self::assertFalse($value);
    }

    public function testBranch6TypeMismatchReturnsDefault(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.dark' => 'a string']),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertTrue($found);
        self::assertFalse($value);
    }

    public function testBranch6NullDefaultBypassesTypeCheck(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.dark' => 'a string']),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', null);
        self::assertTrue($found);
        self::assertSame('a string', $value);
    }

    public function testBranch7HappyPathReturnsOverrideValue(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['feature.dark' => true]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'feature.dark', false);
        self::assertTrue($found);
        self::assertTrue($value);
    }

    public function testBranch7IntOverride(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['count' => 42]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'count', 0);
        self::assertTrue($found);
        self::assertSame(42, $value);
    }

    public function testBranch7FloatOverride(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['ratio' => 0.25]),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'ratio', 0.0);
        self::assertTrue($found);
        self::assertSame(0.25, $value);
    }

    public function testBranch7StringOverride(): void
    {
        $fo = new FlagOverrides(
            MapOverrideDataSource::ofMap(['name' => 'pro']),
            OverrideBehaviour::LOCAL_ONLY,
        );
        [$found, $value] = OverrideEval::evaluateSync($fo, 'name', '');
        self::assertTrue($found);
        self::assertSame('pro', $value);
    }
}
