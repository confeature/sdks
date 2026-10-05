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
 * JVM filesystem-backed [ConfigCache].
 *
 * <p>Writes to `{dir}/confeature-{cacheKeyTail}.json` atomically: the payload lands in a tempfile
 * first, then [Files.move] renames it over the target with `REPLACE_EXISTING` + `ATOMIC_MOVE`.
 *
 * <p>On the first [IOException] (read or write), the cache logs a single WARNING and switches to
 * memory-only mode for the remainder of the client lifetime — subsequent operations route through
 * an embedded [InMemoryCache] and never re-attempt the filesystem. Matches the Go / .NET / Java
 * file-cache fallback behaviour (FR-014).
 *
 * <p>SDK key NEVER stored raw: the on-disk filename uses only the derived 32-char base64url tail.
 */
public actual class FilesystemCache actual constructor(
    directory: String,
    private val sdkKey: String,
    private val logger: Logger,
) : ConfigCache {
    private val dir: Path = Paths.get(directory)
    private val fallback = InMemoryCache()
    private val memoryOnly = AtomicBoolean(false)

    /** Returns the on-disk path for a given cache key. */
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
        // Mirror every write into memory first so a subsequent read after a
        // failed disk write still returns the entry.
        fallback.write(cacheKey, value)
        if (memoryOnly.get()) return

        val path = resolveFilePath(cacheKey)
        // `Thread.id` is deprecated in JDK 19+ in favour of `threadId()`,
        // but the latter is unavailable on the JDK 11 baseline. Keep `id`
        // and suppress until the baseline moves — matches sdk-java.
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
                // Some filesystems (e.g. cross-device tmpfs) don't support
                // ATOMIC_MOVE. Fall back to a non-atomic replace.
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
            // Best-effort cleanup — already in the failure path. Log at
            // WARN so an operator investigating disk pressure sees the
            // residue and the catch is not silent.
            logger.warning(
                "FilesystemCache: residual tempfile cleanup failed at $path; reason=${ex.message}",
            )
        }
    }

    /** Visible for tests. */
    internal fun isMemoryFallback(): Boolean = memoryOnly.get()

    public actual companion object {
        /** Default cache directory inside `$HOME/.cache/confeature`. Matches the Java SDK. */
        public actual fun defaultCacheDir(): String {
            val home = System.getProperty("user.home")
            return if (home.isNullOrEmpty()) {
                Paths.get(".confeature").toAbsolutePath().toString()
            } else {
                Paths.get(home, ".cache", "confeature").toString()
            }
        }
    }
}
