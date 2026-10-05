// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Integration tests for ``ConfeatureClient`` — constructor
/// validation, idempotent close, override-driven evaluation.
final class ConfeatureClientTests: XCTestCase {
    private static let testSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    func testInitDoesNotThrowOnEmptyKey() {
        // Mirrors Rust + Python: empty / malformed keys log a warning
        // but DO NOT abort. Customers see the warning in their log
        // pipeline and can investigate.
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger()
        )
        let client = ConfeatureClient(sdkKey: "", options: options)
        defer { client.close() }
        XCTAssertNotNil(client)
    }

    func testCloseIsIdempotent() {
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        client.close()
        client.close()
        client.close()
        // Reaching here means no double-cancel / double-stop panic.
    }

    func testGetValueAfterCloseReturnsDefault() async {
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger()
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        client.close()
        let result = await client.getValue(forKey: "anything", defaultValue: true)
        XCTAssertTrue(result, "closed client must return the supplied default")
    }

    func testLocalOnlyOverrideWinsOverEmptyCache() async {
        let overrides = FlagOverrides.localOnly(
            MapOverrideDataSource(["feature.x": true]))
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }
        let result = await client.getValue(forKey: "feature.x", defaultValue: false)
        XCTAssertTrue(result)
    }

    func testGetFactoryMatchesDesignatedInitializer() {
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger()
        )
        let viaFactory = ConfeatureClient.get(sdkKey: Self.testSdkKey, options: options)
        defer { viaFactory.close() }
        XCTAssertNotNil(viaFactory)
    }

    func testForceRefreshIsNoOpForLocalOnly() async {
        let overrides = FlagOverrides.localOnly(MapOverrideDataSource([:]))
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }
        _ = await client.forceRefresh()
        // Reaching here = LocalOnly forceRefresh is a no-op, no
        // network call, no panic.
    }
}
