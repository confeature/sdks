// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import io.confeature.android.ConfigCache
import java.util.concurrent.ConcurrentHashMap

/**
 * Process-local [ConfigCache] implementation. Used as a fallback when the filesystem cache cannot
 * write (matches the Go / .NET / Java file-cache fallback behaviour) and as the explicit choice
 * when a customer passes `":memory:"` as the cache directory.
 *
 * Thread-safe; the cache is just a [ConcurrentHashMap] guarded by the standard happens-before of
 * `ConcurrentHashMap`.
 */
public class InMemoryCache : ConfigCache {
    private val store = ConcurrentHashMap<String, String>()

    override fun read(cacheKey: String): String? = store[cacheKey]

    override fun write(cacheKey: String, value: String) {
        store[cacheKey] = value
    }
}
