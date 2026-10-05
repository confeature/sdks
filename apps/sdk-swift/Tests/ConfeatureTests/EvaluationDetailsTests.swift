// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Tests for ``ConfeatureClient/getValueDetails(forKey:defaultValue:user:)``
/// + ``ConfeatureClient/getAllValueDetails(user:)`` (spec 073).
final class EvaluationDetailsTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private func makeClient(overrides: [String: Any]) -> ConfeatureClient {
        let bundle = FlagOverrides.localOnly(MapOverrideDataSource(overrides))
        var options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: bundle
        )
        options.requestTimeout = 5
        return ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)
    }

    func testHappyPathReturnsTypedDetailsForString() async {
        let client = makeClient(overrides: ["feature.label": "hello"])
        let d: TypedEvaluationDetails<String> = await client.getValueDetails(
            forKey: "feature.label", defaultValue: "fallback")
        XCTAssertEqual(d.value, "hello")
        XCTAssertEqual(d.key, "feature.label")
        XCTAssertFalse(d.isDefaultValue)
        XCTAssertNil(d.error)
        XCTAssertEqual(d.errorCode, .none)
        XCTAssertNil(d.matchedTargetingRule)
        XCTAssertNil(d.matchedPercentageOption)
        client.close()
    }

    func testMissingKeyReturnsDefaultWithSettingKeyMissing() async {
        // No override for the key → falls through to evaluator → no
        // cache → NO_CONFIG. (LocalOnly mode returns nil from the
        // override path for missing keys, then the evaluator path
        // executes against an empty cache.)
        let client = makeClient(overrides: ["other.key": true])
        let d: TypedEvaluationDetails<String> = await client.getValueDetails(
            forKey: "feature.missing", defaultValue: "fallback")
        XCTAssertEqual(d.value, "fallback")
        XCTAssertTrue(d.isDefaultValue)
        // LocalOnly + no cache → NO_CONFIG, errorCode == configJsonNotAvailable.
        XCTAssertNotNil(d.error)
        client.close()
    }

    func testGetAllValueDetailsReturnsOneEntryPerKey() async {
        let client = makeClient(overrides: [
            "feature.a": true,
            "feature.b": "hello",
        ])
        let details = await client.getAllValueDetails()
        XCTAssertEqual(details.count, 2)
        let keys = Set(details.map { $0.key })
        XCTAssertEqual(keys, ["feature.a", "feature.b"])
        client.close()
    }

    func testGetValueDetailsAfterCloseReturnsErrorEnvelope() async {
        let client = makeClient(overrides: ["k": true])
        client.close()
        let d: TypedEvaluationDetails<Bool> = await client.getValueDetails(
            forKey: "k", defaultValue: false)
        XCTAssertTrue(d.isDefaultValue)
        XCTAssertEqual(d.value, false)
    }
}
