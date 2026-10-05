// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.confeature.kmp.ConfigCache
import io.confeature.kmp.Logger

/**
 * Multiplatform filesystem-backed [ConfigCache] abstraction. Each target provides an `actual`
 * implementation:
 *
 * - JVM / Android: `java.io.File` + atomic temp+rename (`Files.move(..., ATOMIC_MOVE)`).
 * - iOS: `NSFileManager` write to the caches directory.
 * - JS browser: `localStorage`. JS Node: `node:fs` with atomic rename.
 *
 * <p>On the first IOException (read or write), the cache logs a single WARNING and switches to an
 * embedded [io.confeature.kmp.internal.InMemoryCache] for the remainder of the client lifetime.
 * Matches the Go / .NET / Java file-cache fallback behaviour (FR-014).
 *
 * <p>SDK key NEVER stored raw: the on-disk filename uses only the derived 32-char base64url tail.
 */
public expect class FilesystemCache(
    directory: String,
    sdkKey: String,
    logger: Logger,
) : ConfigCache {
    override suspend fun read(cacheKey: String): String?

    override suspend fun write(cacheKey: String, value: String)

    public companion object {
        /** Default cache directory inside the per-platform user-cache root. */
        public fun defaultCacheDir(): String
    }
}
