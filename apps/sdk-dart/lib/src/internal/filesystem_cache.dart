// SPDX-License-Identifier: MIT

/// Filesystem-backed cache implementation. Persists [CacheEntry] as
/// JSON at `{cacheDir}/confeature-{cacheKeyTail}.json`.
///
/// On `OSError` during write, switches the instance into memory-only
/// mode and emits a single WARNING log entry. Subsequent reads / writes
/// use the in-memory entry — the filesystem is never retried (mirrors
/// the Python SDK's FR-012 fallback semantics).
library;

import 'dart:convert';
import 'dart:io';

import '../config_cache.dart';
import '../logger.dart';
import 'in_memory_cache.dart';
import 'sdk_key.dart';

/// Filesystem-backed [ConfigCache].
class FileSystemCache extends ConfigCache {
  /// Construct a filesystem cache.
  ///
  /// [cacheDir] resolves either to the supplied path or to
  /// `$HOME/.cache/confeature/` (Linux / macOS) — Windows customers
  /// inject an explicit dir. [cacheKey] is the full
  /// `confeature:cache:v1:<32-char>` envelope; the on-disk filename
  /// strips the prefix so the entry name stays short.
  FileSystemCache({
    required String cacheKey,
    required String sdkKey,
    required Logger logger,
    Directory? cacheDir,
  })  : _logger = logger,
        _sdkKey = sdkKey,
        _memory = InMemoryCache(),
        _cacheDir = cacheDir ?? _defaultCacheDir() {
    final tail = cacheKey.split(':').last;
    _filePath = '${_cacheDir.path}${Platform.pathSeparator}'
        'confeature-$tail.json';
  }

  final Logger _logger;
  final String _sdkKey;
  final InMemoryCache _memory;
  final Directory _cacheDir;
  late final String _filePath;
  bool _fallbackTriggered = false;

  /// Resolve the platform default cache directory.
  ///
  /// On POSIX systems, prefer `$XDG_CACHE_HOME/confeature` then
  /// `$HOME/.cache/confeature`. On Windows, fall back to `%LOCALAPPDATA%`
  /// / `%TEMP%`. The directory is created lazily on first write.
  static Directory _defaultCacheDir() {
    final env = Platform.environment;
    final xdg = env['XDG_CACHE_HOME'];
    if (xdg != null && xdg.isNotEmpty) {
      return Directory('$xdg${Platform.pathSeparator}confeature');
    }
    final home = env['HOME'] ?? env['USERPROFILE'];
    if (home != null && home.isNotEmpty) {
      return Directory('$home${Platform.pathSeparator}.cache'
          '${Platform.pathSeparator}confeature');
    }
    // Last resort: system temp dir.
    return Directory('${Directory.systemTemp.path}'
        '${Platform.pathSeparator}confeature');
  }

  /// Resolved on-disk path for the entry. Exposed for tests.
  String get filePath => _filePath;

  @override
  CacheEntry? read() {
    if (_fallbackTriggered) return _memory.read();
    final file = File(_filePath);
    if (!file.existsSync()) return _memory.read();
    String raw;
    try {
      raw = file.readAsStringSync();
    } on FileSystemException catch (exc) {
      _logger.warning(
        'FileSystemCache.read: failed to load $_filePath '
        '(sdkKey=${redactSdkKey(_sdkKey)}): ${exc.message}',
      );
      return _memory.read();
    }
    try {
      final payload = jsonDecode(raw);
      if (payload is! Map) {
        _logger.warning(
          'FileSystemCache.read: malformed cache file $_filePath '
          '(sdkKey=${redactSdkKey(_sdkKey)}): not an object',
        );
        return null;
      }
      final body = payload['body'];
      if (body is! Map) {
        _logger.warning(
          'FileSystemCache.read: malformed body in $_filePath '
          '(sdkKey=${redactSdkKey(_sdkKey)})',
        );
        return null;
      }
      final fetchedAtRaw = payload['fetched_at'];
      final fetchedAt = fetchedAtRaw is num ? fetchedAtRaw.toDouble() : 0.0;
      final etag = payload['etag'];
      return CacheEntry(
        body: Map<String, dynamic>.from(body),
        etag: etag is String ? etag : null,
        fetchedAt: fetchedAt,
      );
    } on FormatException catch (exc) {
      _logger.warning(
        'FileSystemCache.read: invalid JSON in $_filePath '
        '(sdkKey=${redactSdkKey(_sdkKey)}): ${exc.message}',
      );
      return null;
    }
  }

  @override
  void write(CacheEntry entry) {
    // Always mirror to memory first so reads after a write succeed
    // even if the filesystem path fails.
    _memory.write(entry);
    if (_fallbackTriggered) return;
    try {
      if (!_cacheDir.existsSync()) {
        _cacheDir.createSync(recursive: true);
      }
      final payload = jsonEncode({
        'body': entry.body,
        'etag': entry.etag,
        'fetched_at': entry.fetchedAt,
      });
      final tmp = File('$_filePath.tmp');
      tmp.writeAsStringSync(payload);
      tmp.renameSync(_filePath);
    } on FileSystemException catch (exc) {
      _fallbackTriggered = true;
      _logger.warning(
        'FileSystemCache.write: filesystem unwritable for $_filePath '
        '(sdkKey=${redactSdkKey(_sdkKey)}): ${exc.message}. '
        'Falling back to memory-only cache for this client.',
      );
    }
  }
}
