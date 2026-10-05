// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``PollingMode`` factory helpers.
final class PollingModeTests: XCTestCase {
    func testDefaultAutoPollDocumentedDefaults() {
        guard case .autoPoll(let interval, let maxInit) = PollingMode.defaultAutoPoll else {
            XCTFail("expected .autoPoll")
            return
        }
        XCTAssertEqual(interval, 60)
        XCTAssertEqual(maxInit, 5)
    }

    func testDefaultLazyLoadDocumentedDefault() {
        guard case .lazyLoad(let refresh) = PollingMode.defaultLazyLoad else {
            XCTFail("expected .lazyLoad")
            return
        }
        XCTAssertEqual(refresh, 60)
    }

    func testDefaultModeIsAutoPoll() {
        if case .autoPoll = PollingMode.defaultMode {
            // ok
        } else {
            XCTFail("expected defaultMode to be .autoPoll")
        }
    }

    func testManualPollEquality() {
        XCTAssertEqual(PollingMode.manualPoll, PollingMode.manualPoll)
    }
}
