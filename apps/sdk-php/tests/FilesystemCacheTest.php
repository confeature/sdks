<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\FilesystemCache;
use Confeature\Internal\InMemoryCache;
use Confeature\Internal\SdkKey;
use PHPUnit\Framework\TestCase;

/**
 * Unit coverage for `FilesystemCache` + `InMemoryCache`.
 *
 * Each test uses a private tmpdir (created with `tempnam` + `unlink` +
 * `mkdir`) so the cases never collide. We exercise:
 *
 *   - PSR-16 round-trip (`set` then `get`).
 *   - The atomic-write contract (no half-written files visible
 *     between `set` calls).
 *   - The `has` / `delete` happy paths.
 *   - Filesystem fallback when the configured cache dir is not
 *     writable (the in-memory mirror still serves the last write).
 *   - InMemoryCache TTL expiry.
 */
final class FilesystemCacheTest extends TestCase
{
    private string $cacheDir = '';

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . \DIRECTORY_SEPARATOR . 'confeature-tests-' . bin2hex(random_bytes(6));
        if (!@mkdir($base, 0o755, true) && !is_dir($base)) {
            self::fail('Could not create tmpdir at ' . $base);
        }
        $this->cacheDir = $base;
    }

    protected function tearDown(): void
    {
        if ($this->cacheDir !== '' && is_dir($this->cacheDir)) {
            foreach ((array) @scandir($this->cacheDir) as $entry) {
                if (!\is_string($entry) || $entry === '.' || $entry === '..') {
                    continue;
                }
                $full = $this->cacheDir . \DIRECTORY_SEPARATOR . $entry;
                if (is_file($full)) {
                    @unlink($full);
                }
            }
            @rmdir($this->cacheDir);
        }
    }

    public function testGetReturnsDefaultWhenKeyAbsent(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        self::assertSame('fallback', $cache->get('missing', 'fallback'));
    }

    public function testRoundTripsStringPayload(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $key = SdkKey::deriveCacheKey(WorkspaceRoot::SAMPLE_SDK_KEY);
        $payload = '{"body":{"f":{}},"etag":"v1"}';
        self::assertTrue($cache->set($key, $payload));
        self::assertSame($payload, $cache->get($key));
        self::assertTrue($cache->has($key));
    }

    public function testSetWritesAtomicallyViaTempnamRename(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $key = SdkKey::deriveCacheKey(WorkspaceRoot::SAMPLE_SDK_KEY);
        $cache->set($key, 'first');
        $cache->set($key, 'second');
        // Atomic: after both writes only the final value is visible
        // and no temp leftovers are kept around as separate entries.
        self::assertSame('second', $cache->get($key));

        $files = array_filter(
            (array) scandir($this->cacheDir),
            static fn ($e) => \is_string($e) && str_starts_with($e, 'confeature-') && str_ends_with($e, '.json'),
        );
        self::assertCount(1, $files);
    }

    public function testDeleteRemovesFileAndMemoryMirror(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $key = SdkKey::deriveCacheKey(WorkspaceRoot::SAMPLE_SDK_KEY);
        $cache->set($key, 'payload');
        self::assertTrue($cache->has($key));
        self::assertTrue($cache->delete($key));
        self::assertFalse($cache->has($key));
        self::assertNull($cache->get($key));
    }

    public function testClearRemovesAllEntries(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $cache->set('a', '1');
        $cache->set('b', '2');
        self::assertTrue($cache->clear());
        self::assertNull($cache->get('a'));
        self::assertNull($cache->get('b'));
    }

    public function testRejectsNonStringValue(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $this->expectException(\InvalidArgumentException::class);
        /** @phpstan-ignore-next-line — exercising the runtime guard */
        $cache->set('key', ['not-a-string']);
    }

    public function testGetMultipleRoundTrips(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $cache->setMultiple(['a' => '1', 'b' => '2']);
        $out = iterator_to_array(self::iter($cache->getMultiple(['a', 'b', 'missing'], 'fallback')));
        self::assertSame(['a' => '1', 'b' => '2', 'missing' => 'fallback'], $out);
    }

    public function testDeleteMultipleRemovesEntries(): void
    {
        $cache = new FilesystemCache($this->cacheDir);
        $cache->setMultiple(['a' => '1', 'b' => '2']);
        self::assertTrue($cache->deleteMultiple(['a', 'b']));
        self::assertFalse($cache->has('a'));
        self::assertFalse($cache->has('b'));
    }

    public function testFallsBackToMemoryWhenCacheDirIsUnwritable(): void
    {
        // Create a regular file in place of the cache directory so
        // `mkdir` and `tempnam` both fail.
        $unwritable = $this->cacheDir . \DIRECTORY_SEPARATOR . 'is-a-file';
        file_put_contents($unwritable, '');
        $deeper = $unwritable . \DIRECTORY_SEPARATOR . 'cannot-exist';

        $cache = new FilesystemCache($deeper);
        $cache->set('k', 'v');
        // Even though no file was created on disk, the in-memory mirror
        // still serves the last value (matches the Ruby / Python ports).
        self::assertSame('v', $cache->get('k'));
    }

    public function testInMemoryCacheRoundTrip(): void
    {
        $mem = new InMemoryCache();
        self::assertSame('fb', $mem->get('missing', 'fb'));
        self::assertTrue($mem->set('k', 'v'));
        self::assertSame('v', $mem->get('k'));
        self::assertTrue($mem->has('k'));
        self::assertTrue($mem->delete('k'));
        self::assertFalse($mem->has('k'));
    }

    public function testInMemoryCacheTtlExpires(): void
    {
        $mem = new InMemoryCache();
        // Negative TTL — already expired on the next read.
        $mem->set('k', 'v', -1);
        self::assertNull($mem->get('k'));
    }

    public function testInMemoryCacheTtlInterval(): void
    {
        $mem = new InMemoryCache();
        $mem->set('k', 'v', new \DateInterval('PT60S'));
        self::assertSame('v', $mem->get('k'));
    }

    public function testInMemoryCacheMultipleHelpers(): void
    {
        $mem = new InMemoryCache();
        self::assertTrue($mem->setMultiple(['a' => '1', 'b' => '2']));
        $out = iterator_to_array(self::iter($mem->getMultiple(['a', 'b'])));
        self::assertSame(['a' => '1', 'b' => '2'], $out);
        self::assertTrue($mem->deleteMultiple(['a', 'b']));
        self::assertFalse($mem->has('a'));
    }

    public function testInMemoryCacheClearWipesStore(): void
    {
        $mem = new InMemoryCache();
        $mem->set('k', 'v');
        self::assertTrue($mem->clear());
        self::assertFalse($mem->has('k'));
    }

    public function testInMemoryCacheRejectsNonStringKeyInMultiple(): void
    {
        $mem = new InMemoryCache();
        $this->expectException(\InvalidArgumentException::class);
        /** @phpstan-ignore-next-line — exercising the runtime guard */
        $mem->getMultiple([42]);
    }

    /**
     * @param iterable<string, mixed> $it
     *
     * @return \Generator<string, mixed>
     */
    private static function iter(iterable $it): \Generator
    {
        foreach ($it as $k => $v) {
            yield $k => $v;
        }
    }
}
