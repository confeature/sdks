// SPDX-License-Identifier: MIT

import Foundation
import XCTest

@testable import Confeature

/// ObjC interface guard (FR-022 / FR-029 / SC-011). Asserts that
/// every type the operator chose to expose to Objective-C inherits
/// `NSObject`, that the typed ObjC bridges return the right concrete
/// subclass, and that `Hooks` subscription methods are reachable via
/// the ObjC runtime.
///
/// On non-Apple platforms (`#if !canImport(ObjectiveC)`), the file
/// compiles to a no-op test that logs "ObjC interop skipped". The
/// Swift surface remains identical.
final class ObjcInterfaceTests: XCTestCase {

    #if canImport(ObjectiveC)

    // MARK: - NSObject inheritance

    /// Every type that the all-in-one decision elevated to NSObject
    /// must report `isSubclass(of: NSObject.self) == true`. A future
    /// refactor that drops NSObject (struct conversion, protocol-only,
    /// etc.) would fail here — the intended signal. Uses the runtime
    /// `NSObject.isSubclass(of:)` API rather than the compile-time
    /// `is NSObject.Type` cast (the latter is always-true once the
    /// inheritance is declared, which the compiler then warns about
    /// as "test is always true" — but the value of THIS test is the
    /// negative case: any drop of NSObject inheritance reverses the
    /// boolean).
    func testEveryObjcVisibleTypeInheritsNSObject() {
        let nsObjectClass: AnyClass = NSObject.self
        let types: [(String, AnyClass)] = [
            ("ConfeatureClient", ConfeatureClient.self),
            ("Snapshot", Snapshot.self),
            ("Hooks", Hooks.self),
            ("EvaluationDetailsBase", EvaluationDetailsBase.self),
            ("EvaluationDetails", EvaluationDetails.self),
            ("StringEvaluationDetails", StringEvaluationDetails.self),
            ("BoolEvaluationDetails", BoolEvaluationDetails.self),
            ("IntEvaluationDetails", IntEvaluationDetails.self),
            ("DoubleEvaluationDetails", DoubleEvaluationDetails.self),
            ("KeyValue", KeyValue.self),
            ("RefreshResult", RefreshResult.self),
            ("TargetingRule", TargetingRule.self),
            ("PercentageOption", PercentageOption.self),
            ("ConfeatureUser", ConfeatureUser.self),
        ]
        for (name, cls) in types {
            XCTAssertTrue(
                cls.isSubclass(of: nsObjectClass),
                "\(name) must inherit NSObject (FR-029)")
        }
    }

    // MARK: - ConfeatureUser wrapper

    /// The ObjC wrapper holds the same four fields as the Swift
    /// `User` struct and round-trips back via `coreUser`.
    func testConfeatureUserRoundTripsToCoreUser() {
        let bridge = ConfeatureUser(
            identifier: "u-42", email: "x@y.io", country: "FR",
            custom: ["plan": "pro"])
        XCTAssertEqual(bridge.identifier, "u-42")
        XCTAssertEqual(bridge.email, "x@y.io")
        XCTAssertEqual(bridge.country, "FR")
        XCTAssertEqual(bridge.custom, ["plan": "pro"])

        let core: User = bridge.coreUser
        XCTAssertEqual(core.identifier, "u-42")
        XCTAssertEqual(core.email, "x@y.io")
        XCTAssertEqual(core.country, "FR")
        // `core.custom` is `[String: Any]` (mirrors upstream
        // ConfigCat-iOS `custom: [String: Any]?`), which is not
        // `Equatable`; compare via the same `NSDictionary` value-equality
        // idiom `User: Equatable` itself uses.
        XCTAssertEqual(core.custom as NSDictionary, ["plan": "pro"])

        let lifted = ConfeatureUser.from(core)
        XCTAssertEqual(lifted.identifier, "u-42")
        XCTAssertEqual(lifted.email, "x@y.io")
    }

    /// Optional-friendly factory returns nil when the source is nil.
    func testConfeatureUserFromOptional() {
        let none: User? = nil
        XCTAssertNil(ConfeatureUser.from(none))
        let some: User? = User(identifier: "u-1")
        XCTAssertNotNil(ConfeatureUser.from(some))
    }

    // MARK: - @objc method discoverability (Hooks subscription methods)

