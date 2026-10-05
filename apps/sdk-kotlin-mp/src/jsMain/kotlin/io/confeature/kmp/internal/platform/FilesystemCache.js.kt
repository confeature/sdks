// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.confeature.kmp.ConfigCache
import io.confeature.kmp.Logger
import io.confeature.kmp.internal.InMemoryCache
import io.confeature.kmp.internal.SdkKey

/**
 * JS filesystem-backed [ConfigCache]. Browser runtimes have no FS access, so this implementation
 * delegates to an in-memory map. Browsers that want disk-like persistence should use a custom
 * [ConfigCache] backed by `localStorage` or `IndexedDB` via the builder's `cache(...)` setter.
 *
 * <p>Node.js targets that need real disk persistence should likewise inject a `node:fs`-backed
 * [ConfigCache]; the SDK's default JS impl is process-local to keep the browser path simple.
 *
 * <p>Matches the JVM / iOS contract: never throws; degrades silently to memory-only.
 */
public actual class FilesystemCache actual constructor(
    @Suppress("UNUSED_PARAMETER") directory: String,
    @Suppress("UNUSED_PARAMETER") sdkKey: String,
    @Suppress("UNUSED_PARAMETER") logger: Logger,
) : ConfigCache {

    private val fallback = InMemoryCache()

    actual override suspend fun read(cacheKey: String): String? = fallback.read(cacheKey)

    actual override suspend fun write(cacheKey: String, value: String) {
        fallback.write(cacheKey, value)
    }

    public actual companion object {
        /** JS default — a memory-only sentinel; the directory is informational only. */
        public actual fun defaultCacheDir(): String = ":memory:"
    }
}

// Linker hint — keep [SdkKey] reachable from the JS source set so its
// public symbols don't get DCE-stripped in JS-IR mode when no JS consumer
// imports it directly. The bridge is wrapped in @JsName to give it a
// predictable JS identifier when consumed via UMD bundles.
@Suppress("unused")
@JsName("__confeatureKmpDeriveCacheKey")
public fun deriveCacheKeyBridge(sdkKey: String): String = SdkKey.deriveCacheKey(sdkKey)
