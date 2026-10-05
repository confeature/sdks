// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.ConfigCache
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Process-local [ConfigCache] implementation. Used as a fallback when the filesystem cache cannot
 * write (matches the Go / .NET / Java file-cache fallback behaviour) and as the explicit choice
 * when a customer passes `":memory:"` as the cache directory.
 *
 * <p>Pure Kotlin / multiplatform — relies only on `kotlinx-coroutines-core` for the suspending
 * mutex.
 */
public class InMemoryCache : ConfigCache {
    private val mutex = Mutex()
    private val store: MutableMap<String, String> = mutableMapOf()

    override suspend fun read(cacheKey: String): String? = mutex.withLock { store[cacheKey] }

    override suspend fun write(cacheKey: String, value: String) {
        mutex.withLock { store[cacheKey] = value }
    }
}