    /// Hooks' four subscription methods carry `@objc public`.
    /// `NSStringFromSelector` of their `#selector` lookup returns a
    /// non-empty Objective-C selector string — the proof that the
    /// runtime exposes the method.
    func testHooksSubscriptionMethodsAreObjcVisible() {
        let onReady = NSStringFromSelector(#selector(Hooks.onReady(_:)))
        let onConfigChanged = NSStringFromSelector(#selector(Hooks.onConfigChanged(_:)))
        let onFlagEvaluated = NSStringFromSelector(#selector(Hooks.onFlagEvaluated(_:)))
        let onError = NSStringFromSelector(#selector(Hooks.onError(_:)))
        XCTAssertFalse(onReady.isEmpty)
        XCTAssertFalse(onConfigChanged.isEmpty)
        XCTAssertFalse(onFlagEvaluated.isEmpty)
        XCTAssertFalse(onError.isEmpty)
    }

    // MARK: - 10 ObjC bridges on ConfeatureClient

    /// Each typed `*Value` ObjC bridge on the client returns the
    /// supplied default (the client is empty / no cache) via its
    /// completion handler, and the returned value carries the right
    /// concrete Swift type. The completion-handler shape is what
    /// ObjC callers actually consume.
    func testClientValueBridgesReturnDefaults() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }

        let stringExp = expectation(description: "string")
        client.getStringValue(for: "k", defaultValue: "fallback") { value in
            XCTAssertEqual(value, "fallback")
            stringExp.fulfill()
        }

        let intExp = expectation(description: "int")
        client.getIntValue(for: "k", defaultValue: 42) { value in
            XCTAssertEqual(value, 42)
            intExp.fulfill()
        }

        let doubleExp = expectation(description: "double")
        client.getDoubleValue(for: "k", defaultValue: 1.5) { value in
            XCTAssertEqual(value, 1.5)
            doubleExp.fulfill()
        }

        let boolExp = expectation(description: "bool")
        client.getBoolValue(for: "k", defaultValue: true) { value in
            XCTAssertTrue(value)
            boolExp.fulfill()
        }

        let anyExp = expectation(description: "any")
        client.getAnyValue(for: "k", defaultValue: "anything") { value in
            XCTAssertEqual(value as? String, "anything")
            anyExp.fulfill()
        }

        wait(
            for: [stringExp, intExp, doubleExp, boolExp, anyExp],
            timeout: 5.0)
    }

    /// Each typed `*ValueDetails` ObjC bridge on the client returns
    /// the right concrete per-type subclass (the ObjC equivalent of
    /// `TypedEvaluationDetails<T>`).
    func testClientValueDetailsBridgesReturnPerTypeSubclass() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }

        let stringExp = expectation(description: "string-details")
        client.getStringValueDetails(for: "k", defaultValue: "fallback") {
            details in
            XCTAssertTrue(type(of: details) == StringEvaluationDetails.self)
            XCTAssertEqual(details.value, "fallback")
            XCTAssertTrue(details.isDefaultValue)
            stringExp.fulfill()
        }

        let intExp = expectation(description: "int-details")
        client.getIntValueDetails(for: "k", defaultValue: 99) { details in
            XCTAssertTrue(type(of: details) == IntEvaluationDetails.self)
            XCTAssertEqual(details.value, 99)
            intExp.fulfill()
        }

        let doubleExp = expectation(description: "double-details")
        client.getDoubleValueDetails(for: "k", defaultValue: 0.5) {
            details in
            XCTAssertTrue(type(of: details) == DoubleEvaluationDetails.self)
            XCTAssertEqual(details.value, 0.5)
            doubleExp.fulfill()
        }

        let boolExp = expectation(description: "bool-details")
        client.getBoolValueDetails(for: "k", defaultValue: false) {
            details in
            XCTAssertTrue(type(of: details) == BoolEvaluationDetails.self)
            XCTAssertFalse(details.value)
            boolExp.fulfill()
        }

        let anyExp = expectation(description: "any-details")
        client.getAnyValueDetails(for: "k", defaultValue: "any") {
            details in
            // `getAnyValueDetails` returns the non-generic
            // `EvaluationDetails` directly (no per-type box).
            XCTAssertTrue(type(of: details) == EvaluationDetails.self)
            XCTAssertEqual(details.value as? String, "any")
            anyExp.fulfill()
        }

        wait(
            for: [stringExp, intExp, doubleExp, boolExp, anyExp],
            timeout: 5.0)
    }

