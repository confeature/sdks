// SPDX-License-Identifier: MIT

/// Pluggable cache surface — mirrors `configcat_client`'s `ConfigCache`
/// 1:1 (constitution Principle II).
///
/// Default implementation is the filesystem cache at
/// `internal/filesystem_cache.dart` (server-side / CLI / Dart VM).
/// Flutter consumers who need mobile-app storage pass their own
/// implementation that wraps `path_provider` or `shared_preferences`.
library;

import 'package:meta/meta.dart';

/// One cache record: the latest fetched config body + its ETag +
/// fetch timestamp.
@immutable
class CacheEntry {
  /// Construct a cache entry.
  const CacheEntry({
    required this.body,
    required this.etag,
    required this.fetchedAt,
  });

  /// The parsed `config_v6.json` body. Kept as `Map<String, dynamic>`
  /// for direct consumption by the evaluator.
  final Map<String, dynamic> body;

  /// HTTP `ETag` header from the response that produced [body]. `null`
  /// for entries that pre-date ETag support or for failed-fetch
  /// fallbacks.
  final String? etag;

  /// Wall-clock seconds (UTC epoch) at which [body] was fetched.
  final double fetchedAt;
}

/// Pluggable cache surface.
abstract class ConfigCache {
  /// Default constructor for subclasses.
  const ConfigCache();

  /// Return the cached entry, or `null` if none exists.
  CacheEntry? read();

  /// Persist [entry] for subsequent reads.
  void write(CacheEntry entry);
}
