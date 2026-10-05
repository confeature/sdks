// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for ``ConfeatureClient/getAllValues(user:)`` /
/// ``ConfeatureClient/getAllKeys()`` (spec 073).
final class AllValuesTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private func makeClient(overrides: [String: Any] = [:]) -> ConfeatureClient {
        let bundle = FlagOverrides.localOnly(MapOverrideDataSource(overrides))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: bundle
        )
        options.requestTimeout = 5
        return ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
    }

    func testGetAllKeysReturnsSortedUnion() async {
        let client = makeClient(overrides: [
            "feature.beta": true,
            "feature.alpha": "hello",
            "feature.gamma": 42,
        ])
        let keys = await client.getAllKeys()
        XCTAssertEqual(keys, ["feature.alpha", "feature.beta", "feature.gamma"])
        client.close()
    }

    func testGetAllValuesReturnsOverridesWhenNoCache() async {
        let client = makeClient(overrides: [
            "feature.flag": true,
            "feature.label": "hello",
        ])
        let values = await client.getAllValues()
        XCTAssertEqual(values["feature.flag"] as? Bool, true)
        XCTAssertEqual(values["feature.label"] as? String, "hello")
        client.close()
    }

    func testGetAllValuesEmptyWhenCacheAndOverridesEmpty() async {
        let client = makeClient()
        let values = await client.getAllValues()
        XCTAssertTrue(values.isEmpty)
        let keys = await client.getAllKeys()
        XCTAssertTrue(keys.isEmpty)
        client.close()
    }
}
