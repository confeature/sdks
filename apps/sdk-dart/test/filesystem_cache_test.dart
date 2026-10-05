// SPDX-License-Identifier: MIT

/// Unit tests for the filesystem-backed config cache.
library;

import 'dart:io';

import 'package:test/test.dart';

import 'package:confeature/confeature.dart';
// ignore: depend_on_referenced_packages
import 'package:confeature/src/internal/filesystem_cache.dart';

void main() {
  group('FileSystemCache', () {
    late Directory tempDir;
    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('confeature-test-');
    });
    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    test('write + read round-trip', () {
      final cache = FileSystemCache(
        cacheKey: 'confeature:cache:v1:abcdefghij',
        sdkKey: 'sdk-key-fixture-1234567890123456',
        logger: StderrLogger(level: LogLevel.off),
        cacheDir: tempDir,
      );
      cache.write(
        const CacheEntry(
          body: {'p': {}, 'f': <String, dynamic>{}},
          etag: '"abc"',
          fetchedAt: 1234567890.0,
        ),
      );
      final read = cache.read();
      expect(read, isNotNull);
      expect(read!.etag, equals('"abc"'));
      expect(read.fetchedAt, equals(1234567890.0));
      expect(read.body['p'], isA<Map>());
    });

    test('missing file returns null', () {
      final cache = FileSystemCache(
        cacheKey: 'confeature:cache:v1:missing-tail',
        sdkKey: 'sdk-key-fixture-1234567890123456',
        logger: StderrLogger(level: LogLevel.off),
        cacheDir: tempDir,
      );
      expect(cache.read(), isNull);
    });

    test('mirror to memory survives if filesystem write fails', () {
      // Point at a non-existent directory we cannot create (use a
      // file path as parent so the mkdir call fails).
      final blocker =
          File('${tempDir.path}${Platform.pathSeparator}blocker.txt')
            ..writeAsStringSync('not-a-dir');
      final badDir = Directory('${blocker.path}${Platform.pathSeparator}sub');
      final cache = FileSystemCache(
        cacheKey: 'confeature:cache:v1:tail',
        sdkKey: 'sdk-key-fixture-1234567890123456',
        logger: StderrLogger(level: LogLevel.off),
        cacheDir: badDir,
      );
      cache.write(
        const CacheEntry(
          body: {'p': {}, 'f': <String, dynamic>{}},
          etag: null,
          fetchedAt: 0,
        ),
      );
      // The on-disk write failed but the in-memory mirror retained the
      // entry — reads must still return it.
      expect(cache.read(), isNotNull);
    });
  });
}
