// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for the 7-branch override-eval decision tree.
final class OverrideEvalTests: XCTestCase {
    private func bundle(
        _ map: [String: Any]?, behaviour: OverrideBehaviour = .localOnly
    ) -> FlagOverrides {
        let source: OverrideDataSource =
            map.map { MapOverrideDataSource($0) } ?? NilDataSource()
        return FlagOverrides(dataSource: source, behaviour: behaviour)
    }

    private struct NilDataSource: OverrideDataSource {
        func getOverridesSync() -> [String: Any]? { nil }
    }

    func testBranch1NoneFallsThrough() {
        let (found, value) = OverrideEval.evaluateSync(
            overrides: nil, key: "k", defaultValue: false)
        XCTAssertFalse(found)
        XCTAssertNil(value)
    }

    func testBranch2NonLocalOnlyFallsThrough() {
        let fo = bundle([:], behaviour: .localOverRemote)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: false)
        XCTAssertFalse(found)
        XCTAssertNil(value)
    }

    func testBranch3NoSyncDataFallsThrough() {
        let fo = bundle(nil, behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: false)
        XCTAssertFalse(found)
        XCTAssertNil(value)
    }

    func testBranch4AbsentKeyReturnsDefault() {
        let fo = bundle([:], behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "missing", defaultValue: false)
        XCTAssertTrue(found)
        XCTAssertEqual(value as? Bool, false)
    }

    func testBranch5NullOverrideReturnsDefault() {
        let fo = bundle(["k": NSNull()], behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: true)
        XCTAssertTrue(found)
        XCTAssertEqual(value as? Bool, true)
    }

    func testBranch6TypeMismatchReturnsDefault() {
        let fo = bundle(["k": "string-value"], behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: true)
        XCTAssertTrue(found)
        XCTAssertEqual(value as? Bool, true)
    }

    func testBranch6NilDefaultBypassesTypeCheck() {
        let fo = bundle(["k": "string-value"], behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: nil)
        XCTAssertTrue(found)
        XCTAssertEqual(value as? String, "string-value")
    }

    func testBranch7HappyPathReturnsOverride() {
        let fo = bundle(["k": true], behaviour: .localOnly)
        let (found, value) = OverrideEval.evaluateSync(
            overrides: fo, key: "k", defaultValue: false)
        XCTAssertTrue(found)
        XCTAssertEqual(value as? Bool, true)
    }
}
