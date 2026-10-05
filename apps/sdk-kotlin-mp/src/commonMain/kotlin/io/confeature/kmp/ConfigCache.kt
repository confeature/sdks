// SPDX-License-Identifier: MIT
package io.confeature.kmp

/**
 * Cache abstraction for the latest `config_v6.json` body + ETag. The default implementation lives
 * in `io.confeature.kmp.internal.platform.FilesystemCache` (per-platform `actual`), with an
 * in-memory fallback for sandboxes that can't write to disk.
 *
 * <p>Mirrors ConfigCat's `ConfigCache` 1:1.
 *
 * <p>Keys passed to [read] / [write] are the derived 32-char base64url cache keys (NEVER the raw
 * SDK key). Methods are `suspend` to accommodate platforms whose native cache APIs are async
 * (e.g. JS / iOS) — JVM impls return synchronously inside the suspend boundary.
 */
public interface ConfigCache {
    /** Returns the cached payload for [cacheKey], or null when absent. */
    public suspend fun read(cacheKey: String): String?

    /**
     * Persists [value] under [cacheKey]. Implementations MUST NOT throw on filesystem failures —
     * the SDK degrades gracefully to in-memory mode (see `FilesystemCache` for the canonical
     * behaviour).
     */
    public suspend fun write(cacheKey: String, value: String)
}
