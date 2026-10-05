<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\ConfeatureClient;
use Confeature\FlagOverrides;
use Confeature\Internal\SdkKey;
use Confeature\MapOverrideDataSource;
use Confeature\OverrideBehaviour;
use Confeature\PollingMode;
use Confeature\Snapshot;
use Confeature\User;
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\NullLogger;
use Psr\SimpleCache\CacheInterface;

/**
 * Constructor + lifecycle smoke tests. Network is never hit because
 * every test wires a LOCAL_ONLY override or passes `cache: null` +
 * ManualPoll (no eager fetch).
 */
final class ConfeatureClientTest extends TestCase
{
    public function testCreateWithLocalOnlyOverridesReturnsTypedValue(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);

        self::assertTrue($client->getValue('feature.dark', false));
        self::assertSame(false, $client->getValue('missing.key', false));
        $client->close();
    }

    public function testCreateRejectsEmptySdkKey(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create('', []);
    }

    /**
     * #802: a ConfigCat-shaped key (`configcat-sdk-1/<22>/<22>`, the shape
     * Confeature mints) and a legacy key are both valid, so neither logs
     * INVALID_SDK_KEY; a malformed key does, redacted.
     */
    public function testInvalidSdkKeyWarningOnlyForMalformedKeys(): void
    {
        foreach ([WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY, WorkspaceRoot::SAMPLE_SDK_KEY] as $key) {
            self::assertSame([], self::constructionLogLines($key), 'valid key logged at construction: ' . SdkKey::redact($key));
        }

        $malformed = 'configcat-sdk-1/tooShort/SECRETSECRETSECRETSECRET';
        $lines = self::constructionLogLines($malformed);
        self::assertCount(1, $lines);
        self::assertStringContainsString('INVALID_SDK_KEY', $lines[0]);
        self::assertStringNotContainsString($malformed, $lines[0]);
        self::assertStringNotContainsString('SECRETSECRETSECRET', $lines[0]);
    }

    public function testCreateRejectsBadPollingModeOption(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => 'auto-poll',
        ]);
    }

    public function testCreateRejectsBadLoggerOption(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'logger' => new \stdClass(),
        ]);
    }

    public function testCreateRejectsBadFlagOverridesOption(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'flagOverrides' => 'not-a-flag-overrides',
        ]);
    }

    public function testCreateRejectsBadCacheOption(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'cache' => new \stdClass(),
        ]);
    }

    public function testCreateRejectsBadTimeout(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'requestTimeoutSeconds' => 0.0,
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap([]),
                OverrideBehaviour::LOCAL_ONLY,
            ),
        ]);
    }

    public function testCloseIsIdempotent(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $client->close();
        $client->close();
        self::assertSame(false, $client->getValue('feature.dark', false));
    }

    public function testGetValueAfterCloseReturnsDefault(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $client->close();
        self::assertSame('default', $client->getValue('feature.dark', 'default'));
    }

    public function testForceRefreshOnLocalOnlyReturnsTrue(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        self::assertTrue($client->forceRefresh());
        $client->close();
    }

    public function testForceRefreshAfterCloseReturnsFalse(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $client->close();
        self::assertFalse($client->forceRefresh());
    }

    public function testGetSnapshotIsImmutableView(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $snapshot = $client->getSnapshot();
        self::assertInstanceOf(Snapshot::class, $snapshot);
        self::assertTrue($snapshot->getValue('feature.dark', false));
        $client->close();
    }

    public function testDefaultUserIsHonouredWhenGetValueUserIsNull(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true], new User('alice@example.com'));
        // LocalOnly bypasses user-targeting, but the option must still
        // be accepted without raising.
        self::assertTrue($client->getValue('feature.dark', false));
        $client->close();
    }

    public function testManualPollNoOverridesNoFetchUntilForceRefresh(): void
    {
        $body = ['f' => ['feature.dark' => ['t' => 0, 'v' => ['b' => true]]]];
        $mock = new MockHandler([
            new Response(200, ['ETag' => '"v1"'], (string) json_encode($body)),
        ]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            // ManualPoll: no eager fetch -> default is returned.
            self::assertFalse($client->getValue('feature.dark', false));
            self::assertSame(1, $mock->count(), 'no requests yet — response still queued');
            // forceRefresh now consumes the queued response.
            self::assertTrue($client->forceRefresh());
            self::assertSame(0, $mock->count(), 'response consumed by forceRefresh');
            self::assertTrue($client->getValue('feature.dark', false));
        } finally {
            $client->close();
        }
    }

    public function testAutoPollPerformsEagerFirstFetch(): void
    {
        $body = ['f' => ['feature.dark' => ['t' => 0, 'v' => ['b' => true]]]];
        $mock = new MockHandler([
            new Response(200, ['ETag' => '"v1"'], (string) json_encode($body)),
        ]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::autoPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            self::assertTrue($client->getValue('feature.dark', false));
            self::assertSame(0, $mock->count(), 'queued response consumed by eager fetch');
        } finally {
            $client->close();
        }
    }

    public function testForceRefreshReturnsFalseOnFailedFetch(): void
    {
        $mock = new MockHandler([new Response(500, [], 'boom')]);
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => null,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);

        try {
            self::assertFalse($client->forceRefresh());
            // last good config is null -> default returned.
            self::assertFalse($client->getValue('feature.dark', false));
        } finally {
            $client->close();
        }
    }

    public function testCacheRoundTripSeedsFromCache(): void
    {
        $body = ['f' => ['feature.dark' => ['t' => 0, 'v' => ['b' => true]]]];
        $cache = new InMemoryStringCache();
        // First client populates the cache.
        $mock = new MockHandler([
            new Response(200, ['ETag' => '"v1"'], (string) json_encode($body)),
        ]);
        $client1 = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => $cache,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($mock)]),
        ]);
        $client1->forceRefresh();
        $client1->close();

        // Second client seeds directly from cache (no HTTP).
        $emptyMock = new MockHandler([]);
        $client2 = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'cache' => $cache,
            'logger' => new NullLogger(),
            'httpClient' => new GuzzleClient(['handler' => HandlerStack::create($emptyMock)]),
        ]);
        try {
            self::assertTrue($client2->getValue('feature.dark', false));
        } finally {
            $client2->close();
        }
    }

    public function testGetSnapshotWhileLocalOnlyDoesNotFetch(): void
    {
        $client = self::buildLocalOnlyClient(['feature.dark' => true]);
        $snapshot = $client->getSnapshot();
        self::assertTrue($snapshot->getValue('feature.dark', false));
        $client->close();
    }

    public function testLocalOverRemoteFallsThroughToConfig(): void
    {
        // Spec says LOCAL_OVER_REMOTE is accepted but falls through in
        // v1 — the override map is ignored, so the default is returned.
        $client = ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap(['feature.dark' => true]),
                OverrideBehaviour::LOCAL_OVER_REMOTE,
            ),
            'cache' => null,
            'logger' => new NullLogger(),
        ]);
        try {
            self::assertFalse($client->getValue('feature.dark', false));
        } finally {
            $client->close();
        }
    }

    /**
     * Construct a LOCAL_ONLY client (no fetch) and return every log line
     * the constructor emitted.
     *
     * @return list<string>
     */
    private static function constructionLogLines(string $sdkKey): array
    {
        $logger = new class () extends AbstractLogger {
            /** @var list<string> */
            public array $lines = [];

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                $this->lines[] = (string) $message;
            }
        };
        $client = ConfeatureClient::create($sdkKey, [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap([]),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'cache' => null,
            'logger' => $logger,
        ]);
        $lines = $logger->lines;
        $client->close();

        return $lines;
    }

    /**
     * @param array<string, bool|int|float|string> $map
     */
    private static function buildLocalOnlyClient(array $map, ?User $defaultUser = null): ConfeatureClient
    {
        $options = [
            'pollingMode' => PollingMode::manualPoll(),
            'flagOverrides' => new FlagOverrides(
                MapOverrideDataSource::ofMap($map),
                OverrideBehaviour::LOCAL_ONLY,
            ),
            'cache' => null,
            'logger' => new NullLogger(),
        ];
        if ($defaultUser !== null) {
            $options['defaultUser'] = $defaultUser;
        }

        return ConfeatureClient::create(WorkspaceRoot::SAMPLE_SDK_KEY, $options);
    }
}

