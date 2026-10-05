// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``LogLevel`` — ordering + ``allows(_:)`` matrix.
final class LogLevelTests: XCTestCase {
    func testOffBlocksEverything() {
        XCTAssertFalse(LogLevel.off.allows(.error))
        XCTAssertFalse(LogLevel.off.allows(.warning))
        XCTAssertFalse(LogLevel.off.allows(.info))
        XCTAssertFalse(LogLevel.off.allows(.debug))
    }

    func testErrorOnlyPassesError() {
        XCTAssertTrue(LogLevel.error.allows(.error))
        XCTAssertFalse(LogLevel.error.allows(.warning))
        XCTAssertFalse(LogLevel.error.allows(.info))
        XCTAssertFalse(LogLevel.error.allows(.debug))
    }

    func testDebugPassesEverythingExceptOff() {
        XCTAssertTrue(LogLevel.debug.allows(.error))
        XCTAssertTrue(LogLevel.debug.allows(.warning))
        XCTAssertTrue(LogLevel.debug.allows(.info))
        XCTAssertTrue(LogLevel.debug.allows(.debug))
    }

    func testWarningPassesErrorAndWarning() {
        XCTAssertTrue(LogLevel.warning.allows(.error))
        XCTAssertTrue(LogLevel.warning.allows(.warning))
        XCTAssertFalse(LogLevel.warning.allows(.info))
        XCTAssertFalse(LogLevel.warning.allows(.debug))
    }

    func testComparable() {
        XCTAssertLessThan(LogLevel.off, LogLevel.error)
        XCTAssertLessThan(LogLevel.error, LogLevel.warning)
        XCTAssertLessThan(LogLevel.warning, LogLevel.info)
        XCTAssertLessThan(LogLevel.info, LogLevel.debug)
    }
}
