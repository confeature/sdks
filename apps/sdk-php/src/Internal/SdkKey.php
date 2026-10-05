<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * SDK-key format helpers + cache-key derivation.
 *
 * SECURITY (Constitution security clause + spec 037 FR-008): SDK
 * keys are secrets. They MUST NEVER appear verbatim in any log
 * line. Every log site routes through `redact` first.
 *
 * The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`
 * (SHA-256 → base64url → first 32 chars). Cross-language fixture
 * verification lives in `tests/CacheKeyFixturesTest.php`.
 */
final class SdkKey
{
    /**
     * Confeature SDK key formats — both are valid (#802):
     *   `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` — minted
     *     today, ConfigCat's own shape, so a stock ConfigCat SDK accepts
     *     the key too;
     *   `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>` —
     *     minted before #802, still served until the key is rotated.
     *
     * Mirrors `CONFEATURE_SDK_KEY_PATTERN` in
     * `packages/sdk-shared/src/sdk-key.ts`. The accept/reject cases every
     * SDK tests against live in
     * `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
     */
    public const CONFEATURE_SDK_KEY_PATTERN =
        '/\A(?:configcat-sdk-1\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}'
        . '|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})\z/';

    /**
     * Envelope prefix for derived cache keys. Identical across every
     * Confeature SDK; mirrors the TS implementation's constant.
     */
    public const CACHE_KEY_PREFIX = 'confeature:cache:v1:';

    /**
     * Prevent instantiation — this is a static helper.
     */
    private function __construct()
    {
    }

    /**
     * Return true iff `$sdkKey` matches either Confeature SDK-key format
     * (see `CONFEATURE_SDK_KEY_PATTERN`).
     *
     * A `false` result does NOT cause the SDK to raise; it triggers
     * an `INVALID_SDK_KEY` log line (which, per the security clause,
     * includes only the redacted form).
     */
    public static function isValidConfeatureKeyFormat(string $sdkKey): bool
    {
        return preg_match(self::CONFEATURE_SDK_KEY_PATTERN, $sdkKey) === 1;
    }

    /**
     * Return a privacy-preserving rendering of `$sdkKey` for logs.
     *
     * Strategy: keep ~10% of the key visible at each end (minimum 4
     * chars), mask the middle. For short / unusual keys (< 16 chars)
     * fall back to a full mask. NEVER returns the raw key.
     *
     * Byte-oriented, so the `/` separators of a ConfigCat-shaped key are
     * ordinary characters: a `configcat-sdk-1/<22>/<22>` key (61 chars)
     * shows `config` + the last 6 secret characters, fewer than the 8 a
     * legacy 82-char key shows.
     *
     * Mirrors `redactSdkKey` from packages/sdk-shared/src/sdk-key.ts.
     */
    public static function redact(?string $sdkKey): string
    {
        if ($sdkKey === null || $sdkKey === '') {
            return '[redacted]';
        }
        $len = \strlen($sdkKey);
        if ($len < 16) {
            return '[redacted]';
        }
        $visible = max(4, (int) floor($len / 10));
        $head = substr($sdkKey, 0, $visible);
        $tail = substr($sdkKey, -$visible);

        return $head . '…[redacted]…' . $tail;
    }

    /**
     * Derive a stable, opaque cache key from an SDK key.
     *
     * Format: `confeature:cache:v1:<base64url(sha256(sdkKey))[0, 32]>`.
     *
     * Output is byte-identical to the TS workspace's async
     * `deriveCacheKey` (Web Crypto's `subtle.digest("SHA-256")`).
     * The cross-language fixture at
     * `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
     * pins ≥ 5 (sdkKey, expectedCacheKey) pairs and the PHPUnit test
     * asserts string equality for every entry.
     *
     * SECURITY: the SDK key is HASHED, never stored raw. Even an
     * attacker with filesystem access to the cache directory cannot
     * read the SDK key from a written cache file's name.
     */
    public static function deriveCacheKey(string $sdkKey): string
    {
        $hash = hash('sha256', $sdkKey, true);
        $b64 = rtrim(strtr(base64_encode($hash), '+/', '-_'), '=');

        return self::CACHE_KEY_PREFIX . substr($b64, 0, 32);
    }
}
