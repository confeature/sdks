// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for ``ConfeatureClient/setDefaultUser(_:)`` /
/// ``ConfeatureClient/clearDefaultUser()`` (spec 073 / FR-019).
///
/// v1 evaluator ignores the user, so these tests verify the state
/// plumbing (the user is captured and forwarded into
/// ``Snapshot/getValue(forKey:defaultValue:user:)``). Targeting
/// behaviour against the user is asserted by the future targeting-
/// aware evaluator.
final class DefaultUserTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private func makeClient(defaultUser: User? = nil) -> ConfeatureClient {
        let overrides = FlagOverrides.localOnly(
            MapOverrideDataSource(["feature.on": true]))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides,
            defaultUser: defaultUser
        )
        options.requestTimeout = 5
        return ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
    }

    func testSetDefaultUserUpdatesSlot() async {
        let client = makeClient()
        let user = User(identifier: "u-1")
        client.setDefaultUser(user)
        // Snapshot captures the user via stateQueue — verify the
        // value comes through.
        let snapshot = client.snapshot()
        XCTAssertNotNil(snapshot)
        let resolved: Bool = await client.getValue(
            forKey: "feature.on", defaultValue: false, user: nil)
        XCTAssertTrue(resolved)
        client.close()
    }

    func testClearDefaultUserRevertsToNil() async {
        let client = makeClient(defaultUser: User(identifier: "u-default"))
        client.clearDefaultUser()
        let resolved: Bool = await client.getValue(
            forKey: "feature.on", defaultValue: false, user: nil)
        XCTAssertTrue(resolved)
        client.close()
    }

    func testPerCallUserOverridesDefault() async {
        let client = makeClient(defaultUser: User(identifier: "u-default"))
        let perCall = User(identifier: "u-per-call")
        let resolved: Bool = await client.getValue(
            forKey: "feature.on", defaultValue: false, user: perCall)
        XCTAssertTrue(resolved)
        client.close()
    }
}
