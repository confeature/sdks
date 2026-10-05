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
 * Spec 044 US1 parity gate — 58/58 byte-identical to ConfigCat.
 *
 * Loads the TS-generated parity corpus and the canonical configs
 * from `packages/test-fixtures-sdk-parity/fixtures/`, builds one
 * ConfeatureClient per tuple in ManualPoll mode with a LOCAL_ONLY
 * override bundle holding the tuple's config-specific map, and
 * asserts that the resolved value equals the recorded `expected`
 * field byte-for-byte.
 *
 * Constitution invariant (Principle II NON-NEGOTIABLE): every
 * tuple MUST pass. If one drifts, STOP and investigate the
 * override-eval / evaluator code — never mutate the corpus to
 * make the test green.
 */
final class ParityCorpusTest extends TestCase
{
    public function testCorpusHas58Tuples(): void
    {
        self::assertCount(58, WorkspaceRoot::parityCorpus());
    }

    #[DataProvider('corpus')]
    public function testTupleIsByteIdentical(
        string $configId,
        string $key,
        mixed $default,
        mixed $expected,
        ?array $rawUser,
    ): void {
        $configs = WorkspaceRoot::parityConfigs();
        self::assertArrayHasKey(
            $configId,
            $configs,
            "parity corpus references unknown configId={$configId}",
        );

        /** @var array<string, bool|int|float|string> $overridesMap */
        $overridesMap = $configs[$configId]['overridesMap'];

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
                "parity drift on key={$key} configId={$configId}",
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
        foreach (WorkspaceRoot::parityCorpus() as $i => $tuple) {
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
