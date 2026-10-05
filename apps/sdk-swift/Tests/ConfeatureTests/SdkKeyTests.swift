// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``SdkKey`` — cache-key derivation, redaction, and
/// format validation. The cross-language fixture sweep is in
/// `CacheKeyFixturesTests.swift`.
final class SdkKeyTests: XCTestCase {
    private static let canonicalKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /// A ConfigCat-shaped key (#802), same synthetic value as the
    /// shared `sdk-key-shapes.json` / `cache-key-fixtures.json` row.
    private static let configCatShapedKey =
        "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"

    func testDeriveCacheKeyMatchesCanonicalFixture() {
        let actual = SdkKey.deriveCacheKey(Self.canonicalKey)
        XCTAssertEqual(actual, "confeature:cache:v1:bIg57I9_4ya_LRRpZZ8qZdn_gXPqQ1aY")
    }

    func testDeriveCacheKeyEmptyInput() {
        XCTAssertEqual(
            SdkKey.deriveCacheKey(""),
            "confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM"
        )
    }

    func testCacheKeyTailStripsPrefix() {
        XCTAssertEqual(SdkKey.cacheKeyTail("confeature:cache:v1:abc"), "abc")
        XCTAssertEqual(SdkKey.cacheKeyTail("no-colon"), "no-colon")
    }

    func testRedactEmptyReturnsMarker() {
        XCTAssertEqual(SdkKey.redact(""), "[redacted]")
    }

    func testRedactShortReturnsMarker() {
        XCTAssertEqual(SdkKey.redact("short"), "[redacted]")
    }

    func testRedactLongKeepsHeadAndTail() {
        let key = Self.canonicalKey
        let out = SdkKey.redact(key)
        let visible = key.count / 10
        XCTAssertTrue(out.hasPrefix(String(key.prefix(visible))))
        XCTAssertTrue(out.hasSuffix(String(key.suffix(visible))))
        XCTAssertTrue(out.contains("[redacted]"))
        // The masked middle section must NOT contain the secret payload.
        let middleStart = key.index(key.startIndex, offsetBy: 20)
        let middleEnd = key.index(key.startIndex, offsetBy: 40)
        XCTAssertFalse(out.contains(key[middleStart..<middleEnd]))
    }

    func testRedactConfigCatShapedKeyShowsNoMoreThanSixSecretChars() {
        let key = Self.configCatShapedKey
        let out = SdkKey.redact(key)
        // 61 chars → 6 visible at each end: the head is all public
        // prefix, the tail is the last 6 secret chars of segment two.
        XCTAssertEqual(out, "config…[redacted]…A5bC7d")
        let segments = key.split(separator: "/")
        XCTAssertEqual(segments.count, 3)
        XCTAssertFalse(out.contains(segments[1].prefix(7)))
        XCTAssertFalse(out.contains(segments[2].prefix(7)))
        XCTAssertFalse(out.contains(key))
    }

    func testIsValidFormatAcceptsCanonical() {
        XCTAssertTrue(SdkKey.isValidConfeatureKeyFormat(Self.canonicalKey))
    }

    func testIsValidFormatRejectsEmptyAndShort() {
        XCTAssertFalse(SdkKey.isValidConfeatureKeyFormat(""))
        XCTAssertFalse(SdkKey.isValidConfeatureKeyFormat("confeature-sdk-1-"))
        XCTAssertFalse(SdkKey.isValidConfeatureKeyFormat("configcat-sdk-1/"))
        XCTAssertFalse(SdkKey.isValidConfeatureKeyFormat("configcat-sdk-1-test-key"))
    }

    // MARK: - Shared accept/reject list (#802, FR-006b)

    private struct KeyShapes: Decodable {
        struct Case: Decodable {
            let name: String
            let key: String
        }
        let valid: [Case]
        let invalid: [Case]
    }

    private func loadKeyShapes() throws -> KeyShapes {
        let data = try Data(contentsOf: WorkspaceRoot.sdkKeyShapesPath)
        return try JSONDecoder().decode(KeyShapes.self, from: data)
    }

    func testSharedKeyShapesValidAreAccepted() throws {
        let shapes = try loadKeyShapes()
        XCTAssertFalse(shapes.valid.isEmpty, "sdk-key-shapes.json: no valid cases")
        for shape in shapes.valid {
            XCTAssertTrue(
                SdkKey.isValidConfeatureKeyFormat(shape.key),
                "valid shape rejected: \(shape.name) (\(SdkKey.redact(shape.key)))")
        }
    }

    func testSharedKeyShapesInvalidAreRejected() throws {
        let shapes = try loadKeyShapes()
        XCTAssertFalse(shapes.invalid.isEmpty, "sdk-key-shapes.json: no invalid cases")
        for shape in shapes.invalid {
            XCTAssertFalse(
                SdkKey.isValidConfeatureKeyFormat(shape.key),
                "invalid shape accepted: \(shape.name) (\(SdkKey.redact(shape.key)))")
        }
    }
}
