// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal.platform

import io.confeature.kmp.ConfigCache
import io.confeature.kmp.Logger
import io.confeature.kmp.internal.InMemoryCache
import io.confeature.kmp.internal.SdkKey
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android filesystem-backed [ConfigCache]. Identical to the JVM impl with one twist: the default
 * cache directory uses an Android-friendly path. Customers that want the real
 * `Context.getCacheDir()` path SHOULD pass it explicitly via the builder's `cacheDirectory`
 * setter — common code stays free of `android.content.Context` so this source set can compile
 * without an Android runtime when only the unit-test JVM is involved.
 */
public actual class FilesystemCache actual constructor(
    directory: String,
    private val sdkKey: String,
    private val logger: Logger,
) : ConfigCache {
    private val dir: Path = Paths.get(directory)
    private val fallback = InMemoryCache()
    private val memoryOnly = AtomicBoolean(false)

    public fun resolveFilePath(cacheKey: String): Path {
        val tail = SdkKey.cacheKeyTail(cacheKey)
        return dir.resolve("confeature-$tail.json")
    }

    actual override suspend fun read(cacheKey: String): String? {
        if (memoryOnly.get()) return fallback.read(cacheKey)
        val path = resolveFilePath(cacheKey)
        return try {
            if (!Files.exists(path)) fallback.read(cacheKey)
            else String(Files.readAllBytes(path), StandardCharsets.UTF_8)
        } catch (ex: IOException) {
            engageFallback(path, ex)
            fallback.read(cacheKey)
        }
    }

    actual override suspend fun write(cacheKey: String, value: String) {
        fallback.write(cacheKey, value)
        if (memoryOnly.get()) return

        val path = resolveFilePath(cacheKey)
        @Suppress("DEPRECATION")
        val threadId = Thread.currentThread().id
        val tmp = path.resolveSibling("${path.fileName}.tmp.$threadId")
        try {
            Files.createDirectories(dir)
            Files.write(tmp, value.toByteArray(StandardCharsets.UTF_8))
            try {
                Files.move(
                    tmp,
                    path,
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING)
            }
        } catch (ex: IOException) {
            tryDeleteQuietly(tmp)
            engageFallback(path, ex)
        }
    }

    private fun engageFallback(path: Path, ex: IOException) {
        if (memoryOnly.compareAndSet(false, true)) {
            logger.warning(
                "FilesystemCache: filesystem unwritable at $path; falling back to in-memory " +
                    "cache. sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    private fun tryDeleteQuietly(path: Path) {
        try {
            Files.deleteIfExists(path)
        } catch (ex: IOException) {
            logger.warning(
                "FilesystemCache: residual tempfile cleanup failed at $path; reason=${ex.message}",
            )
        }
    }

    public actual companion object {
        /**
         * Default Android cache directory. Falls back to the app working dir's `.confeature/`
         * subdirectory because we can't reach `Context.getCacheDir()` from common code. Customers
         * SHOULD override via the builder.
         */
        public actual fun defaultCacheDir(): String =
            Paths.get("./.confeature").toAbsolutePath().toString()
    }
}
