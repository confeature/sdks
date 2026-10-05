<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * ConfigCat-semantics semver parse + compare. Ported field-for-field from
 * the spec-117 TS reference (`packages/sdk-shared/src/semver.ts`),
 * cross-checked against the spec-118/119/120 Python / Go / Ruby ports,
 * which themselves vendor ConfigCat `common-js` `Semver.ts`.
 *
 * A Composer semver package (e.g. `composer/semver`) is NOT used —
 * ConfigCat's strict-parse + precedence edge cases diverge from those
 * packages and would fail the vendored `testmatrix_semantic*` precedence
 * rows.
 *
 * Key behaviours:
 *   - **Strict (non-loose) parse** of the FULL grammar
 *     `v?MAJOR.MINOR.PATCH(-prerelease)?(+build)?`, each core component a
 *     `0|[1-9]\d*` numeric identifier; an optional leading `v` is allowed.
 *   - **Parse on trim.** Callers parse `trim($value)`; {@link parse} also
 *     trims defensively.
 *   - **Unparseable → null**, never an exception. The caller treats null as
 *     a validation error (the rule errors and does not match — FR-010), NOT
 *     a silent false.
 *   - **Precedence**: numeric major.minor.patch first; then pre-release. A
 *     version WITHOUT a pre-release ranks HIGHER than one WITH a pre-release.
 *     Pre-release identifiers compared field-by-field — numeric vs numeric
 *     numerically; a numeric identifier < an alphanumeric identifier;
 *     alphanumeric compared ASCII-lexically; when all preceding fields are
 *     equal, MORE fields rank higher than fewer.
 *   - **Build metadata is ignored** for precedence (SemVer §10).
 */
final class Semver
{
    private const NUMERIC_IDENTIFIER = '0|[1-9]\d*';
    private const NON_NUMERIC_IDENTIFIER = '\d*[a-zA-Z-][a-zA-Z0-9-]*';

    private const MAX_LENGTH = 256;
    // Mirrors JS Number.MAX_SAFE_INTEGER (the TS reference's bound).
    private const MAX_SAFE_INTEGER = 9007199254740991;

    public readonly string $version;
    public readonly int $major;
    public readonly int $minor;
    public readonly int $patch;
    /** @var list<int|string> Numberified pre-release identifiers. */
    public readonly array $prerelease;
    /** @var list<string> Build-metadata identifiers (ignored for precedence). */
    public readonly array $build;

    /**
     * @param list<int|string> $prerelease
     * @param list<string>     $build
     */
    private function __construct(
        string $version,
        int $major,
        int $minor,
        int $patch,
        array $prerelease,
        array $build,
    ) {
        $this->version = $version;
        $this->major = $major;
        $this->minor = $minor;
        $this->patch = $patch;
        $this->prerelease = $prerelease;
        $this->build = $build;
    }

    /**
     * Parse a version string under ConfigCat's strict grammar. Returns null
     * on any failure (length, grammar, out-of-range core component) — never
     * throws. Trims the input first (parse on trim). The caller surfaces null
     * as a validation error (FR-010), never a silent match.
     */
    public static function parse(string $version): ?self
    {
        $trimmed = trim($version);
        if (\strlen($trimmed) > self::MAX_LENGTH) {
            return null;
        }

        $num = self::NUMERIC_IDENTIFIER;
        $main = '(' . $num . ')\.(' . $num . ')\.(' . $num . ')';
        $prereleaseId = '(?:' . $num . '|' . self::NON_NUMERIC_IDENTIFIER . ')';
        $prerelease = '(?:-(' . $prereleaseId . '(?:\.' . $prereleaseId . ')*))';
        $buildId = '[0-9A-Za-z-]+';
        $build = '(?:\+(' . $buildId . '(?:\.' . $buildId . ')*))';
        $full = '/^v?' . $main . $prerelease . '?' . $build . '?$/';

        if (preg_match($full, $trimmed, $m) !== 1) {
            return null;
        }

        $major = (int) $m[1];
        $minor = (int) $m[2];
        $patch = (int) $m[3];
        if (
            $major < 0 || $major > self::MAX_SAFE_INTEGER
            || $minor < 0 || $minor > self::MAX_SAFE_INTEGER
            || $patch < 0 || $patch > self::MAX_SAFE_INTEGER
        ) {
            return null;
        }

        $prereleaseParts = self::parsePrerelease($m[4] ?? '');
        $buildParts = ($m[5] ?? '') !== '' ? explode('.', $m[5]) : [];

        $canonical = $major . '.' . $minor . '.' . $patch;
        if ($prereleaseParts !== []) {
            $canonical .= '-' . implode('.', array_map('strval', $prereleaseParts));
        }

        return new self($canonical, $major, $minor, $patch, $prereleaseParts, $buildParts);
    }

