// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import io.confeature.android.ConfigCache
import io.confeature.android.Logger
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Filesystem-backed [ConfigCache].
 *
 * Writes to `{dir}/confeature-{cacheKeyTail}.json`: the payload lands in a tempfile first, then
 * [File.renameTo] swaps it over the target. `renameTo` is not strictly atomic on Android (POSIX
 * `rename(2)` is, but Java doesn't guarantee it across filesystems and Android can span tmpfs
 * boundaries); when the rename fails we fall back to a non-atomic overwrite — still better than
 * losing the write entirely.
 *
 * On the first [IOException] (read or write), the cache logs a single WARNING and switches to
 * memory-only mode for the remainder of the client lifetime — subsequent operations route through
 * an embedded [InMemoryCache] and never re-attempt the filesystem. Matches the Go / .NET / Java
 * file-cache fallback behaviour (FR-014 + spec 037 §FR-012).
 *
 * SDK key NEVER stored raw: the on-disk filename uses only the derived 32-char base64url tail.
 *
 * Android-specific note: the default cache directory is `Context.getCacheDir() + "/confeature/"`,
 * computed by [ConfeatureClient]; constructing this class directly with a [File] keeps the type
 * pure-JVM so Robolectric / pure unit tests don't need a `Context`.
 *
 * Implementation note: uses [java.io.File] (API 1) rather than `java.nio.file.*` (API 26+) so the
 * library stays compatible with the declared `minSdk = 21`. `desugar_jdk_libs` covers
 * `java.time.*` but NOT `java.nio.file.*`.
 */
public class FilesystemCache(
    private val directory: File,
    private val sdkKey: String,
    private val logger: Logger,
) : ConfigCache {
    private val fallback = InMemoryCache()
    private val memoryOnly = AtomicBoolean(false)

    public companion object {
        /**
         * Default cache directory inside `$HOME/.cache/confeature/`. The Android client overrides
         * this with `Context.getCacheDir() + "/confeature/"` (FR-014) — this fallback only fires
         * when the cache is exercised outside the Android runtime (e.g. unit tests, JVM repros).
         */
        @JvmStatic
        public fun defaultCacheDir(): String {
            val home = System.getProperty("user.home")
            return if (home.isNullOrEmpty()) {
                File(".confeature").absolutePath
            } else {
                File(File(home, ".cache"), "confeature").path
            }
        }
    }

    /** Returns the on-disk file for a given cache key. */
    public fun resolveFilePath(cacheKey: String): File {
        val tail = SdkKey.cacheKeyTail(cacheKey)
        return File(directory, "confeature-$tail.json")
    }

    override fun read(cacheKey: String): String? {
        if (memoryOnly.get()) return fallback.read(cacheKey)
        val file = resolveFilePath(cacheKey)
        return try {
            if (!file.exists()) {
                fallback.read(cacheKey)
            } else {
                String(file.readBytes(), StandardCharsets.UTF_8)
            }
        } catch (ex: IOException) {
            engageFallback(file, ex)
            fallback.read(cacheKey)
        }
    }

    override fun write(cacheKey: String, value: String) {
        // Mirror every write into memory first so a subsequent read after a
        // failed disk write still returns the entry.
        fallback.write(cacheKey, value)
        if (memoryOnly.get()) return
        val file = resolveFilePath(cacheKey)
        val threadId = Thread.currentThread().id
        val tmp = File(file.parentFile ?: directory, file.name + ".tmp." + threadId)
        try {
            // mkdirs() returns false if the directory already exists — only fail if the path
            // doesn't exist as a directory afterwards.
            if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory) {
                throw IOException("Failed to create cache directory at $directory")
            }
            val bytes = value.toByteArray(StandardCharsets.UTF_8)
            FileOutputStream(tmp).use { it.write(bytes) }
            if (!tmp.renameTo(file)) {
                // Some filesystems (e.g. cross-device tmpfs, or pre-existing target on Windows-
                // backed test runtimes) reject renameTo over an existing target. Fall back to a
                // non-atomic overwrite — still better than failing the cache write entirely.
                logger.debug(
                    "FilesystemCache: atomic rename unsupported at $file; falling back to non-atomic replace.",
                )
                if (!file.delete() && file.exists()) {
                    throw IOException("Failed to delete existing cache file at $file before overwrite")
                }
                if (!tmp.renameTo(file)) {
                    // Last resort: copy bytes directly to the target.
                    FileOutputStream(file).use { it.write(bytes) }
                    tryDeleteQuietly(tmp)
                }
            }
        } catch (ex: IOException) {
            tryDeleteQuietly(tmp)
            engageFallback(file, ex)
        }
    }

    private fun engageFallback(file: File, ex: IOException) {
        if (memoryOnly.compareAndSet(false, true)) {
            logger.warning(
                "FilesystemCache: filesystem unwritable at $file; falling back to in-memory cache." +
                    " sdkKey=${SdkKey.redact(sdkKey)} reason=${ex.message}",
            )
        }
    }

    private fun tryDeleteQuietly(file: File) {
        // File.delete() never throws — it returns false if the file is absent or the deletion
        // failed. Best-effort cleanup: if a stale tempfile remains, log at WARN so an operator
        // investigating disk pressure sees the residue and the swallow doesn't become a "silent
        // catch" per the project rules. The next successful write creates a fresh tempfile under
        // a new thread-id suffix.
        if (file.exists() && !file.delete()) {
            logger.warning(
                "FilesystemCache: residual tempfile cleanup failed at $file",
            )
        }
    }

    /** Visible for tests. */
    internal fun isMemoryFallback(): Boolean = memoryOnly.get()
}
