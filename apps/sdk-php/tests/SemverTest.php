<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Tests;

use Confeature\Internal\Semver;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * ConfigCat semver parse + precedence parity (spec 121, T003). Ported
 * field-by-field from `packages/sdk-shared/src/semver.ts` (which itself
 * vendors common-js `Semver.ts`); cross-checked against the Python / Go /
 * Ruby ports. Covers strict parse (incl. the optional leading `v`, parse on
 * trim, unparseable → null) and the SemVer §11 precedence rules
 * (build metadata ignored, no-prerelease > prerelease, numeric < alphanumeric
 * prerelease identifiers, more fields > fewer).
 */
final class SemverTest extends TestCase
{
    /**
     * @return iterable<string, array{0: string}>
     */
    public static function parseable(): iterable
    {
        yield 'basic' => ['1.2.3'];
        yield 'leading-v' => ['v1.2.3'];
        yield 'zeroes' => ['0.0.0'];
        yield 'prerelease' => ['1.0.0-alpha'];
        yield 'prerelease-dotted' => ['1.0.0-alpha.1'];
        yield 'prerelease-numeric' => ['1.0.0-0.3.7'];
        yield 'build-metadata' => ['1.0.0+build.1'];
        yield 'prerelease-and-build' => ['1.0.0-beta+exp.sha.5114f85'];
        yield 'trims-whitespace' => ['  1.2.3  '];
    }

    #[DataProvider('parseable')]
    public function testParseAcceptsValidVersions(string $version): void
    {
        self::assertInstanceOf(Semver::class, Semver::parse($version));
    }

    /**
     * @return iterable<string, array{0: string}>
     */
    public static function unparseable(): iterable
    {
        yield 'empty' => [''];
        yield 'partial' => ['1.2'];
        yield 'trailing-dot' => ['1.2.3.'];
        yield 'leading-zero-major' => ['01.2.3'];
        yield 'non-numeric-core' => ['1.x.3'];
        yield 'garbage' => ['not-a-version'];
        yield 'spaces-inside' => ['1.2. 3'];
    }

    #[DataProvider('unparseable')]
    public function testParseReturnsNullForInvalidVersions(string $version): void
    {
        self::assertNull(Semver::parse($version));
    }

    public function testParseNeverThrows(): void
    {
        // Defensive: a long unparseable string returns null, not an exception.
        self::assertNull(Semver::parse(str_repeat('9', 1024)));
    }

    /**
     * `$a` precedence vs `$b`: -1 lower, 0 equal, 1 higher. Mirrors
     * `semver.ts::SemVer.compare` (normalized to the sign).
     *
     * @return iterable<string, array{0: string, 1: string, 2: int}>
     */
    public static function precedence(): iterable
    {
        yield 'equal' => ['1.2.3', '1.2.3', 0];
        yield 'major' => ['1.0.0', '2.0.0', -1];
        yield 'minor' => ['1.1.0', '1.2.0', -1];
        yield 'patch' => ['1.2.3', '1.2.4', -1];
        yield 'leading-v-equal' => ['v1.2.3', '1.2.3', 0];
        // Build metadata is ignored for precedence (§10).
        yield 'build-ignored' => ['1.0.0+a', '1.0.0+b', 0];
        // A version WITHOUT prerelease ranks higher than one WITH (§11).
        yield 'release-gt-prerelease' => ['1.0.0', '1.0.0-alpha', 1];
        yield 'prerelease-lt-release' => ['1.0.0-alpha', '1.0.0', -1];
        // Prerelease identifiers compared field-by-field.
        yield 'numeric-prerelease' => ['1.0.0-alpha.1', '1.0.0-alpha.2', -1];
        // Numeric identifier ranks lower than an alphanumeric one.
        yield 'numeric-lt-alpha' => ['1.0.0-1', '1.0.0-alpha', -1];
        // More fields rank higher when all preceding fields are equal.
        yield 'more-fields-higher' => ['1.0.0-alpha', '1.0.0-alpha.1', -1];
        // The canonical §11 chain.
        yield 'alpha-lt-alpha-beta' => ['1.0.0-alpha', '1.0.0-alpha.beta', -1];
        yield 'alpha-beta-lt-beta' => ['1.0.0-alpha.beta', '1.0.0-beta', -1];
        yield 'beta-lt-beta-2' => ['1.0.0-beta', '1.0.0-beta.2', -1];
        yield 'beta-2-lt-beta-11' => ['1.0.0-beta.2', '1.0.0-beta.11', -1];
        yield 'beta-11-lt-rc-1' => ['1.0.0-beta.11', '1.0.0-rc.1', -1];
        yield 'rc-1-lt-release' => ['1.0.0-rc.1', '1.0.0', -1];
    }

    #[DataProvider('precedence')]
    public function testCompareFollowsSemverPrecedence(string $a, string $b, int $sign): void
    {
        $va = Semver::parse($a);
        $vb = Semver::parse($b);
        self::assertNotNull($va, "could not parse {$a}");
        self::assertNotNull($vb, "could not parse {$b}");

        self::assertSame($sign, self::sign($va->compare($vb)), "{$a} vs {$b}");
        // The relation must be antisymmetric.
        self::assertSame(-$sign, self::sign($vb->compare($va)), "{$b} vs {$a}");
    }

    private static function sign(int $n): int
    {
        return $n <=> 0;
    }
}
