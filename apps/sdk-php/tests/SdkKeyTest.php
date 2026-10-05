<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\SdkKey;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Unit tests for SdkKey: format check, redaction, cache-key derivation.
 *
 * The cache-key derivation cross-language byte-identity is covered in
 * `CacheKeyFixturesTest`; this file pins behavioural edges (nil, short
 * key, valid format, invalid format).
 *
 * The accept/reject cases come from the shared list
 * `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`
 * (#802, FR-006b) — never a PHP-only list.
 */
final class SdkKeyTest extends TestCase
{
    public function testSdkKeyShapesFixtureCoversBothShapesAndRejections(): void
    {
        $shapes = WorkspaceRoot::sdkKeyShapes();
        // Fail closed: an empty list would make the data-provider tests
        // below vacuous.
        self::assertNotEmpty($shapes['valid']);
        self::assertNotEmpty($shapes['invalid']);
        $validKeys = array_column($shapes['valid'], 'key');
        self::assertNotEmpty(array_filter($validKeys, static fn (string $k): bool => str_starts_with($k, 'configcat-sdk-1/')));
        self::assertNotEmpty(array_filter($validKeys, static fn (string $k): bool => str_starts_with($k, 'confeature-sdk-1-')));
    }

    #[DataProvider('validShapes')]
    public function testIsValidConfeatureKeyFormatAcceptsSharedValidShape(string $key): void
    {
        self::assertTrue(SdkKey::isValidConfeatureKeyFormat($key));
    }

    #[DataProvider('invalidShapes')]
    public function testIsValidConfeatureKeyFormatRejectsSharedInvalidShape(string $key): void
    {
        self::assertFalse(SdkKey::isValidConfeatureKeyFormat($key));
    }

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function validShapes(): iterable
    {
        foreach (WorkspaceRoot::sdkKeyShapes()['valid'] as $entry) {
            yield $entry['name'] => [$entry['key']];
        }
    }

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function invalidShapes(): iterable
    {
        foreach (WorkspaceRoot::sdkKeyShapes()['invalid'] as $entry) {
            yield $entry['name'] => [$entry['key']];
        }
    }

    public function testIsValidConfeatureKeyFormatAcceptsBothSampleKeys(): void
    {
        self::assertTrue(SdkKey::isValidConfeatureKeyFormat(WorkspaceRoot::SAMPLE_SDK_KEY));
        self::assertTrue(SdkKey::isValidConfeatureKeyFormat(WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY));
    }

    public function testIsValidConfeatureKeyFormatRejectsTrailingNewline(): void
    {
        // `\z`, not `$`: PCRE's `$` would accept one trailing "\n".
        self::assertFalse(SdkKey::isValidConfeatureKeyFormat(WorkspaceRoot::SAMPLE_SDK_KEY . "\n"));
        self::assertFalse(SdkKey::isValidConfeatureKeyFormat(WorkspaceRoot::SAMPLE_CONFIGCAT_SHAPED_SDK_KEY . "\n"));
    }

    public function testRedactReturnsSentinelForNull(): void
    {
        self::assertSame('[redacted]', SdkKey::redact(null));
    }

    public function testRedactReturnsSentinelForEmpty(): void
    {
        self::assertSame('[redacted]', SdkKey::redact(''));
    }

    public function testRedactReturnsSentinelForShortKey(): void
    {
        self::assertSame('[redacted]', SdkKey::redact('abc'));
    }

    public function testRedactKeepsHeadAndTail(): void
    {
        $redacted = SdkKey::redact(WorkspaceRoot::SAMPLE_SDK_KEY);
        // The legacy sample key is 82 chars long; redact keeps
        // floor(82/10) = 8 chars at each end. That captures the
        // identifying prefix `confeatu` without leaking the actual
        // secret material.
        self::assertStringStartsWith('confeatu', $redacted);
        self::assertStringContainsString('[redacted]', $redacted);
        self::assertStringEndsWith('BBBBBBB', $redacted);
        self::assertStringNotContainsString('AAAAAAAAAAAA', $redacted);
    }

    public function testRedactConfigCatShapedKeyShowsNoMoreSecretThanLegacy(): void
    {
        // 61 chars -> floor(61/10) = 6 at each end: the head is `config`
        // (no secret), the tail is the last 6 secret characters — fewer
        // than the 8 a legacy key shows (#802, FR-005).
        $key = 'configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02';
        self::assertSame('config…[redacted]…tRea02', SdkKey::redact($key));

        [, $segA, $segB] = explode('/', $key);
        $redacted = SdkKey::redact($key);
        self::assertStringNotContainsString($segA, $redacted);
        self::assertStringNotContainsString($segB, $redacted);
        self::assertStringNotContainsString('/', $redacted);
    }

    public function testRedactNeverContainsTheFullSecretKey(): void
    {
        $secret = WorkspaceRoot::SAMPLE_SDK_KEY;
        $redacted = SdkKey::redact($secret);
        self::assertStringNotContainsString($secret, $redacted);
    }

    public function testDeriveCacheKeyHasEnvelopePrefix(): void
    {
        $derived = SdkKey::deriveCacheKey(WorkspaceRoot::SAMPLE_SDK_KEY);
        self::assertStringStartsWith('confeature:cache:v1:', $derived);
    }

    public function testDeriveCacheKeyIsDeterministic(): void
    {
        $first = SdkKey::deriveCacheKey('repeatable');
        $second = SdkKey::deriveCacheKey('repeatable');
        self::assertSame($first, $second);
    }

    public function testDeriveCacheKeyDiffersAcrossInputs(): void
    {
        self::assertNotSame(
            SdkKey::deriveCacheKey('one'),
            SdkKey::deriveCacheKey('two'),
        );
    }

    public function testDeriveCacheKeyBase64UrlSegmentIs32Chars(): void
    {
        $derived = SdkKey::deriveCacheKey(WorkspaceRoot::SAMPLE_SDK_KEY);
        $tail = substr($derived, \strlen(SdkKey::CACHE_KEY_PREFIX));
        self::assertSame(32, \strlen($tail));
        self::assertMatchesRegularExpression('/^[A-Za-z0-9_-]{32}$/', $tail);
    }
}
