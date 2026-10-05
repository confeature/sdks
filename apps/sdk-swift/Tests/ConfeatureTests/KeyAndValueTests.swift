// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for ``ConfeatureClient/getKeyAndValue(for:)`` (spec 073).
///
/// v1 only iterates top-level setting identifiers (`setting["i"]`);
/// it does NOT walk targeting rules or percentage options.
final class KeyAndValueTests: XCTestCase {
    func testReturnsMatchingKeyValueForBooleanSetting() {
        let snapshot = Snapshot(
            config: [
                "f": [
                    "feature.flag": ["t": 0, "v": ["b": true], "i": "v1"]
                ]
            ], overrides: nil, defaultUser: nil)
        let result = snapshot.getKeyAndValue(for: "v1")
        XCTAssertEqual(result?.key, "feature.flag")
        XCTAssertEqual(result?.value as? Bool, true)
    }

    func testReturnsMatchingKeyValueForStringSetting() {
        let snapshot = Snapshot(
            config: [
                "f": [
                    "feature.label": ["t": 1, "v": ["s": "hello"], "i": "v-str"]
                ]
            ], overrides: nil, defaultUser: nil)
        let result = snapshot.getKeyAndValue(for: "v-str")
        XCTAssertEqual(result?.key, "feature.label")
        XCTAssertEqual(result?.value as? String, "hello")
    }

    func testReturnsNilWhenNoMatch() {
        let snapshot = Snapshot(
            config: [
                "f": ["feature.flag": ["t": 0, "v": ["b": true], "i": "v1"]]
            ], overrides: nil, defaultUser: nil)
        XCTAssertNil(snapshot.getKeyAndValue(for: "v-absent"))
    }

    func testReturnsNilWhenNoConfig() {
        let snapshot = Snapshot(config: nil, overrides: nil, defaultUser: nil)
        XCTAssertNil(snapshot.getKeyAndValue(for: "v1"))
    }
}
