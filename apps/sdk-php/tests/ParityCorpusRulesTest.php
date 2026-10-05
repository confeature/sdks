<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use Confeature\User;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * Targeting-rule parity (spec 135 / #432, epic #382, US3) — the
 * `CORPUS_RULES` corpus injected through the full-config offline override.
 *
 * Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which feed
 * a value-only `overridesMap` via {@see \Confeature\MapOverrideDataSource}),
 * the rule corpus carries the whole `{p, f, s}` config and is injected via
 * {@see FlagOverrides::localConfig} + `OverrideBehaviour::LOCAL_ONLY`. The SDK
 * then resolves targeting rules / segments / % options offline through the
 * real PHP evaluator, exactly as it would against a CDN-served config — no
 * network round-trip.
 *
 * Runner contract (mirrors `apps/sdk-node/tests/parity/parity-rules.test.ts`,
 * sdk-python's `test_parity_rules.py`, sdk-dotnet's `ParityRulesTests`): every
 * tuple branches on the config's `injectionMode`:
 *   - `"full-config"` → capability-probe {@see FlagOverrides::localConfig}.
 *     If sdk-php exposes it, build the override and assert the PUBLIC
 *     `ConfeatureClient::getValue` returns the tuple's `expected`. If it does
 *     NOT, SKIP with a reason — NEVER fall back to the flat-map path (SC-004:
 *     no `"full-config"` tuple is ever resolved on the map path, and a skip is
 *     reported with its reason).
 *
 * sdk-php HAS adopted the full-config path, so every loaded rule tuple runs and
 * passes; there are no skips for this family.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): every tuple MUST pass.
 * If one drifts, STOP and investigate the evaluator / override router — never
 * mutate the corpus. If a real PHP targeting-rule engine gap surfaces (not an
 * override-wiring bug), STOP and file a discrete #382 follow-up — never a
 * corpus or test workaround.
 */
final class ParityCorpusRulesTest extends TestCase
{
    /**
     * Capability probe: does sdk-php expose the in-memory full-config override
     * factory? The full-config path is gated on this — never silently resolved
     * on the flat-map path (SC-004 / AC4 of #432).
     */
    private static function hasFullConfigOverrides(): bool
    {
        return method_exists(FlagOverrides::class, 'localConfig');
    }

    public function testCorpusIsNonEmpty(): void
    {
        // Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
        // foundational #383 tuples are never removed) and grows with every
        // comparator spec, so we assert only that the fixture actually loaded —
        // not a hardcoded total that re-trips on every growth. Per-tuple
        // correctness is covered by the data-provider cases, and JSON↔TS sync is
        // owned by the central `check:exports` gate, so this guard is purely a
        // non-empty smoke and never needs a per-spec bump.
        self::assertGreaterThanOrEqual(
            8,
            count(WorkspaceRoot::parityCorpusRules()),
            'rule corpus is non-empty (append-only floor: at least the 8 '
            . 'foundational rule tuples) — looks empty/truncated, regenerate '
            . "via 'pnpm run export:corpus'.",
        );
    }

    public function testFullConfigFactoryIsExposed(): void
    {
        self::assertTrue(
            self::hasFullConfigOverrides(),
            'FlagOverrides::localConfig must be exposed; sdk-php has adopted '
            . 'the full-config override path (#432).',
        );
    }

