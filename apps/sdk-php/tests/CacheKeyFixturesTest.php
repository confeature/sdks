<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\SdkKey;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Verifies SHA-256 cache-key derivation is byte-identical across
 * every SDK language family (Constitution Principle II).
 *
 * Loads `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
 * (≥ 5 (sdkKey, expectedCacheKey) tuples — no exact count is pinned, so
 * rows added by the export script are picked up) and asserts string
 * equality for every entry. Keys are hashed as opaque bytes: the `/` of a
 * ConfigCat-shaped key (`configcat-sdk-1/<22>/<22>`, #802) is not special.
 */
final class CacheKeyFixturesTest extends TestCase
{
    public function testFixtureFileHasAtLeastFiveEntries(): void
    {
        $fixtures = WorkspaceRoot::cacheKeyFixtures();
        self::assertGreaterThanOrEqual(5, \count($fixtures));
    }

    public function testFixtureFileHasAConfigCatShapedKeyRow(): void
    {
        $shaped = array_filter(
            WorkspaceRoot::cacheKeyFixtures(),
            static fn (array $entry): bool => str_starts_with($entry['sdkKey'], 'configcat-sdk-1/'),
        );
        self::assertNotEmpty($shaped, 'cache-key-fixtures.json lost its ConfigCat-shaped (#802) row');
    }

    #[DataProvider('fixtures')]
    public function testCacheKeyIsByteIdentical(string $sdkKey, string $expected): void
    {
        self::assertSame($expected, SdkKey::deriveCacheKey($sdkKey));
    }

    /**
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function fixtures(): iterable
    {
        foreach (WorkspaceRoot::cacheKeyFixtures() as $i => $entry) {
            yield "fixture #{$i}: " . self::label($entry['sdkKey']) => [
                $entry['sdkKey'],
                $entry['expectedCacheKey'],
            ];
        }
    }

    private static function label(string $key): string
    {
        if ($key === '') {
            return '<empty>';
        }
        $printable = (string) preg_replace('/[^\x20-\x7E]/', '?', $key);

        return mb_substr($printable, 0, 40);
    }
}
