// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.internal.platform.Sha256Provider
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * SDK-key format helpers + cache-key derivation.
 *
 * <p><b>SECURITY</b> (constitution security clause + spec 048 FR-013): SDK keys are secrets. They
 * MUST NEVER appear verbatim in any log line. Every log site that references the key MUST route
 * through [redact].
 *
 * <p>The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`'s async `deriveCacheKey`
 * (SHA-256 → base64url → first 32 chars) plus the Python / Go / .NET / Rust / Ruby / PHP / Java /
 * Swift / Android ports. Cross-language fixture verification lives in `CacheKeyFixturesTest`.
 */
@OptIn(ExperimentalEncodingApi::class)
public object SdkKey {
    /** Envelope prefix for derived cache keys — identical across every SDK. */
    public const val CACHE_KEY_PREFIX: String = "confeature:cache:v1:"

    /**
     * Both Confeature SDK-key shapes (#802), mirroring `packages/sdk-shared/src/sdk-key.ts`:
     *
     * - `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` — minted today; ConfigCat's own
     *   shape, so a stock ConfigCat SDK accepts the key too.
     * - `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>` — minted before #802, still
     *   valid until the key is rotated.
     */
    private val CONFEATURE_SDK_KEY_PATTERN: Regex =
        Regex(
            "^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}" +
                "|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$",
        )

    /**
     * Returns true iff [sdkKey] matches either Confeature SDK-key shape — the ConfigCat-shaped
     * `configcat-sdk-1/<22>/<22>` minted today, or the legacy `confeature-sdk-1-<32>-<32>` (still
     * accepted). The accept/reject cases every SDK tests against live in
     * `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`. A false result does NOT
     * cause the SDK to throw; it triggers an `INVALID_SDK_KEY` log line (which, per the security
     * clause, includes only the redacted form).
     */
    public fun isValidConfeatureKeyFormat(sdkKey: String?): Boolean {
        if (sdkKey == null) return false
        return CONFEATURE_SDK_KEY_PATTERN.matches(sdkKey)
    }

    /**
     * Returns a privacy-preserving rendering of [sdkKey] for log output. NEVER returns the raw key.
     *
     * <p>Strategy: keep ~10% of the key visible at each end (minimum 4 chars), mask the middle.
     * For short / unusual keys (< 16 chars) and the empty string / null, fall back to a full mask.
     * Mirrors the TS / Python / Go / .NET / Java ports byte-for-byte.
     *
     * <p>The key is treated as opaque text: a `/` in a ConfigCat-shaped key is just another
     * character. For that 61-char shape the head is `"config"` (no secret characters) and the tail
     * shows 6 secret characters — fewer than the 8 a legacy 82-char key shows.
     */
    public fun redact(sdkKey: String?): String {
        if (sdkKey == null || sdkKey.length < 16) return "[redacted]"
        val visible = maxOf(4, sdkKey.length / 10)
        val head = sdkKey.substring(0, visible)
        val tail = sdkKey.substring(sdkKey.length - visible)
        return "$head…[redacted]…$tail"
    }

    /**
     * Derives a stable, opaque cache key from [sdkKey].
     *
     * <p>Format: `confeature:cache:v1:<base64url(sha256(sdkKey))[:32]>`.
     *
     * <p>Output is byte-identical to:
     *
     * - `packages/sdk-shared/src/sdk-key.ts::deriveCacheKey` (TS canonical).
     * - `apps/sdk-python/.../sdk_key.py::derive_cache_key`.
     * - `apps/sdk-go/internal/sdkkey/sdkkey.go::DeriveCacheKey`.
     * - `apps/sdk-dotnet/.../SdkKey.cs::DeriveCacheKey`.
     * - `apps/sdk-java/.../SdkKey.java::deriveCacheKey`.
     *
     * <p>The key is hashed as its plain UTF-8 bytes — the `/` of a ConfigCat-shaped key is never
     * escaped or stripped first (pinned by the `configcat-sdk-1/...` row of
     * `cache-key-fixtures.json`).
     *
     * <p><b>SECURITY:</b> the SDK key is HASHED, never stored raw. Even an attacker with
     * filesystem access to the cache directory cannot read the SDK key from a written cache file's
     * name.
     */
    public fun deriveCacheKey(sdkKey: String): String {
        val hash = Sha256Provider.digest(sdkKey.encodeToByteArray())
        val b64 = Base64.UrlSafe.encode(hash).trimEnd('=')
        return CACHE_KEY_PREFIX + b64.substring(0, 32)
    }

    /**
     * Returns the 32-char base64url tail of a cache key (the part after the envelope prefix). A
     * LOCAL cache id only — it names the on-disk cache file so the raw key is never written to the
     * filesystem. It is never sent on the wire: the config URL carries the key itself, as
     * ConfigCat's SDKs send it (#803, see `configFileUrl`).
     */
    public fun cacheKeyTail(cacheKey: String): String {
        val idx = cacheKey.lastIndexOf(':')
        if (idx < 0 || idx == cacheKey.length - 1) return cacheKey
        return cacheKey.substring(idx + 1)
    }
}