/**
 * Minimal PSR-16 cache holding string payloads in process memory. Used
 * by the cache round-trip test — we cannot wire the real
 * `FilesystemCache` here because PHPUnit's tmpdir cleanup races with
 * the parallel test execution order.
 */
final class InMemoryStringCache implements CacheInterface
{
    /** @var array<string, string> */
    private array $store = [];

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->store[$key] ?? $default;
    }

    public function set(string $key, mixed $value, \DateInterval|int|null $ttl = null): bool
    {
        if (!\is_string($value)) {
            return false;
        }
        $this->store[$key] = $value;

        return true;
    }

    public function delete(string $key): bool
    {
        unset($this->store[$key]);

        return true;
    }

    public function clear(): bool
    {
        $this->store = [];

        return true;
    }

    public function getMultiple(iterable $keys, mixed $default = null): iterable
    {
        foreach ($keys as $key) {
            yield $key => $this->get((string) $key, $default);
        }
    }

    public function setMultiple(iterable $values, \DateInterval|int|null $ttl = null): bool
    {
        foreach ($values as $key => $value) {
            $this->set((string) $key, $value, $ttl);
        }

        return true;
    }

    public function deleteMultiple(iterable $keys): bool
    {
        foreach ($keys as $key) {
            $this->delete((string) $key);
        }

        return true;
    }

    public function has(string $key): bool
    {
        return isset($this->store[$key]);
    }
}
