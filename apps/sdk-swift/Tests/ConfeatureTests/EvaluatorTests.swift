// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for the four-type v1 evaluator (spec 073 widening).
///
/// Covers the boolean path (`t = 0`) plus the typed paths (`t = 1`
/// string / `t = 2` int / `t = 3` double) and the typed `TYPE_MISMATCH`
/// / `MALFORMED_VALUE` / `UNSUPPORTED_TYPE` (truly unknown `t`)
/// fallback conditions.
final class EvaluatorTests: XCTestCase {
    private func sampleConfig() -> [String: Any] {
        [
            "f": [
                "feature.on": ["t": 0, "v": ["b": true]],
                "feature.off": ["t": 0, "v": ["b": false], "i": "v-off"],
                "feature.string": ["t": 1, "v": ["s": "hello"], "i": "v-str"],
                "feature.int": ["t": 2, "v": ["i": 42], "i": "v-int"],
                "feature.double": ["t": 3, "v": ["d": 3.14], "i": "v-double"],
                "feature.unknown": ["t": 99, "v": ["b": true]],
            ]
        ]
    }

    // MARK: - Boolean path (unchanged behaviour, FR-016)

    func testEvaluatesBooleanTrue() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.on", defaultValue: false)
        XCTAssertEqual(r.value as? Bool, true)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.errorCode, .none)
    }

    func testEvaluatesBooleanFalseWithVariationId() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.off", defaultValue: true)
        XCTAssertEqual(r.value as? Bool, false)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.variationId, "v-off")
    }

    func testMissingKeyReturnsDefaultAndCode() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.absent", defaultValue: true)
        XCTAssertEqual(r.value as? Bool, true)
        XCTAssertEqual(r.error, "KEY_NOT_FOUND")
        XCTAssertEqual(r.errorCode, .settingKeyMissing)
    }

    func testUnsupportedTypeReturnsDefault() {
        // FR-017: UNSUPPORTED_TYPE fires only for a TRULY unknown `t`.
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.unknown", defaultValue: false)
        XCTAssertEqual(r.value as? Bool, false)
        XCTAssertEqual(r.error, "UNSUPPORTED_TYPE")
    }

    func testTypeMismatchWhenDefaultNotBool() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.on", defaultValue: 42)
        XCTAssertEqual(r.value as? Int, 42)
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
        XCTAssertEqual(r.errorCode, .settingValueTypeMismatch)
    }

    func testNoConfigReturnsDefault() {
        let r = Evaluator.evaluate(config: nil, key: "x", defaultValue: false)
        XCTAssertEqual(r.value as? Bool, false)
        XCTAssertEqual(r.error, "NO_CONFIG")
        XCTAssertEqual(r.errorCode, .configJsonNotAvailable)
    }

    func testMalformedConfigMissingF() {
        let r = Evaluator.evaluate(
            config: [:], key: "x", defaultValue: false)
        XCTAssertEqual(r.error, "MALFORMED_CONFIG")
        XCTAssertEqual(r.errorCode, .invalidConfigModel)
    }

    // MARK: - String path (t = 1)

    func testEvaluatesStringValue() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.string", defaultValue: "fallback")
        XCTAssertEqual(r.value as? String, "hello")
        XCTAssertNil(r.error)
        XCTAssertEqual(r.errorCode, .none)
        XCTAssertEqual(r.variationId, "v-str")
    }

    func testStringTypeMismatchWhenDefaultNotString() {
        // String setting, but defaultValue is Int → TYPE_MISMATCH.
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.string", defaultValue: 0)
        XCTAssertEqual(r.value as? Int, 0)
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
        XCTAssertEqual(r.errorCode, .settingValueTypeMismatch)
    }

    func testStringMalformedValueWhenSlotMissing() {
        let cfg: [String: Any] = ["f": ["k": ["t": 1, "v": ["b": true]]]]
        let r = Evaluator.evaluate(config: cfg, key: "k", defaultValue: "fallback")
        XCTAssertEqual(r.value as? String, "fallback")
        XCTAssertEqual(r.error, "MALFORMED_VALUE")
        XCTAssertEqual(r.errorCode, .invalidConfigModel)
    }

    // MARK: - Int path (t = 2)

    func testEvaluatesIntValue() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.int", defaultValue: 0)
        XCTAssertEqual(r.value as? Int, 42)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.errorCode, .none)
        XCTAssertEqual(r.variationId, "v-int")
    }

    func testIntTypeMismatchWhenDefaultIsString() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.int", defaultValue: "fallback")
        XCTAssertEqual(r.value as? String, "fallback")
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
    }

    func testIntTypeMismatchWhenDefaultIsDouble() {
        // FR-003: Double default against t:2 (int) is a TYPE_MISMATCH.
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.int", defaultValue: 1.5)
        XCTAssertEqual(r.value as? Double, 1.5)
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
    }

    func testIntTypeMismatchWhenDefaultIsBool() {
        // Int default that is actually a Bool (Swift quirk) -> still
        // TYPE_MISMATCH because we exclude Bool from the Int path.
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.int", defaultValue: true)
        // Boolean default wins -> default-on-mismatch is the bool.
        XCTAssertEqual(r.value as? Bool, true)
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
    }

    func testIntMalformedValueWhenSlotMissing() {
        let cfg: [String: Any] = ["f": ["k": ["t": 2, "v": ["b": true]]]]
        let r = Evaluator.evaluate(config: cfg, key: "k", defaultValue: 0)
        XCTAssertEqual(r.value as? Int, 0)
        XCTAssertEqual(r.error, "MALFORMED_VALUE")
    }

    // MARK: - Double path (t = 3)

    func testEvaluatesDoubleValue() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.double", defaultValue: 0.0)
        XCTAssertEqual(r.value as? Double, 3.14)
        XCTAssertNil(r.error)
        XCTAssertEqual(r.errorCode, .none)
        XCTAssertEqual(r.variationId, "v-double")
    }

    func testDoubleTypeMismatchWhenDefaultIsString() {
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.double", defaultValue: "fallback")
        XCTAssertEqual(r.value as? String, "fallback")
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
    }

    func testDoubleTypeMismatchWhenDefaultIsInt() {
        // FR-003: Int default against t:3 (double) is a TYPE_MISMATCH.
        let r = Evaluator.evaluate(
            config: sampleConfig(), key: "feature.double", defaultValue: 1)
        XCTAssertEqual(r.value as? Int, 1)
        XCTAssertEqual(r.error, "TYPE_MISMATCH")
    }

    func testDoubleMalformedValueWhenSlotMissing() {
        let cfg: [String: Any] = ["f": ["k": ["t": 3, "v": ["b": true]]]]
        let r = Evaluator.evaluate(config: cfg, key: "k", defaultValue: 0.0)
        XCTAssertEqual(r.value as? Double, 0.0)
        XCTAssertEqual(r.error, "MALFORMED_VALUE")
    }
}
