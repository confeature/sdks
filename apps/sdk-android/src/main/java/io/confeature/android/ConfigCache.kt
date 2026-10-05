// SPDX-License-Identifier: MIT
package io.confeature.android

/**
 * Cache abstraction for the latest `config_v6.json` body + ETag. The default implementation lives
 * in [io.confeature.android.internal.FilesystemCache], with an in-memory fallback for sandboxes
 * that can't write to disk.
 *
 * Mirrors ConfigCat's `com.configcat.ConfigCache` 1:1.
 *
 * Keys passed to [read] / [write] are the derived 32-char base64url cache keys (NEVER the raw SDK
 * key).
 */
public interface ConfigCache {
    /** Returns the cached payload for [cacheKey], or null when absent. */
    public fun read(cacheKey: String): String?

    /**
     * Persists [value] under [cacheKey]. Implementations MUST NOT throw on filesystem failures —
     * the SDK degrades gracefully to in-memory mode (see [io.confeature.android.internal.FilesystemCache]
     * for the canonical behaviour).
     */
    public fun write(cacheKey: String, value: String)
}
