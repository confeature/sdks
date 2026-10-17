<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\ConfigFetcher;
use GuzzleHttp\Client as GuzzleClient;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

/**
 * sdk-php live wire-cases (#920, after sdk-python's #783).
 *
 * sdk-php's own `ConfigFetcher` — its real Guzzle stack, no injected client —
 * against a RUNNING live-contract harness serving the reference origin of
 * the CDN read path. Every seeded wire-case is replayed and judged by
 * `WireCaseAssertions`, the SAME rules the hermetic suite (`WireCasesTest`)
 * applies to a mocked transport. Nothing is hand-built here and no admin
 * write is made:
 *
 *   - the case set comes from the running harness (`GET /admin/state` →
 *     `keys`), never recomputed from the corpus and the seeds directory —
 *     `http-403` among them, an unseeded key answered by the Worker itself;
 *   - the request each case sent is read back from the harness
 *     (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
 *     asserted on the wire, and each fetch must add exactly one entry;
 *   - a timeout case is ended by the SDK's OWN deadline
 *     (`requestTimeoutSeconds`, a quarter of the harness's hold);
 *   - US4: one unseeded key reaches the Worker's own unknown-key answer.
 *
 * Run it through the harness wrapper, the one agreed boot (the manifest's
 * `liveSuite.runner`):
 *
 *     node tools/test-harness-live-contract/dist/cli.js --corpus-seed \
 *       --exec -- bash -c 'cd apps/sdk-php && vendor/bin/phpunit tests/WireCasesLiveTest.php'
 *
 * GATING (fail closed): skipped only when `CONFEATURE_LIVE` is unset — the
 * hermetic `composer test` run. When it is set without `LIVE_HARNESS_URL`
 * every test FAILS; it never skips.
 */
final class WireCasesLiveTest extends TestCase
{
    use WireCaseAssertions;

    private const SDK_VERSION = '0.0.0-live-wire';

    /** The data-provider row of a run that has no harness to ask. */
    private const NO_HARNESS = '(no harness)';

    /** @var array<string, mixed>|null The harness's `GET /admin/state`, read once. */
    private static ?array $state = null;

    protected function setUp(): void
    {
        if (!self::live()) {
            self::markTestSkipped('hermetic run: CONFEATURE_LIVE is not set');
        }
        if (self::harnessUrl() === '') {
            self::fail(
                'CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through '
                . '`live-contract-harness --corpus-seed --exec -- …`; a live suite must never pass by skipping',
            );
        }
    }

    /**
     * One row per key the harness seeded. Without a harness (hermetic run,
     * or the fail-closed misconfiguration) one placeholder row, which
     * `setUp` skips or fails — an empty provider would be a PHPUnit warning,
     * not a verdict.
     *
     * @return iterable<string, array{0: string}>
     */
    public static function seededCaseIds(): iterable
    {
        if (!self::live() || self::harnessUrl() === '') {
            yield self::NO_HARNESS => [self::NO_HARNESS];

            return;
        }
        $keys = self::state()['keys'] ?? [];
        self::assertIsArray($keys);
        sort($keys);
        foreach ($keys as $id) {
            self::assertIsString($id);
            yield $id => [$id];
        }
    }

    public function testTheHarnessServesANonEmptySeededSetAllInTheCorpus(): void
    {
        $keys = self::state()['keys'] ?? [];
        self::assertIsArray($keys);
        self::assertNotEmpty($keys, 'the harness reports no seeded case — an empty run checks nothing');
        $unknown = array_values(array_diff($keys, array_keys(self::loadWireCases())));
        self::assertSame([], $unknown, 'seeded keys missing from the corpus');
    }

