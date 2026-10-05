// SPDX-License-Identifier: MIT
@file:OptIn(ExperimentalForeignApi::class)

package io.confeature.kmp.internal.platform

import io.confeature.kmp.ConfigCache
import io.confeature.kmp.Logger
import io.confeature.kmp.internal.InMemoryCache
import io.confeature.kmp.internal.SdkKey
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSCachesDirectory
import platform.Foundation.NSError
import platform.Foundation.NSFileManager
import platform.Foundation.NSString
import platform.Foundation.NSURL
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.NSUserDomainMask
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeToURL
import platform.posix.memcpy

/**
 * iOS filesystem-backed [ConfigCache]. Writes to `{cachesDir}/confeature/confeature-{tail}.json`
 * via `NSFileManager` + `NSString.writeToFile(atomically: true)` which atomically renames the
 * tempfile over the target.
 *
 * <p>On the first error, the cache logs a single WARNING via [Logger] and switches to an embedded
 * [InMemoryCache] for the remainder of the client lifetime. Matches the JVM / Go / .NET / Java
 * fallback behaviour.
 */
public actual class FilesystemCache actual constructor(
    private val directory: String,
    private val sdkKey: String,
    private val logger: Logger,
) : ConfigCache {

    private val fallback = InMemoryCache()
    // Kotlin/Native's `@kotlin.native.concurrent.ThreadLocal` is too
    // restrictive; a plain Boolean read on K/N (new memory model since
    // 1.7.20) is safe across coroutines on the same dispatcher. The
    // worst-case race (concurrent first-failure) results in the fallback
    // logging being silently suppressed — acceptable for a best-effort
    // observability signal that already prints to the customer logger.
    private var memoryOnly: Boolean = false

    private fun resolveFilePath(cacheKey: String): String {
        val tail = SdkKey.cacheKeyTail(cacheKey)
        return "$directory/confeature-$tail.json"
    }

    @OptIn(kotlinx.cinterop.BetaInteropApi::class)
    actual override suspend fun read(cacheKey: String): String? {
        if (memoryOnly) return fallback.read(cacheKey)
        val path = resolveFilePath(cacheKey)
        val fm = NSFileManager.defaultManager
        if (!fm.fileExistsAtPath(path)) return fallback.read(cacheKey)
        return try {
            NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null) as String?
        } catch (ex: Exception) {
            engageFallback(path, ex)
            fallback.read(cacheKey)
        }
    }

    @OptIn(kotlinx.cinterop.BetaInteropApi::class)
    actual override suspend fun write(cacheKey: String, value: String) {
        fallback.write(cacheKey, value)
        if (memoryOnly) return

        val path = resolveFilePath(cacheKey)
        val fm = NSFileManager.defaultManager
        // Ensure the parent directory exists.
        val parent = directory
        try {
            if (!fm.fileExistsAtPath(parent)) {
                @Suppress("UNCHECKED_CAST")
                val ok = fm.createDirectoryAtPath(
                    parent,
                    withIntermediateDirectories = true,
                    attributes = null,
                    error = null,
                )
                if (!ok) {
                    engageFallback(path, IllegalStateException("mkdir failed at $parent"))
                    return
                }
            }
        } catch (ex: Exception) {
            engageFallback(path, ex)
            return
        }

        // NSString.writeToFile(atomically: true) renames a tempfile over the
        // target — the canonical atomic-write idiom on Apple platforms.
        try {
            val ns = NSString.create(string = value)
            val url = NSURL.fileURLWithPath(path)
            // We intentionally don't propagate the NSError pointer; the SDK
            // contract is "never throw on cache failures" — log + memoryFallback.
            val ok = ns.writeToURL(
                url,
                atomically = true,
                encoding = NSUTF8StringEncoding,
                error = null,
            )
            if (!ok) {
                engageFallback(path, IllegalStateException("NSString.writeToURL returned false"))
            }
        } catch (ex: Exception) {
            engageFallback(path, ex)
        }
    }

    private fun engageFallback(path: String, ex: Throwable) {
        if (!memoryOnly) {
            memoryOnly = true
            logger.warning(
                "FilesystemCache: filesystem unwritable at $path; falling back to in-memory " +
                    "cache. sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    public actual companion object {
        /**
         * iOS default cache directory — `NSCachesDirectory` (the standard system-managed cache
         * location). Returns a path string; callers concatenate the filename tail.
         */
        public actual fun defaultCacheDir(): String {
            val urls = NSFileManager.defaultManager.URLsForDirectory(
                NSCachesDirectory,
                inDomains = NSUserDomainMask,
            )
            val first = urls.firstOrNull() as? NSURL
            val base = first?.path ?: "."
            return "$base/confeature"
        }
    }
}
