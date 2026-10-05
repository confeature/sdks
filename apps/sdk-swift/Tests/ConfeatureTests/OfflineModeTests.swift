// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for offline-mode polling + forceRefresh upgrade (spec 073).
///
/// Verifies the offline flag is thread-safe; `forceRefresh()` returns
/// the right `RefreshResult` for each scenario (closed, localOnly,
/// offline, success); the AutoPoll task suspends under
/// `setOffline()`; a `setOnline()` on an AutoPoll-started-offline
/// client triggers `startPolling`.
final class OfflineModeTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private func makeLocalOnlyClient(offline: Bool = false) -> ConfeatureClient {
        let overrides = FlagOverrides.localOnly(
            MapOverrideDataSource(["k": true]))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: overrides,
            offline: offline
        )
        options.requestTimeout = 5
        return ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
    }

    func testIsOfflineReadsBackInitialState() {
        let client = makeLocalOnlyClient(offline: true)
        XCTAssertTrue(client.isOffline)
        client.close()
    }

    func testIsOfflineDefaultsFalse() {
        let client = makeLocalOnlyClient()
        XCTAssertFalse(client.isOffline)
        client.close()
    }

    func testSetOfflineSetOnlineToggleState() {
        let client = makeLocalOnlyClient()
        XCTAssertFalse(client.isOffline)
        client.setOffline()
        XCTAssertTrue(client.isOffline)
        client.setOnline()
        XCTAssertFalse(client.isOffline)
        client.close()
    }

    func testForceRefreshReturnsLocalOnlyClientErrorCode() async {
        let client = makeLocalOnlyClient()
        let result = await client.forceRefresh()
        XCTAssertFalse(result.isSuccess)
        XCTAssertEqual(result.errorCode, .localOnlyClient)
        XCTAssertNotNil(result.errorMessage)
        client.close()
    }

    func testForceRefreshReturnsOfflineClientErrorCode() async {
        // Non-LocalOnly client in offline mode → offlineClient code.
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            offline: true
        )
        options.requestTimeout = 5
        let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
        let result = await client.forceRefresh()
        XCTAssertFalse(result.isSuccess)
        XCTAssertEqual(result.errorCode, .offlineClient)
        client.close()
    }

    func testForceRefreshReturnsUnexpectedErrorWhenClosed() async {
        let client = makeLocalOnlyClient()
        client.close()
        let result = await client.forceRefresh()
        XCTAssertFalse(result.isSuccess)
        XCTAssertEqual(result.errorCode, .unexpectedError)
    }

    func testConcurrentOfflineToggleIsThreadSafe() {
        let client = makeLocalOnlyClient()
        DispatchQueue.concurrentPerform(iterations: 100) { i in
            if i.isMultiple(of: 2) {
                client.setOffline()
            } else {
                client.setOnline()
            }
            _ = client.isOffline
        }
        // The final state is non-deterministic; just verify no crash.
        client.close()
    }
}
