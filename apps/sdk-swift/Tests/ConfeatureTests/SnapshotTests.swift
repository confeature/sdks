// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``Snapshot`` — resolves overrides first, then
/// falls through to the cached config; getAllKeys() unions both
/// sources.
final class SnapshotTests: XCTestCase {
    private func sampleConfig() -> [String: Any] {
        [
            "f": [
                "feature.on": ["t": 0, "v": ["b": true]]
            ]
        ]
    }

    func testEmptySnapshotReturnsDefault() {
        let s = Snapshot(config: nil, overrides: nil, defaultUser: nil)
        let got: Bool = s.getValue(forKey: "x", defaultValue: false)
        XCTAssertFalse(got)
    }

    func testResolvesCachedValue() {
        let s = Snapshot(config: sampleConfig(), overrides: nil, defaultUser: nil)
        let got: Bool = s.getValue(forKey: "feature.on", defaultValue: false)
        XCTAssertTrue(got)
    }

    func testOverrideWinsOverCache() {
        let overrides = FlagOverrides.localOnly(
            MapOverrideDataSource(["feature.on": false]))
        let s = Snapshot(config: sampleConfig(), overrides: overrides, defaultUser: nil)
        let got: Bool = s.getValue(forKey: "feature.on", defaultValue: true)
        XCTAssertFalse(got, "override (false) must beat cache (true)")
    }

    func testGetAllKeysUnionsCacheAndOverrides() {
        let overrides = FlagOverrides.localOnly(
            MapOverrideDataSource(["from-overrides": true]))
        let s = Snapshot(config: sampleConfig(), overrides: overrides, defaultUser: nil)
        let keys = s.getAllKeys()
        XCTAssertTrue(keys.contains("feature.on"))
        XCTAssertTrue(keys.contains("from-overrides"))
        XCTAssertEqual(keys.count, 2)
    }

    func testGetAllKeysHandlesEmptyInputs() {
        let s = Snapshot(config: nil, overrides: nil, defaultUser: nil)
        XCTAssertTrue(s.getAllKeys().isEmpty)
    }

    func testDefaultReturnedWhenTypeMismatch() {
        let s = Snapshot(config: sampleConfig(), overrides: nil, defaultUser: nil)
        // Cached value is Bool; requesting Int returns the supplied default.
        let got: Int = s.getValue(forKey: "feature.on", defaultValue: 42)
        XCTAssertEqual(got, 42)
    }
}