    /// The client bridges accept a `ConfeatureUser?` and forward it
    /// to the evaluator — the same evaluation path the Swift surface
    /// uses. With no user, the default value still comes back.
    func testClientBridgeAcceptsConfeatureUser() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }

        let user = ConfeatureUser(identifier: "u-7", email: "a@b.io")
        let exp = expectation(description: "user-bridge")
        client.getStringValue(for: "k", defaultValue: "default", user: user) {
            value in
            XCTAssertEqual(value, "default")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
    }

    // MARK: - 10 ObjC bridges on Snapshot

    /// Each typed `*Value` ObjC bridge on the snapshot returns the
    /// supplied default synchronously (no cache, no overrides). The
    /// returned value carries the right concrete Swift type.
    func testSnapshotValueBridgesReturnDefaults() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }
        let snap = client.snapshot()

        XCTAssertEqual(snap.getStringValue(for: "k", defaultValue: "s"), "s")
        XCTAssertEqual(snap.getIntValue(for: "k", defaultValue: 7), 7)
        XCTAssertEqual(snap.getDoubleValue(for: "k", defaultValue: 2.0), 2.0)
        XCTAssertTrue(snap.getBoolValue(for: "k", defaultValue: true))
        XCTAssertEqual(
            snap.getAnyValue(for: "k", defaultValue: "any") as? String, "any")
    }

    /// Each typed `*ValueDetails` ObjC bridge on the snapshot returns
    /// the right concrete per-type subclass.
    func testSnapshotValueDetailsBridgesReturnPerTypeSubclass() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }
        let snap = client.snapshot()

        let stringDetails = snap.getStringValueDetails(
            for: "k", defaultValue: "s")
        XCTAssertTrue(
            type(of: stringDetails) == StringEvaluationDetails.self)
        XCTAssertEqual(stringDetails.value, "s")

        let intDetails = snap.getIntValueDetails(for: "k", defaultValue: 11)
        XCTAssertTrue(type(of: intDetails) == IntEvaluationDetails.self)
        XCTAssertEqual(intDetails.value, 11)

        let doubleDetails = snap.getDoubleValueDetails(
            for: "k", defaultValue: 3.14)
        XCTAssertTrue(
            type(of: doubleDetails) == DoubleEvaluationDetails.self)
        XCTAssertEqual(doubleDetails.value, 3.14)

        let boolDetails = snap.getBoolValueDetails(
            for: "k", defaultValue: false)
        XCTAssertTrue(type(of: boolDetails) == BoolEvaluationDetails.self)
        XCTAssertFalse(boolDetails.value)

        let anyDetails = snap.getAnyValueDetails(for: "k", defaultValue: "x")
        XCTAssertTrue(type(of: anyDetails) == EvaluationDetails.self)
        XCTAssertEqual(anyDetails.value as? String, "x")
    }

    /// The snapshot bridges accept a `ConfeatureUser?` parameter.
    func testSnapshotBridgeAcceptsConfeatureUser() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }
        let snap = client.snapshot()
        let user = ConfeatureUser(identifier: "u-9")
        let value = snap.getStringValue(
            for: "k", defaultValue: "default", user: user)
        XCTAssertEqual(value, "default")
    }

    // MARK: - setDefaultUser ObjC overload

    /// `setDefaultUser(_ user: ConfeatureUser)` is the ObjC-callable
    /// form of the Swift `setDefaultUser(_ user: User)` overload.
    /// Subsequent evaluations with `user: nil` see the captured
    /// default user.
    func testSetDefaultUserViaObjcOverloadForwardsToCore() {
        let client = makeEmptyLocalOnlyClient()
        defer { client.close() }
        let bridge = ConfeatureUser(identifier: "u-default")
        client.setDefaultUser(bridge)
        // Just confirm the call compiles and does not throw — the
        // semantic guarantee is exercised by `DefaultUserTests`.
    }

    // MARK: - Helpers

    /// Builds a LocalOnly client with no overrides — every
    /// evaluation falls back to the supplied default.
    private func makeEmptyLocalOnlyClient() -> ConfeatureClient {
        let overrides = FlagOverrides(
            dataSource: MapOverrideDataSource([:]),
            behaviour: .localOnly
        )
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            flagOverrides: overrides
        )
        return ConfeatureClient(sdkKey: "test-sdk-key", options: options)
    }

    #else  // !canImport(ObjectiveC)

    func testObjcInteropSkippedOnNonApplePlatform() {
        // `@objc` annotations compile to no-ops on Linux / Windows;
        // the Swift surface remains identical. Nothing to assert.
        print("ObjC interop skipped (non-Apple platform)")
    }

    #endif
}
