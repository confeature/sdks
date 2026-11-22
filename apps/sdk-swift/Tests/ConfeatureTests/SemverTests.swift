// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

final class SemverTests: XCTestCase {
    func testCoreComponentsBeyond32BitsKeepTheJavaScriptSafeIntegerLimit() throws {
        let lower = try XCTUnwrap(SemVer.parse("2147483647.0.0"))
        let higher = try XCTUnwrap(SemVer.parse("2147483648.0.0"))
        XCTAssertEqual(higher.compare(lower), 1)
        XCTAssertEqual(higher.canonical, "2147483648.0.0")

        XCTAssertNotNil(SemVer.parse("9007199254740991.9007199254740991.9007199254740991"))
        XCTAssertNil(SemVer.parse("9007199254740992.0.0"))
        XCTAssertNil(SemVer.parse("0.9007199254740992.0"))
        XCTAssertNil(SemVer.parse("0.0.9007199254740992"))
    }

    func testNumericPrereleaseIdentifiersBeyond32BitsCompareNumerically() throws {
        let lower = try XCTUnwrap(SemVer.parse("1.0.0-2147483648"))
        let higher = try XCTUnwrap(SemVer.parse("1.0.0-10000000000"))
        XCTAssertEqual(lower.compare(higher), -1)
        XCTAssertEqual(higher.compare(lower), 1)
    }
}
