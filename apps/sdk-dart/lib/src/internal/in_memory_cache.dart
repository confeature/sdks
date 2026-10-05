// SPDX-License-Identifier: MIT

/// In-process cache implementation. Used by Flutter Web (no
/// filesystem), by tests, and as the lazy fallback from
/// [FileSystemCache] when the disk is unwritable.
library;

import '../config_cache.dart';

/// Process-local cache. Stores a single [CacheEntry] in memory.
class InMemoryCache extends ConfigCache {
  /// Construct an empty in-memory cache.
  InMemoryCache();

  CacheEntry? _entry;

  @override
  CacheEntry? read() => _entry;

  @override
  void write(CacheEntry entry) {
    _entry = entry;
  }
}
