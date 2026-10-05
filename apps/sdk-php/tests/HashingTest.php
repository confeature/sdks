<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\Hashing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Cross-language hash parity (spec 121, T002). Pins the two synchronous
 * hashes the evaluator needs against KNOWN vectors that are byte-identical
 * across the federation (TS `packages/sdk-shared/src/hash.ts`, plus the
 * Python / Go / Ruby ports):
 *
 *   - SHA-1, UNSALTED for percentage bucketing
 *     (`hexdec(substr(sha1(key.attr), 0, 7)) % 100`).
 *   - SHA-256, SALTED for sensitive comparators
 *     (`sha256(value . configSalt . contextSalt)`).
 *
 * PHP's stdlib `hash()` is the well-known FIPS digest, so these are the
 * canonical published SHA-1/SHA-256 vectors; the percentage-bucket vectors
 * are the exact slice + modulo the TS reference's `percentageBucket`
 * produces (verified equal byte-for-byte across the federation).
 */
final class HashingTest extends TestCase
{
    /**
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function sha1Vectors(): iterable
    {
        // Canonical FIPS-180 SHA-1 vectors (lowercase hex).
        yield 'empty' => ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'];
        yield 'abc' => ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'];
        yield 'Hello' => ['Hello', 'f7ff9e8b7bb2e09b70935a5d785e0cc5d9d0abf0'];
        yield '12345' => ['12345', '8cb2237d0679ca88db6464eac60da96345513964'];
    }

    #[DataProvider('sha1Vectors')]
    public function testSha1HexMatchesKnownVectors(string $input, string $expected): void
    {
        self::assertSame($expected, Hashing::sha1Hex($input));
    }

    /**
     * @return iterable<string, array{0: string, 1: string}>
     */
    public static function sha256Vectors(): iterable
    {
        yield 'empty' => ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'];
        yield 'abc' => ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'];
        yield 'Hello' => ['Hello', '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969'];
        yield '12345' => ['12345', '5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5'];
    }

    #[DataProvider('sha256Vectors')]
    public function testSha256HexMatchesKnownVectors(string $input, string $expected): void
    {
        self::assertSame($expected, Hashing::sha256Hex($input));
    }

    /**
     * The SALTED sensitive hash is `sha256(value . configSalt . contextSalt)`
     * with NO separators — exactly the concatenation `hash.ts` does. Pinned
     * against the SHA-256 of the concatenated bytes.
     *
     * @return iterable<string, array{0: string, 1: string, 2: string, 3: string}>
     */
    public static function comparisonValueVectors(): iterable
    {
        // sha256("foo" . "mysalt" . "key1")
        yield 'foo/mysalt/key1' => [
            'foo',
            'mysalt',
            'key1',
            '8aa4eeb306eb5d0646137a125e30b5a125e429c09e4dcd56e5d174c34d1a71fc',
        ];
        // empty salts collapse to sha256("12345").
        yield 'no-salts' => [
            '12345',
            '',
            '',
            '5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5',
        ];
    }

    #[DataProvider('comparisonValueVectors')]
    public function testHashComparisonValueIsSaltedSha256(
        string $value,
        string $configSalt,
        string $contextSalt,
        string $expected,
    ): void {
        self::assertSame(
            $expected,
            Hashing::hashComparisonValue($value, $configSalt, $contextSalt),
        );
        // The slice variant uses the identical concatenation; a full-string
        // slice must equal the value hash.
        self::assertSame(
            $expected,
            Hashing::hashComparisonValueSlice($value, $configSalt, $contextSalt),
        );
    }

    /**
     * The percentage bucket is the SHA-1-UNSALTED slice mod 100 of
     * `key . attrValue` — keyed by the setting/rule discriminator, NEVER
     * salted (FR-005). These are the buckets `hash.ts::percentageBucket`
     * produces for the same inputs.
     *
     * @return iterable<string, array{0: string, 1: string, 2: int}>
     */
    public static function bucketVectors(): iterable
    {
        // hexdec(substr(sha1("" . "12345"), 0, 7)) % 100 == 95
        yield 'empty-key/12345' => ['', '12345', 95];
        // hexdec(substr(sha1("mainKey" . "jane@example.com"), 0, 7)) % 100 == 79
        yield 'mainKey/jane' => ['mainKey', 'jane@example.com', 79];
        // hexdec(substr(sha1("k" . "a"), 0, 7)) % 100 == 35
        yield 'k/a' => ['k', 'a', 35];
    }

    #[DataProvider('bucketVectors')]
    public function testPercentageBucketMatchesUnsaltedSha1Slice(
        string $key,
        string $attr,
        int $expected,
    ): void {
        $bucket = Hashing::percentageBucket($key, $attr);
        self::assertSame($expected, $bucket);
        self::assertGreaterThanOrEqual(0, $bucket);
        self::assertLessThan(100, $bucket);
    }

    public function testPercentageBucketIsDeterministic(): void
    {
        $first = Hashing::percentageBucket('feature', 'identifier-42');
        for ($i = 0; $i < 25; ++$i) {
            self::assertSame($first, Hashing::percentageBucket('feature', 'identifier-42'));
        }
    }

    public function testPercentageBucketMatchesExplicitFormula(): void
    {
        // Independently recompute the documented formula to guard against a
        // refactor silently changing the slice width or modulus.
        $key = 'someKey';
        $attr = 'someValue';
        $expected = (int) (hexdec(substr(hash('sha1', $key . $attr), 0, 7)) % 100);
        self::assertSame($expected, Hashing::percentageBucket($key, $attr));
    }
}
