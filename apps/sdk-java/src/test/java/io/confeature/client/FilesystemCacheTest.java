// SPDX-License-Identifier: MIT
package io.confeature.client;

import static org.assertj.core.api.Assertions.assertThat;

import io.confeature.client.internal.FilesystemCache;
import io.confeature.client.internal.SdkKey;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class FilesystemCacheTest {

  private static final String SDK_KEY =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  @Test
  void writeThenRead_roundTripsValue(@TempDir Path dir) {
    final TestLogger logger = new TestLogger();
    final FilesystemCache cache = new FilesystemCache(dir, SDK_KEY, logger);
    final String cacheKey = SdkKey.deriveCacheKey(SDK_KEY);

    cache.write(cacheKey, "{\"hello\":\"world\"}");
    assertThat(cache.read(cacheKey)).isEqualTo("{\"hello\":\"world\"}");
  }

  @Test
  void filenameContainsOnlyCacheKeyTail(@TempDir Path dir) throws IOException {
    final TestLogger logger = new TestLogger();
    final FilesystemCache cache = new FilesystemCache(dir, SDK_KEY, logger);
    final String cacheKey = SdkKey.deriveCacheKey(SDK_KEY);
    cache.write(cacheKey, "{}");

    final Path file = cache.resolveFilePath(cacheKey);
    assertThat(file.getFileName().toString()).startsWith("confeature-").endsWith(".json");
    // The raw SDK key MUST NEVER appear on disk.
    final String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    assertThat(text).doesNotContain(SDK_KEY);
    assertThat(file.toString()).doesNotContain(SDK_KEY);
  }

  @Test
  void readMissingFileReturnsNull(@TempDir Path dir) {
    final FilesystemCache cache = new FilesystemCache(dir, SDK_KEY, new TestLogger());
    final String cacheKey = SdkKey.deriveCacheKey(SDK_KEY);
    assertThat(cache.read(cacheKey)).isNull();
  }

  @Test
  void writeIsAtomic_overwritesExisting(@TempDir Path dir) {
    final FilesystemCache cache = new FilesystemCache(dir, SDK_KEY, new TestLogger());
    final String cacheKey = SdkKey.deriveCacheKey(SDK_KEY);
    cache.write(cacheKey, "first");
    cache.write(cacheKey, "second");
    assertThat(cache.read(cacheKey)).isEqualTo("second");
  }
}
