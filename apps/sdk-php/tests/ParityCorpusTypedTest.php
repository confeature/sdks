<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use Confeature\User;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * Spec 072 US2 typed-parity gate — 13/13 byte-identical to ConfigCat.
 *
 * Sibling to ParityCorpusTest. Loads the 13-tuple typed corpus + the
 * typed configs from `packages/test-fixtures-sdk-parity/fixtures/`,
 * builds one ConfeatureClient per tuple in ManualPoll mode with a
 * LOCAL_ONLY override bundle holding the tuple's config-specific
 * typed map, and asserts that the widened PHP evaluator resolves each
 * tuple to its `expected` value via `assertSame` (PHP's type-strict
 * `===` equality — the tightest comparison of the five scripting
 * SDKs, catches any int↔float decoder drift the strict t:3 arm
 * would otherwise miss).
 *
 * PHP's `json_decode` decodes whole-number JSON literals as `int`
 * even when they semantically encode a `t=3` double slot. We
 * rehydrate the corpus per `SettingType` so the int-valued
 * `feature.zero-threshold` lands as `float(0.0)`. The override map
 * needs the same normalisation — OverrideEval Branch 6 uses
 * `get_debug_type` to compare slot kinds, so an int override against
 * a float default would otherwise hit TYPE_MISMATCH. The Python
 * typed driver follows the same pattern.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST
 * pass. If a tuple drifts, STOP and investigate the evaluator code —
 * never mutate the corpus to make the test green.
 */
final class ParityCorpusTypedTest extends TestCase
{
    private const SETTING_TYPE_INT = 2;
    private const SETTING_TYPE_DOUBLE = 3;

    public function testCorpusHas13Tuples(): void
    {
        self::assertCount(13, WorkspaceRoot::parityCorpusTyped());
    }

    #[DataProvider('corpus')]
    public function testTupleIsByteIdentical(
        string $configId,
        string $key,
        mixed $default,
        mixed $expected,
        ?array $rawUser,
    ): void {
        $configs = WorkspaceRoot::parityConfigsTyped();
        self::assertArrayHasKey(
            $configId,
            $configs,
            "typed parity corpus references unknown configId={$configId}",
        );

        $settingTypes = self::settingTypesByKey($configs[$configId]);

        /** @var array<string, bool|int|float|string> $overridesMap */
        $overridesMap = $configs[$configId]['overridesMap'];
        $overridesMap = self::normaliseOverrides($overridesMap, $settingTypes);

        $settingType = $settingTypes[$key] ?? null;
        if ($settingType !== null) {
            $default = self::normaliseForSettingType($default, $settingType);
            $expected = self::normaliseForSettingType($expected, $settingType);
        }

        $dataSource = MapOverrideDataSource::ofMap($overridesMap);
        $flagOverrides = new FlagOverrides($dataSource, OverrideBehaviour::LOCAL_ONLY);

        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => $flagOverrides,
            'cache' => null,
            'logger' => new NullLogger(),
        ]);

        try {
            $actual = $client->getValue($key, $default, self::buildUser($rawUser));
            self::assertSame(
                $expected,
                $actual,
                "typed parity drift on key={$key} configId={$configId}",
            );
        } finally {
            $client->close();
        }
    }

    /**
     * @return iterable<string, array{0: string, 1: string, 2: mixed, 3: mixed, 4: ?array<string, mixed>}>
     */
    public static function corpus(): iterable
    {
        foreach (WorkspaceRoot::parityCorpusTyped() as $i => $tuple) {
            $label = sprintf('tuple #%02d %s', $i, (string) ($tuple['description'] ?? ''));
            yield $label => [
                (string) $tuple['configId'],
                (string) $tuple['key'],
                $tuple['defaultValue'],
                $tuple['expected'],
                \is_array($tuple['user'] ?? null) ? $tuple['user'] : null,
            ];
        }
    }

    /**
     * @param array<string, mixed> $configRecord
     *
     * @return array<string, int>
     */
    private static function settingTypesByKey(array $configRecord): array
    {
        $out = [];
        $settings = $configRecord['config']['f'] ?? null;
        if (!\is_array($settings)) {
            return $out;
        }
        foreach ($settings as $key => $setting) {
            if (\is_array($setting) && \is_int($setting['t'] ?? null)) {
                $out[(string) $key] = $setting['t'];
            }
        }

        return $out;
    }

    /**
     * Rehydrate a JSON-decoded primitive against a SettingType. JSON
     * has one numeric type; PHP's strict evaluator distinguishes
     * `int` (`t=2`) from `float` (`t=3`).
     */
    private static function normaliseForSettingType(mixed $value, int $settingType): mixed
    {
        if (\is_bool($value)) {
            return $value;
        }
        if ($settingType === self::SETTING_TYPE_INT && \is_float($value)) {
            return (int) $value;
        }
        if ($settingType === self::SETTING_TYPE_DOUBLE && \is_int($value)) {
            return (float) $value;
        }

        return $value;
    }

    /**
     * @param array<string, bool|int|float|string> $overrides
     * @param array<string, int>                   $settingTypes
     *
     * @return array<string, bool|int|float|string>
     */
    private static function normaliseOverrides(array $overrides, array $settingTypes): array
    {
        $out = [];
        foreach ($overrides as $key => $value) {
            $st = $settingTypes[$key] ?? null;
            /** @var bool|int|float|string $normalised */
            $normalised = $st === null ? $value : self::normaliseForSettingType($value, $st);
            $out[$key] = $normalised;
        }

        return $out;
    }

    /**
     * @param array<string, mixed>|null $raw
     */
    private static function buildUser(?array $raw): ?User
    {
        if ($raw === null) {
            return null;
        }
        /** @var array<string, string|int|float|bool|null>|null $custom */
        $custom = \is_array($raw['custom'] ?? null) ? $raw['custom'] : null;

        return new User(
            identifier: \is_string($raw['identifier'] ?? null) ? $raw['identifier'] : '',
            email: \is_string($raw['email'] ?? null) ? $raw['email'] : null,
            country: \is_string($raw['country'] ?? null) ? $raw['country'] : null,
            custom: $custom,
        );
    }
}
