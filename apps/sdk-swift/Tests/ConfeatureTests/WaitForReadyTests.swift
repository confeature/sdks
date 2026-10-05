// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for ``ConfeatureClient/waitForReady()`` (spec 073 §4.8).
final class WaitForReadyTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    func testLocalOnlyClientImmediatelyReady() async {
        let overrides = FlagOverrides.localOnly(MapOverrideDataSource(["k": true]))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides
        )
        options.requestTimeout = 5
        let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
        let state = await client.waitForReady()
        XCTAssertEqual(state, .hasLocalOverrideFlagDataOnly)
        client.close()
    }

    func testManualPollWithoutCacheIsImmediatelyNoFlagData() async {
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger()
        )
        options.requestTimeout = 5
        let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
        let state = await client.waitForReady()
        XCTAssertEqual(state, .noFlagData)
        client.close()
    }

    func testLateCallerReturnsCapturedStateImmediately() async {
        let overrides = FlagOverrides.localOnly(MapOverrideDataSource(["k": true]))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides
        )
        options.requestTimeout = 5
        let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
        // Sleep briefly to ensure the init-time ready-transition has
        // fired before we suspend on the barrier.
        try? await Task.sleep(nanoseconds: 10_000_000)
        let state = await client.waitForReady()
        XCTAssertEqual(state, .hasLocalOverrideFlagDataOnly)
        client.close()
    }

    func testMultipleConcurrentCallersAllResume() async {
        let overrides = FlagOverrides.localOnly(MapOverrideDataSource(["k": true]))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides
        )
        options.requestTimeout = 5
        let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)

        async let s1 = client.waitForReady()
        async let s2 = client.waitForReady()
        async let s3 = client.waitForReady()
        let states = await (s1, s2, s3)
        XCTAssertEqual(states.0, .hasLocalOverrideFlagDataOnly)
        XCTAssertEqual(states.1, .hasLocalOverrideFlagDataOnly)
        XCTAssertEqual(states.2, .hasLocalOverrideFlagDataOnly)
        client.close()
    }
}
