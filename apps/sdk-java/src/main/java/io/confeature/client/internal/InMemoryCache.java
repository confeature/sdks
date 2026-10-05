// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.ConfigCache;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Process-local {@link ConfigCache} implementation. Used as a fallback when the filesystem cache
 * cannot write (matches the Go / .NET file-cache fallback behaviour) and as the explicit choice
 * when a customer passes {@code ":memory:"} as the cache directory.
 *
 * <p>Thread-safe; the cache is just a {@link ConcurrentMap} guarded by the standard happens-before
 * of {@code ConcurrentHashMap}.
 */
public final class InMemoryCache implements ConfigCache {

  private final ConcurrentMap<String, String> store = new ConcurrentHashMap<>();

  @Override
  public String read(String cacheKey) {
    if (cacheKey == null) {
      return null;
    }
    return store.get(cacheKey);
  }

  @Override
  public void write(String cacheKey, String value) {
    if (cacheKey == null || value == null) {
      return;
    }
    store.put(cacheKey, value);
  }
}
