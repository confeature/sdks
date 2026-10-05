// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * Cache abstraction for the latest {@code config_v6.json} body + ETag. The default implementation
 * lives in {@code io.confeature.client.internal.FilesystemCache}, with an in-memory fallback for
 * sandboxes that can't write to disk.
 *
 * <p>Mirrors ConfigCat's {@code com.configcat.ConfigCache} 1:1.
 *
 * <p>Keys passed to {@link #read(String)} / {@link #write(String, String)} are the derived 32-char
 * base64url cache keys (NEVER the raw SDK key).
 */
public interface ConfigCache {

  /** Returns the cached payload for {@code cacheKey}, or {@code null} when absent. */
  String read(String cacheKey);

  /**
   * Persists {@code value} under {@code cacheKey}. Implementations MUST NOT throw on filesystem
   * failures — the SDK degrades gracefully to in-memory mode (see {@code FilesystemCache} for the
   * canonical behaviour).
   */
  void write(String cacheKey, String value);
}