    #[DataProvider('corpus')]
    public function testTupleResolvesViaPublicGetValue(
        string $description,
        string $configId,
        string $key,
        mixed $default,
        mixed $expected,
        ?array $rawUser,
        ?string $expectedVariationId,
    ): void {
        $configs = WorkspaceRoot::parityConfigsRules();
        self::assertArrayHasKey(
            $configId,
            $configs,
            "rule corpus references unknown configId={$configId}; "
            . "regenerate fixtures via 'pnpm run export:corpus'.",
        );

        $configRecord = $configs[$configId];
        $injectionMode = $configRecord['injectionMode'] ?? null;

        // The rule corpus is full-config only; a flat-map tuple here would mean
        // a corpus regression, never a silent flat-map fallback (SC-004).
        self::assertSame(
            'full-config',
            $injectionMode,
            "rule corpus tuple {$description} has unexpected "
            . 'injectionMode=' . var_export($injectionMode, true)
            . "; expected 'full-config'.",
        );

        if (!self::hasFullConfigOverrides()) {
            // SC-004: NEVER fall back to the flat-map path — skip with a reason.
            self::markTestSkipped('SDK has not adopted full-config overrides');
        }

        /** @var array<string, mixed> $config */
        $config = $configRecord['config'];
        $flagOverrides = FlagOverrides::localConfig($config, OverrideBehaviour::LOCAL_ONLY);

        // Typed default by SETTING TYPE (spec 152 / #475, US2): the evaluator's
        // int-vs-double TYPE_MISMATCH guard is STRICT (Principle II) — PHP's
        // `is_float(5)` is false, so an int default refuses a `t=3` DOUBLE
        // setting. The corpus encodes numeric defaults as JSON numbers (the 4
        // decimal tuples carry default `-1`, decoded as PHP int), so we coerce
        // the default to match the setting's declared `t` (float for t=3, int
        // for t=2) — fixing the runner, NEVER relaxing the engine.
        $typedDefault = self::typedDefault($config, $key, $default);

        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => $flagOverrides,
            'cache' => null,
            'logger' => new NullLogger(),
        ]);

        try {
            $user = self::buildUser($rawUser);
            $actual = $client->getValue($key, $typedDefault, $user);
            self::assertParityValue($expected, $actual, $description, 'getValue');

            if ($expectedVariationId !== null) {
                // Tuples carrying `expectedVariationId` (spec 150 / #395, spec
                // 152 / #475) additionally assert the PUBLIC getValueDetails
                // envelope's variationId — exercising the override→details
                // propagation path (the #395 gap class). The full-config
                // override routes through the real evaluator, so the details
                // MUST carry the evaluator's variationId, not the value-only
                // flat-map branch's `null`.
                $details = $client->getValueDetails($key, $typedDefault, $user);
                self::assertParityValue(
                    $expected,
                    $details->getValue(),
                    $description,
                    'getValueDetails value',
                );
                self::assertSame(
                    $expectedVariationId,
                    $details->getVariationId(),
                    "variationId parity drift on tuple {$description}: "
                    . 'expected=' . var_export($expectedVariationId, true)
                    . ' actual=' . var_export($details->getVariationId(), true) . '. '
                    . 'Constitution Principle II NON-NEGOTIABLE — the PUBLIC '
                    . 'getValueDetails must propagate the evaluator variationId '
                    . 'through the full-config override path (the #395 gap '
                    . 'class). Investigate the override→getValueDetails router, '
                    . 'do NOT mutate the corpus.',
                );
            }
        } finally {
            $client->close();
        }
    }

    /**
     * Assert a resolved parity value against its expected, comparing numbers
     * NUMERICALLY (the corpus encodes whole DOUBLE expectations as JSON
     * integers, e.g. decimal base `0`, so a strict `assertSame` of int `0`
     * vs float `0.0` would spuriously fail). Non-numeric values keep the
     * strict `assertSame` identity check.
     */
    private static function assertParityValue(
        mixed $expected,
        mixed $actual,
        string $description,
        string $via,
    ): void {
        $message = "targeting-rule parity drift on tuple {$description} ({$via}): "
            . 'expected=' . var_export($expected, true)
            . ' actual=' . var_export($actual, true) . '. '
            . 'Constitution Principle II NON-NEGOTIABLE — investigate the '
            . 'evaluator / override router, do NOT mutate the corpus. If this '
            . 'is a real PHP targeting-rule engine gap (not an override-wiring '
            . 'bug), STOP and file a discrete #382 follow-up — never a corpus '
            . 'or test workaround.';

        if ((\is_int($expected) || \is_float($expected)) && (\is_int($actual) || \is_float($actual))) {
            self::assertEqualsWithDelta((float) $expected, (float) $actual, 0.0, $message);

            return;
        }

        self::assertSame($expected, $actual, $message);
    }

    /**
     * Coerce a corpus default to the declared setting type (`t`) so the
     * evaluator's strict int-vs-double TYPE_MISMATCH guard is satisfied
     * without relaxing the engine: `t=3` (DOUBLE) → float, `t=2` (INT) → int.
     * Every other type (or an absent / non-numeric default) passes through
     * verbatim.
     *
     * @param array<string, mixed> $config
     */
    private static function typedDefault(array $config, string $key, mixed $default): mixed
    {
        $type = $config['f'][$key]['t'] ?? null;
        if (\is_int($default) || \is_float($default)) {
            if ($type === 3) {
                return (float) $default;
            }
            if ($type === 2) {
                return (int) $default;
            }
        }

        return $default;
    }

    /**
     * @return iterable<string, array{0: string, 1: string, 2: string, 3: mixed, 4: mixed, 5: ?array<string, mixed>, 6: ?string}>
     */
    public static function corpus(): iterable
    {
        foreach (WorkspaceRoot::parityCorpusRules() as $i => $tuple) {
            $description = (string) ($tuple['description'] ?? '');
            $label = sprintf('tuple #%02d %s', $i, $description);
            yield $label => [
                $description,
                (string) $tuple['configId'],
                (string) $tuple['key'],
                $tuple['defaultValue'],
                $tuple['expected'],
                \is_array($tuple['user'] ?? null) ? $tuple['user'] : null,
                // `expectedVariationId` (spec 150 / #395, spec 152 / #475) is
                // present only on the 14 variationId tuples; absent → value-only.
                \is_string($tuple['expectedVariationId'] ?? null) ? $tuple['expectedVariationId'] : null,
            ];
        }
    }

    /**
     * Build the typed targeting user from the corpus encoding (spec 151 / #468,
     * non-finite `{$num}` tag #479).
     *
     * `user.custom` values are rehydrated from the typed-attribute encoding —
     * the inverse of the exporter's `JSON.stringify` (see
     * `packages/test-fixtures-sdk-parity/scripts/export-corpus.ts`):
     *   - `string` / `int|float` (JSON number) / `array<string>` → verbatim;
     *   - `{"$date": <epoch-seconds>}` → a UTC `DateTimeImmutable` at that
     *     fractional second (the inverse of `dateTimeToUnixTimeSeconds`);
     *   - `{"$num": "NaN"|"Infinity"|"-Infinity"}` → the non-finite PHP float
     *     `NAN` / `INF` / `-INF` (#479 — JSON has no NaN/±Infinity literal).
     * The decoded map is handed to the PUBLIC `Confeature\User`, whose `custom`
     * is `array<string, mixed>` (typed, ConfigCat-parity). The evaluator
     * converts each value at comparison time.
     *
     * @param array<string, mixed>|null $raw
     */
    private static function buildUser(?array $raw): ?User
    {
        if ($raw === null) {
            return null;
        }

        return new User(
            identifier: \is_string($raw['identifier'] ?? null) ? $raw['identifier'] : '',
            email: \is_string($raw['email'] ?? null) ? $raw['email'] : null,
            country: \is_string($raw['country'] ?? null) ? $raw['country'] : null,
            custom: self::decodeCustom(\is_array($raw['custom'] ?? null) ? $raw['custom'] : null),
        );
    }

    /**
     * @param array<string, mixed>|null $custom
     *
     * @return array<string, mixed>|null
     */
    private static function decodeCustom(?array $custom): ?array
    {
        if ($custom === null) {
            return null;
        }
        $out = [];
        foreach ($custom as $key => $raw) {
            $out[(string) $key] = self::decodeCustomValue($raw);
        }

        return $out;
    }

    /**
     * Decode one typed-attribute-encoded `user.custom` value. Two tagged forms
     * rehydrate to native typed attributes; every other natural-JSON value
     * (string / number / bool / string array) is returned verbatim:
     *   - `{"$date": n}` → a UTC `DateTimeImmutable` at epoch seconds `n`
     *     (inverse of `dateTimeToUnixTimeSeconds`);
     *   - `{"$num": "NaN"|"Infinity"|"-Infinity"}` → the non-finite PHP float
     *     `NAN` / `INF` / `-INF` (#479). JSON has no NaN/±Infinity literal, so
     *     the exporter tags them; finite numbers ride through as plain JSON
     *     numbers and need no tag.
     */
    private static function decodeCustomValue(mixed $raw): mixed
    {
        if (\is_array($raw) && \array_keys($raw) === ['$date'] && (\is_int($raw['$date']) || \is_float($raw['$date']))) {
            $seconds = (float) $raw['$date'];

            $dateTime = \DateTimeImmutable::createFromFormat(
                'U\.v',
                sprintf('%1.3F', $seconds),
                new \DateTimeZone('UTC'),
            );
            if ($dateTime !== false) {
                return $dateTime;
            }
        }

        if (\is_array($raw) && \array_keys($raw) === ['$num']) {
            switch ($raw['$num']) {
                case 'NaN':
                    return \NAN;
                case 'Infinity':
                    return \INF;
                case '-Infinity':
                    return -\INF;
            }
        }

        return $raw;
    }
}
