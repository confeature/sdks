// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Cross-language cache-key fixture gate (FR-010 / SC-003).
///
/// Consumes
/// `packages/test-fixtures-sdk-parity/fixtures/cache-key-fixtures.json`
/// and asserts that the Swift SDK's ``SdkKey/deriveCacheKey(_:)``
/// produces byte-identical output to TS / Python / Go / .NET / Rust /
/// Ruby / PHP / Java for every recorded SDK key.
final class CacheKeyFixturesTests: XCTestCase {
    private struct Fixture: Decodable {
        let sdkKey: String
        let expectedCacheKey: String
    }

    private func loadFixtures() throws -> [Fixture] {
        let data = try Data(contentsOf: WorkspaceRoot.cacheKeyFixturesPath)
        return try JSONDecoder().decode([Fixture].self, from: data)
    }

    func testCrossLanguageCacheKeyFixturesMatch() throws {
        let fixtures = try loadFixtures()
        XCTAssertGreaterThanOrEqual(
            fixtures.count, 5,
            "expected ≥ 5 cache-key fixtures, got \(fixtures.count) — "
                + "regenerate via `pnpm run export:cache-key-fixtures` in "
                + "packages/test-fixtures-sdk-parity/"
        )

        for fixture in fixtures {
            let actual = SdkKey.deriveCacheKey(fixture.sdkKey)
            let redacted = SdkKey.redact(fixture.sdkKey)
            XCTAssertEqual(
                actual,
                fixture.expectedCacheKey,
                "cross-language cache-key drift\n"
                    + "  input (redacted): \(redacted)\n"
                    + "  expected: \(fixture.expectedCacheKey)\n"
                    + "  got:      \(actual)"
            )
        }
    }
}