    /**
     * Compare against `$other`: <0 lower, 0 equal, >0 higher. Build metadata
     * is ignored. Mirrors `semver.ts::SemVer.compare` →
     * `compareMain || comparePre`.
     */
    public function compare(self $other): int
    {
        if ($other->version === $this->version) {
            return 0;
        }
        $main = $this->compareMain($other);

        return $main !== 0 ? $main : $this->comparePre($other);
    }

    private function compareMain(self $other): int
    {
        $c = self::compareIdentifiers($this->major, $other->major);
        if ($c !== 0) {
            return $c;
        }
        $c = self::compareIdentifiers($this->minor, $other->minor);
        if ($c !== 0) {
            return $c;
        }

        return self::compareIdentifiers($this->patch, $other->patch);
    }

    private function comparePre(self $other): int
    {
        // A version WITHOUT a pre-release is higher-precedence than one WITH.
        if ($this->prerelease !== [] && $other->prerelease === []) {
            return -1;
        }
        if ($this->prerelease === [] && $other->prerelease !== []) {
            return 1;
        }
        if ($this->prerelease === [] && $other->prerelease === []) {
            return 0;
        }

        $i = 0;
        while (true) {
            $a = $this->prerelease[$i] ?? null;
            $b = $other->prerelease[$i] ?? null;
            if ($a === null && $b === null) {
                return 0;
            }
            if ($b === null) {
                return 1;
            }
            if ($a === null) {
                return -1;
            }
            if ($a === $b) {
                ++$i;
                continue;
            }

            return self::compareIdentifiers($a, $b);
        }
    }

    /**
     * Compare two pre-release / core identifiers (common-js
     * `compareIdentifiers`): both numeric → numeric compare; a numeric
     * identifier is lower-precedence than an alphanumeric one; otherwise
     * ASCII-lexical.
     */
    private static function compareIdentifiers(int|string $a, int|string $b): int
    {
        $anum = preg_match('/^[0-9]+$/', (string) $a) === 1;
        $bnum = preg_match('/^[0-9]+$/', (string) $b) === 1;
        $av = $a;
        $bv = $b;
        if ($anum && $bnum) {
            $av = (int) $a;
            $bv = (int) $b;
        }
        if ($av === $bv) {
            return 0;
        }
        if ($anum && !$bnum) {
            return -1;
        }
        if ($bnum && !$anum) {
            return 1;
        }

        return $av < $bv ? -1 : 1;
    }

    /**
     * Numberify numeric pre-release ids (matching common-js).
     *
     * @return list<int|string>
     */
    private static function parsePrerelease(string $raw): array
    {
        if ($raw === '') {
            return [];
        }

        $out = [];
        foreach (explode('.', $raw) as $ident) {
            if (preg_match('/^[0-9]+$/', $ident) === 1) {
                $numVal = (int) $ident;
                if ($numVal >= 0 && $numVal < self::MAX_SAFE_INTEGER) {
                    $out[] = $numVal;
                    continue;
                }
            }
            $out[] = $ident;
        }

        return $out;
    }
}