    #[DataProvider('seededCaseIds')]
    public function testLiveWireCase(string $caseId): void
    {
        $case = self::loadWireCases()[$caseId] ?? null;
        self::assertIsArray($case, "{$caseId} is not a corpus case");
        self::assertKnownWireFields($case);

        $timeoutSeconds = 10.0;
        $holdMs = null;
        if (($case['server']['behavior'] ?? 'respond') === 'timeout') {
            // The SDK's deadline is derived from the harness's hold (#783 A8).
            $faults = self::state()['faults'] ?? [];
            $fault = \is_array($faults) ? ($faults[$caseId] ?? null) : null;
            $holdMs = \is_array($fault) && is_numeric($fault['ms'] ?? null) ? (float) $fault['ms'] : null;
            self::assertNotNull($holdMs, "{$caseId} is seeded without a timeout fault");
            $timeoutSeconds = $holdMs / 4 / 1000;
        }

        // The harness seeds each case under its id; a case that pins
        // given.sdkKey is configured with that key instead (#803 FR-003).
        $sdkKey = self::wireSdkKey($case, $caseId);
        $before = \count(self::requestsFor($sdkKey));
        $started = hrtime(true);
        $fetcher = new ConfigFetcher(
            sdkKey: $sdkKey,
            version: self::SDK_VERSION,
            logger: new NullLogger(),
            baseUrl: self::harnessUrl(),
            requestTimeoutSeconds: $timeoutSeconds,
        );
        $previousEtag = $case['given']['previousEtag'] ?? null;
        self::assertTrue($previousEtag === null || \is_string($previousEtag));
        $result = $fetcher->fetch($previousEtag);
        $fetcher->close();
        $elapsedMs = (hrtime(true) - $started) / 1e6;

        $log = self::requestsFor($sdkKey);
        // Exactly one request per fetch: a retrying SDK, or a request logged
        // by an earlier run, must not stand in for the one under test.
        self::assertSame(1, \count($log) - $before, "{$caseId}: requests sent by one fetch");
        if ($holdMs !== null) {
            // The SDK's own deadline ended the fetch, not the harness releasing it.
            self::assertLessThan($holdMs, $elapsedMs, "{$caseId}: aborted before the hold");
        }
        $last = $log[\count($log) - 1];
        self::assertIsArray($last);
        $url = $last['url'] ?? null;
        $ifNoneMatch = $last['ifNoneMatch'] ?? null;
        self::assertIsString($url);
        self::assertTrue($ifNoneMatch === null || \is_string($ifNoneMatch));
        self::assertWireRequest($case, (string) parse_url($url, PHP_URL_PATH), $url, $ifNoneMatch, $sdkKey);
        self::assertWireOutcome($case, $result);
    }

    /**
     * US4: no seed, no fault — the CDN's own unknown-key answer, ConfigCat's
     * 403 since #785, classed like a 404 as `invalidSdkKey`.
     */
    public function testAnUnseededKeyReachesTheWorkerAndReportsInvalidSdkKey(): void
    {
        $fetcher = new ConfigFetcher(
            sdkKey: 'never-seeded-920',
            version: self::SDK_VERSION,
            logger: new NullLogger(),
            baseUrl: self::harnessUrl(),
            requestTimeoutSeconds: 10.0,
        );
        $result = $fetcher->fetch();
        $fetcher->close();
        self::assertSame('failed', $result->status);
        self::assertSame('invalidSdkKey', self::mapErrorToClass($result->error), (string) $result->error);
    }

    private static function live(): bool
    {
        return getenv('CONFEATURE_LIVE') === '1';
    }

    private static function harnessUrl(): string
    {
        return rtrim((string) getenv('LIVE_HARNESS_URL'), '/');
    }

    /**
     * @return array<string, mixed>
     */
    private static function state(): array
    {
        return self::$state ??= self::getJson('/admin/state', []);
    }

    /**
     * The requests the harness logged for `$sdkKey`, oldest first.
     *
     * @return list<mixed>
     */
    private static function requestsFor(string $sdkKey): array
    {
        $body = self::getJson('/admin/requests', ['sdkKey' => $sdkKey]);
        self::assertTrue($body['ok'] ?? false, 'harness refused /admin/requests');
        $requests = $body['requests'] ?? null;
        self::assertIsArray($requests);

        return array_values($requests);
    }

    /**
     * @param array<string, string> $query
     *
     * @return array<string, mixed>
     */
    private static function getJson(string $path, array $query): array
    {
        $response = (new GuzzleClient(['timeout' => 10.0, 'http_errors' => true]))
            ->get(self::harnessUrl() . $path, ['query' => $query]);
        $body = json_decode((string) $response->getBody(), true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($body);

        return $body;
    }
}
