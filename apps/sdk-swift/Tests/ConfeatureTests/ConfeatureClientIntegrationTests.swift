// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Network-aware integration tests for ``ConfeatureClient`` — drives
/// the full fetch / parse / persist / resolve pipeline through the
/// ``MockURLProtocol`` shim so we can assert against deterministic
/// responses without touching the public CDN.
final class ConfeatureClientIntegrationTests: XCTestCase {
    private static let testSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private static let testConfigBody =
        "{\"f\":{\"feature.on\":{\"t\":0,\"v\":{\"b\":true}},"
        + "\"feature.off\":{\"t\":0,\"v\":{\"b\":false}}}}"

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    func testManualPollResolvesAfterForceRefresh() async {
        MockURLProtocol.handler = { _ in
            MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: Self.testConfigBody
            )
        }
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        // No fetch happened yet — getValue returns default.
        let beforeFetch = await client.getValue(forKey: "feature.on", defaultValue: false)
        XCTAssertFalse(beforeFetch, "ManualPoll: no auto-fetch happens before forceRefresh")

        _ = await client.forceRefresh()

        let afterFetch = await client.getValue(forKey: "feature.on", defaultValue: false)
        XCTAssertTrue(afterFetch)

        let offValue = await client.getValue(forKey: "feature.off", defaultValue: true)
        XCTAssertFalse(offValue)
    }

    func testLazyLoadFetchesOnGetValue() async {
        var hits = 0
        MockURLProtocol.handler = { _ in
            hits += 1
            return MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: Self.testConfigBody
            )
        }
        let options = ConfeatureClientOptions(
            pollingMode: .lazyLoad(cacheRefreshInterval: 60),
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        let result = await client.getValue(forKey: "feature.on", defaultValue: false)
        XCTAssertTrue(result)
        XCTAssertGreaterThan(hits, 0, "LazyLoad must trigger at least one fetch")
    }

    func testForceRefreshHandlesFailure() async {
        MockURLProtocol.handler = { _ in
            MockResponse(statusCode: 503, headers: [:], body: "")
        }
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        // Should not throw / panic; failure is logged inside ConfigFetcher.
        _ = await client.forceRefresh()

        // Cache should remain empty after a failed fetch — getValue
        // returns the supplied default.
        let value = await client.getValue(forKey: "feature.on", defaultValue: true)
        XCTAssertTrue(value)
    }

    func testForceRefreshPersistsToCustomConfigCache() async {
        MockURLProtocol.handler = { _ in
            MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: Self.testConfigBody
            )
        }
        let captureCache = InMemoryCache()
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            configCache: captureCache,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        _ = await client.forceRefresh()

        let cacheKey = SdkKey.deriveCacheKey(Self.testSdkKey)
        let persisted = captureCache.read(forKey: cacheKey)
        XCTAssertNotNil(persisted, "custom ConfigCache must receive a write after forceRefresh")
        XCTAssertTrue(persisted!.contains("feature.on"))
    }

    func testSnapshotReflectsLastFetch() async {
        MockURLProtocol.handler = { _ in
            MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: Self.testConfigBody
            )
        }
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        _ = await client.forceRefresh()
        let snap = client.snapshot()
        let keys = snap.getAllKeys()
        XCTAssertEqual(keys.sorted(), ["feature.off", "feature.on"])
    }

    func testInitWithInvalidKeyFormatStillUsable() async {
        // Invalid format logs a WARNING and continues — the client
        // is still constructible and operational with LocalOnly
        // overrides (no network).
        let logger = RecordingLogger()
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: logger,
            flagOverrides: FlagOverrides.localOnly(MapOverrideDataSource(["k": true]))
        )
        let client = ConfeatureClient(sdkKey: "not-a-confeature-key", options: options)
        defer { client.close() }

        let warnings = logger.entries().filter { $0.level == .warning }
        XCTAssertTrue(
            warnings.contains(where: { $0.message.contains("INVALID_SDK_KEY") }),
            "expected an INVALID_SDK_KEY warning (got \(logger.entries().map(\.message)))"
        )

        let value = await client.getValue(forKey: "k", defaultValue: false)
        XCTAssertTrue(value)
    }

    func testFilesystemCacheRoundTripAcrossClientLifecycles() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("confeature-client-rt-\(UUID().uuidString)")

        MockURLProtocol.handler = { _ in
            MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: Self.testConfigBody
            )
        }

        do {
            let options = ConfeatureClientOptions(
                pollingMode: .manualPoll,
                requestTimeout: 5,
                cacheDirectory: tempDir,
                logger: NoOpLogger(),
                urlSession: makeSession()
            )
            let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
            _ = await client.forceRefresh()
            client.close()
        }

        // New client over the same cache directory + no network
        // should be able to resolve from the on-disk entry.
        MockURLProtocol.reset()
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: tempDir,
            logger: NoOpLogger(),
            urlSession: makeSession()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }
        let value = await client.getValue(forKey: "feature.on", defaultValue: false)
        XCTAssertTrue(value, "second client must hydrate from the on-disk cache")
    }
}
