// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``FilesystemCache`` + ``InMemoryCache``.
final class FilesystemCacheTests: XCTestCase {
    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("confeature-cache-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true, attributes: nil)
        return dir
    }

    override func tearDownWithError() throws {
        // Best-effort: tests use unique UUID-suffixed directories so
        // residue from one run does not leak into another. We rely
        // on the OS to GC the temp dir.
    }

    func testInMemoryRoundTrip() {
        let cache = InMemoryCache()
        XCTAssertNil(cache.read(forKey: "k"))
        cache.write(value: "{\"hello\": true}", forKey: "k")
        XCTAssertEqual(cache.read(forKey: "k"), "{\"hello\": true}")
    }

    func testFilesystemRoundTrip() throws {
        let dir = try makeTempDir()
        let cache = FilesystemCache(
            directory: dir, sdkKey: "test-sdk-key-1234567890abcdef",
            logger: NoOpLogger())
        let key = "confeature:cache:v1:abcdefghijklmnopqrstuvwxyz012345"
        XCTAssertNil(cache.read(forKey: key))
        cache.write(value: "{\"hello\": \"world\"}", forKey: key)
        let got = cache.read(forKey: key)
        XCTAssertEqual(got, "{\"hello\": \"world\"}")

        // File name uses the 32-char tail.
        let expectedFile =
            dir.appendingPathComponent(
                "confeature-abcdefghijklmnopqrstuvwxyz012345.json"
            ).path
        XCTAssertTrue(FileManager.default.fileExists(atPath: expectedFile))
    }

    func testFilesystemFallbackOnUnwritableDirectory() {
        // Point the cache at a path that cannot be written to so
        // the first write triggers the fallback. /dev/null is a
        // file, not a directory, so createDirectory fails
        // immediately.
        let unwritable = URL(fileURLWithPath: "/dev/null/confeature-broken")
        let cache = FilesystemCache(
            directory: unwritable, sdkKey: "test-sdk-key",
            logger: NoOpLogger())
        let key = "confeature:cache:v1:tail"
        cache.write(value: "{}", forKey: key)
        // The memory fallback now serves reads.
        XCTAssertEqual(cache.read(forKey: key), "{}")
    }
}
