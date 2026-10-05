// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.platform.FilesystemCache
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Filesystem cache contract — atomic write, read-after-write, missing-key returns null, and the
 * non-existent-directory fallback to in-memory mode (matches sdk-java's `FilesystemCacheTest`).
 */
class FilesystemCacheTest {

    private val sdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    @Test
    fun write_thenRead_returnsSameBody(@TempDir tmp: Path) = runBlocking {
        val cache = FilesystemCache(tmp.toString(), sdkKey, CapturingLogger())
        cache.write("confeature:cache:v1:abc12345abc12345abc12345abc12345", "{\"hello\":\"world\"}")
        val read = cache.read("confeature:cache:v1:abc12345abc12345abc12345abc12345")
        assertEquals("{\"hello\":\"world\"}", read)
    }

    @Test
    fun read_missingFileReturnsNull(@TempDir tmp: Path) = runBlocking {
        val cache = FilesystemCache(tmp.toString(), sdkKey, CapturingLogger())
        val read = cache.read("confeature:cache:v1:absent000000000000000000000000000")
        assertNull(read)
    }

    @Test
    fun write_persistsFileWithCacheKeyTail(@TempDir tmp: Path) = runBlocking {
        val cache = FilesystemCache(tmp.toString(), sdkKey, CapturingLogger())
        val cacheKey = "confeature:cache:v1:tail12345tail12345tail12345tail12"
        cache.write(cacheKey, "value")
        val file = tmp.resolve("confeature-tail12345tail12345tail12345tail12.json")
        assertTrue(Files.exists(file))
        assertEquals("value", Files.readString(file))
    }

    @Test
    fun resolveFilePath_includesTailOnly(@TempDir tmp: Path) {
        val cache = FilesystemCache(tmp.toString(), sdkKey, CapturingLogger())
        val path = cache.resolveFilePath("confeature:cache:v1:xyz")
        assertEquals("confeature-xyz.json", path.fileName.toString())
    }

    @Test
    fun write_intoUnwritableDirectoryFallsBackToMemory(@TempDir tmp: Path) = runBlocking {
        // Create a path that points to a regular file. The cache directory
        // resolves to this path, so `Files.createDirectories` will raise
        // FileAlreadyExistsException → cache flips to memory-only mode.
        val sentinel = tmp.resolve("not-a-dir")
        Files.writeString(sentinel, "x")
        val logger = CapturingLogger()
        val cache = FilesystemCache(sentinel.toString(), sdkKey, logger)
        cache.write("confeature:cache:v1:fallback00000000000000000000000", "{\"k\":1}")
        // Read still succeeds via the in-memory fallback.
        val read = cache.read("confeature:cache:v1:fallback00000000000000000000000")
        assertEquals("{\"k\":1}", read)
        // The fallback path logs a WARN — assert it landed without leaking the SDK key.
        assertNotNull(logger.messages.firstOrNull { it.startsWith("WARN") })
        for (m in logger.messages) {
            assertTrue(!m.contains(sdkKey))
        }
    }

    @Test
    fun defaultCacheDir_returnsConfeatureCacheUnderHome() {
        val dir = FilesystemCache.defaultCacheDir()
        // Either honors HOME → ~/.cache/confeature, or falls back to .confeature.
        assertTrue(
            dir.endsWith(".cache/confeature") || dir.endsWith(".confeature"),
            "unexpected default dir: $dir",
        )
    }
}
