// SPDX-License-Identifier: MIT
package io.confeature.android

import io.confeature.android.internal.FilesystemCache
import io.confeature.android.internal.SdkKey
import java.io.File
import java.nio.charset.StandardCharsets
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class FilesystemCacheTest {
    private companion object {
        const val SDK_KEY =
            "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    }

    @Test
    fun writeThenRead_roundTripsValue(@TempDir dir: File) {
        val cache = FilesystemCache(dir, SDK_KEY, TestLogger())
        val cacheKey = SdkKey.deriveCacheKey(SDK_KEY)

        cache.write(cacheKey, "{\"hello\":\"world\"}")
        assertThat(cache.read(cacheKey)).isEqualTo("{\"hello\":\"world\"}")
    }

    @Test
    fun filenameContainsOnlyCacheKeyTail(@TempDir dir: File) {
        val cache = FilesystemCache(dir, SDK_KEY, TestLogger())
        val cacheKey = SdkKey.deriveCacheKey(SDK_KEY)
        cache.write(cacheKey, "{}")

        val file = cache.resolveFilePath(cacheKey)
        assertThat(file.name).startsWith("confeature-").endsWith(".json")
        // The raw SDK key MUST NEVER appear on disk.
        val text = String(file.readBytes(), StandardCharsets.UTF_8)
        assertThat(text).doesNotContain(SDK_KEY)
        assertThat(file.path).doesNotContain(SDK_KEY)
    }

    @Test
    fun readMissingFileReturnsNull(@TempDir dir: File) {
        val cache = FilesystemCache(dir, SDK_KEY, TestLogger())
        val cacheKey = SdkKey.deriveCacheKey(SDK_KEY)
        assertThat(cache.read(cacheKey)).isNull()
    }

    @Test
    fun writeIsAtomic_overwritesExisting(@TempDir dir: File) {
        val cache = FilesystemCache(dir, SDK_KEY, TestLogger())
        val cacheKey = SdkKey.deriveCacheKey(SDK_KEY)
        cache.write(cacheKey, "first")
        cache.write(cacheKey, "second")
        assertThat(cache.read(cacheKey)).isEqualTo("second")
    }
}
