// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.regex.Pattern

/**
 * SDK-key format helpers + cache-key derivation.
 *
 * SECURITY (constitution security clause + spec 047 FR-013): SDK keys are secrets. They MUST NEVER
 * appear verbatim in any log line. Every log site that references the key MUST route through
 * [redact].
 *
 * The cache-key algorithm mirrors `packages/sdk-shared/src/sdk-key.ts`'s async `deriveCacheKey`
 * (SHA-256 → base64url → first 32 chars → prefix) plus the Python / Go / .NET / Rust / Ruby / Java
 * ports. Cross-language fixture verification lives in `CacheKeyFixturesTest`.
 *
 * Implementation note: the Android SDK uses [java.util.Base64] (available since API 26) for the
 * URL-safe / no-padding encoding. For pre-API 26 callers, this maps to the conscrypt-backed JCE on
 * the system path. The pure-JVM path keeps the algorithm testable from Robolectric without an
 * emulator.
 */
public object SdkKey {
    /** Envelope prefix for derived cache keys — identical across every SDK. */
    public const val CACHE_KEY_PREFIX: String = "confeature:cache:v1:"

    /**
     * Both Confeature SDK-key shapes (#802), mirroring `packages/sdk-shared/src/sdk-key.ts`:
     * - `configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>` — minted today; ConfigCat's own
     *   shape, so a stock ConfigCat SDK accepts the key too.
     * - `confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>` — minted before #802, still valid
     *   until the key is rotated.
     */
    private val CONFEATURE_SDK_KEY_PATTERN: Pattern =
        Pattern.compile(
            "^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}" +
                "|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$",
        )

    /**
     * Returns true iff [sdkKey] matches either Confeature SDK-key shape — the ConfigCat-shaped
     * `configcat-sdk-1/<22>/<22>` minted today, or the legacy `confeature-sdk-1-<32>-<32>` (still
     * accepted). The accept/reject cases every SDK tests against live in
     * `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`. A `false` result does NOT
     * cause the SDK to throw; it triggers an `INVALID_SDK_KEY` log line (which, per the security
     * clause, includes only the redacted form).
     */
    @JvmStatic
    public fun isValidConfeatureKeyFormat(sdkKey: String?): Boolean {
        if (sdkKey == null) return false
        return CONFEATURE_SDK_KEY_PATTERN.matcher(sdkKey).matches()
    }

    /**
     * Returns a privacy-preserving rendering of [sdkKey] for log output. NEVER returns the raw key.
     *
     * Strategy: keep ~10% of the key visible at each end (minimum 4 chars), mask the middle. For
     * short / unusual keys (< 16 chars) and the empty string / null, fall back to a full mask.
     * Mirrors the TS / Python / Go / .NET / Java ports byte-for-byte.
     *
     * The key is treated as opaque text: a `/` in a ConfigCat-shaped key is just another
     * character. For that 61-char shape the head is `"config"` (no secret characters) and the tail
     * shows 6 secret characters — fewer than the 8 a legacy 82-char key shows.
     */
    @JvmStatic
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
     * Format: `confeature:cache:v1:<base64url(sha256(sdkKey))[:32]>`.
     *
     * Output is byte-identical to the TS / Python / Go / .NET / Rust / Ruby / Java ports.
     *
     * SECURITY: the SDK key is HASHED, never stored raw. Even an attacker with filesystem access
     * to the cache directory cannot read the SDK key from a written cache file's name.
     *
     * @throws NullPointerException when [sdkKey] is null (Kotlin's platform-type guard fires before
     *     the method body when crossed from Java with a null argument).
     */
    @JvmStatic
    public fun deriveCacheKey(sdkKey: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val hash = md.digest(sdkKey.toByteArray(StandardCharsets.UTF_8))
        // java.util.Base64 produces URL-safe / no-padding output identical to
        // android.util.Base64(URL_SAFE | NO_PADDING | NO_WRAP). Preferred for
        // pure-JVM testability under Robolectric (no Android shim needed).
        val b64 = Base64.getUrlEncoder().withoutPadding().encodeToString(hash)
        return CACHE_KEY_PREFIX + b64.substring(0, 32)
    }

    /**
     * Returns the 32-char base64url tail of a cache key (the part after the envelope prefix). A
     * local cache id only — used in the on-disk filename so the cache never serialises the raw key;
     * it never goes on the wire (#803: the request path carries the key itself, as ConfigCat's).
     */
    @JvmStatic
    public fun cacheKeyTail(cacheKey: String): String {
        val idx = cacheKey.lastIndexOf(':')
        if (idx < 0 || idx == cacheKey.length - 1) return cacheKey
        return cacheKey.substring(idx + 1)
    }
}
