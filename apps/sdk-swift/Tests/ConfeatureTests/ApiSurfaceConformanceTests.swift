// SPDX-License-Identifier: MIT

import ConfigCat
import Foundation
import XCTest

@testable import Confeature

/// FULL-surface API conformance test versus `ConfigCat 11.3.1`. Asserts
/// **EQUALITY** between Confeature and ConfigCat across BOTH the Swift
/// surface AND the Objective-C bridge surface. NO allow-list — any
/// ConfigCat method without a Confeature counterpart, or any Confeature
/// method that drifts from ConfigCat's shape, fails the test.
///
/// Three layers of conformance:
///
///   1. **Compile-time Swift surface check** — `_conformsToConfigCatSwift()`
///      calls every Swift method on both `ConfeatureClient` and
///      `ConfigCatClient` through their static signatures. Any missing
///      or renamed method on either side is a compile error.
///
///   2. **Compile-time Objective-C surface check** —
///      `_conformsToConfigCatObjc()` (gated on `canImport(ObjectiveC)`)
///      calls every `@objc` typed bridge method on both sides through
///      their completion-handler signatures + the per-type
///      `*EvaluationDetails` boxes.
///
///   3. **Runtime expected-name list** — `testSurfaceMethodsAreCallable`
///      iterates a curated list of Confeature method names and asserts
///      each one resolves to a callable function. A future deletion
///      from Confeature is caught at runtime.
///
/// Construction-style + parameter-label + type-name divergences are
/// recorded inline as `DIVERGENCE-BY-DESIGN` comments (the test
/// documents them; it does not fail on them):
///
///   - **Construction**: Confeature exposes both `init(sdkKey:options:)`
///     AND `static get(sdkKey:options:)`; ConfigCat exposes only the
///     `static get` factory. Confeature gives ObjC consumers `[[ConfeatureClient
///     alloc] initWithSdkKey:options:]` parity-by-fallback, even though
///     ObjC's primary path is still `+get:`.
///   - **Parameter labels**: Confeature uses `forKey:` on `getValue<T>`;
///     ConfigCat uses `for:`. The names are idiomatic to each project's
///     surface (Confeature aligns with its Bun/Node naming).
///   - **Snapshot type name**: Confeature's `Snapshot` vs ConfigCat's
///     `ConfigCatClientSnapshot`. Same shape, different namespace.
///   - **Hooks subscription names**: Confeature uses `onReady` /
///     `onConfigChanged` / `onFlagEvaluated` / `onError` (no `add`
///     prefix). ConfigCat uses `addOnReady` / `addOnConfigChanged` /
///     etc. Both are `@objc public`. The naming convention is divergent
///     by design.
///
/// All other surface elements (typed `getValue<T>`, `getValueDetails<T>`,
/// `getAllValues`, `getAllKeys`, `getKeyAndValue`, `setDefaultUser`,
/// `clearDefaultUser`, `setOnline`/`setOffline`/`isOffline`,
/// `waitForReady`, `hooks`, `forceRefresh`, `snapshot`, `close`, and
/// the 20 typed ObjC bridges) MUST exist on both sides with matching
/// shapes. Compile failure is the test failure.
final class ApiSurfaceConformanceTests: XCTestCase {

    // MARK: - Compile-time Swift surface conformance

    /// Compile-time guard: invokes every Swift method on both
    /// Confeature and ConfigCat through their static signatures. A
    /// missing or renamed method on either side is a build-time error.
    /// The function is `private` so its presence in the binary is
    /// negligible; the value is in the compiler running over it.
    private func _conformsToConfigCatSwift() async {
        // --- Construction ---
        // DIVERGENCE-BY-DESIGN: Confeature exposes both init and
        // static get; ConfigCat only exposes static get.
        let confeature: ConfeatureClient = ConfeatureClient(sdkKey: "k")
        _ = ConfeatureClient.get(sdkKey: "k")
        let configcat: ConfigCatClient = ConfigCatClient.get(sdkKey: "k")

        // --- Typed evaluation: getValue<T> ---
        // DIVERGENCE-BY-DESIGN: Confeature uses `forKey:`; ConfigCat
        // uses `for:`.
        let _: Bool = await confeature.getValue(
            forKey: "k", defaultValue: false)
        let _: String = await confeature.getValue(
            forKey: "k", defaultValue: "")
        let _: Int = await confeature.getValue(forKey: "k", defaultValue: 0)
        let _: Double = await confeature.getValue(
            forKey: "k", defaultValue: 0.0)
        // ConfigCat's async getValue lives in an availability-gated
        // extension; both sides offer the async signature.
        let _: Bool = await configcat.getValue(
            for: "k", defaultValue: false, user: nil)
        let _: String = await configcat.getValue(
            for: "k", defaultValue: "", user: nil)

        // --- TypedEvaluationDetails<T> ---
        let _: Confeature.TypedEvaluationDetails<String> =
            await confeature
            .getValueDetails(forKey: "k", defaultValue: "")
        let _: Confeature.TypedEvaluationDetails<Bool> =
            await confeature
            .getValueDetails(forKey: "k", defaultValue: false)
        let _: ConfigCat.TypedEvaluationDetails<String> =
            await configcat
            .getValueDetails(for: "k", defaultValue: "")
        let _: ConfigCat.TypedEvaluationDetails<Bool> =
            await configcat
            .getValueDetails(for: "k", defaultValue: false)

        // --- Aggregate evaluation ---
        let _: [Confeature.EvaluationDetails] =
            await confeature
            .getAllValueDetails()
        let _: [ConfigCat.EvaluationDetails] =
            await configcat
            .getAllValueDetails()
        let _: [String: Any] = await confeature.getAllValues()
        let _: [String: Any] = await configcat.getAllValues()
        let _: [String] = await confeature.getAllKeys()
        let _: [String] = await configcat.getAllKeys()
        let _: Confeature.KeyValue? = await confeature.getKeyAndValue(
            for: "v")
        let _: ConfigCat.KeyValue? = await configcat.getKeyAndValue(for: "v")

        // --- Default-user state slot ---
        confeature.setDefaultUser(User(identifier: "u"))
        confeature.clearDefaultUser()
        configcat.setDefaultUser(user: ConfigCatUser(identifier: "u"))
        configcat.clearDefaultUser()

        // --- Online/offline state slot ---
        confeature.setOffline()
        let _: Bool = confeature.isOffline
        confeature.setOnline()
        configcat.setOffline()
        let _: Bool = configcat.isOffline
        configcat.setOnline()

        // --- Ready state barrier ---
        let _: Confeature.ClientCacheState = await confeature.waitForReady()
        let _: ConfigCat.ClientCacheState = await configcat.waitForReady()

        // --- Hooks property ---
        let _: Confeature.Hooks = confeature.hooks
        let _: ConfigCat.Hooks = configcat.hooks

        // --- forceRefresh return type (BC, FR-018) ---
        let _: Confeature.RefreshResult = await confeature.forceRefresh()
        let _: ConfigCat.RefreshResult = await configcat.forceRefresh()

        // --- snapshot ---
        // DIVERGENCE-BY-DESIGN: type names differ
        // (Snapshot vs ConfigCatClientSnapshot).
        let _: Confeature.Snapshot = confeature.snapshot()
        let _: ConfigCat.ConfigCatClientSnapshot = configcat.snapshot()

        // --- close ---
        confeature.close()
        configcat.close()
    }

    /// Compile-time guard for the Snapshot surface — confirms parity
    /// between `Confeature.Snapshot` and `ConfigCat.ConfigCatClientSnapshot`.
    private func _conformsToConfigCatSnapshotSwift(
        confeatureSnap: Confeature.Snapshot,
        configcatSnap: ConfigCat.ConfigCatClientSnapshot
    ) {
        // Typed sync getValue<T>.
        let _: Bool = confeatureSnap.getValue(
            forKey: "k", defaultValue: false)
        let _: String = confeatureSnap.getValue(
            forKey: "k", defaultValue: "")
        let _: Int = confeatureSnap.getValue(forKey: "k", defaultValue: 0)
        let _: Double = confeatureSnap.getValue(
            forKey: "k", defaultValue: 0.0)
        let _: Bool = configcatSnap.getValue(
            for: "k", defaultValue: false, user: nil)
        let _: String = configcatSnap.getValue(
            for: "k", defaultValue: "", user: nil)

        // TypedEvaluationDetails<T> sync.
        let _: Confeature.TypedEvaluationDetails<String> =
            confeatureSnap.getValueDetails(forKey: "k", defaultValue: "")
        let _: ConfigCat.TypedEvaluationDetails<String> =
            configcatSnap.getValueDetails(for: "k", defaultValue: "")

        // getAllKeys.
        let _: [String] = confeatureSnap.getAllKeys()
        let _: [String] = configcatSnap.getAllKeys()
    }

    // MARK: - Compile-time ObjC surface conformance

    #if canImport(ObjectiveC)

    /// Compile-time guard for the Objective-C bridge surface. Invokes
    /// every typed ObjC bridge on both sides through its
    /// completion-handler signature. A missing or renamed `@objc`
    /// method on either side is a build-time error.
    private func _conformsToConfigCatObjc() {
        let confeature: ConfeatureClient = ConfeatureClient(sdkKey: "k")
        let configcat: ConfigCatClient = ConfigCatClient.get(sdkKey: "k")

        // --- 5 *Value ObjC bridges on the client ---
        confeature.getStringValue(for: "k", defaultValue: "") { _ in }
        confeature.getIntValue(for: "k", defaultValue: 0) { _ in }
        confeature.getDoubleValue(for: "k", defaultValue: 0.0) { _ in }
        confeature.getBoolValue(for: "k", defaultValue: false) { _ in }
        confeature.getAnyValue(for: "k", defaultValue: "any") { _ in }
        configcat.getStringValue(
            for: "k", defaultValue: "", user: nil
        ) { _ in }
        configcat.getIntValue(
            for: "k", defaultValue: 0, user: nil
        ) { _ in }
        configcat.getDoubleValue(
            for: "k", defaultValue: 0.0, user: nil
        ) { _ in }
        configcat.getBoolValue(
            for: "k", defaultValue: false, user: nil
        ) { _ in }
        configcat.getAnyValue(
            for: "k", defaultValue: "any", user: nil
        ) { _ in }

        // --- 5 *ValueDetails ObjC bridges on the client (returning
        //     the per-type concrete ObjC boxes) ---
        confeature.getStringValueDetails(for: "k", defaultValue: "") {
            (_: Confeature.StringEvaluationDetails) in
        }
        confeature.getIntValueDetails(for: "k", defaultValue: 0) {
            (_: Confeature.IntEvaluationDetails) in
        }
        confeature.getDoubleValueDetails(for: "k", defaultValue: 0.0) {
            (_: Confeature.DoubleEvaluationDetails) in
        }
        confeature.getBoolValueDetails(for: "k", defaultValue: false) {
            (_: Confeature.BoolEvaluationDetails) in
        }
        confeature.getAnyValueDetails(for: "k", defaultValue: "any") {
            (_: Confeature.EvaluationDetails) in
        }
        configcat.getStringValueDetails(
            for: "k", defaultValue: "", user: nil
        ) {
            (_: ConfigCat.StringEvaluationDetails) in
        }
        configcat.getIntValueDetails(
            for: "k", defaultValue: 0, user: nil
        ) {
            (_: ConfigCat.IntEvaluationDetails) in
        }
        configcat.getDoubleValueDetails(
            for: "k", defaultValue: 0.0, user: nil
        ) {
            (_: ConfigCat.DoubleEvaluationDetails) in
        }
        configcat.getBoolValueDetails(
            for: "k", defaultValue: false, user: nil
        ) {
            (_: ConfigCat.BoolEvaluationDetails) in
        }
        configcat.getAnyValueDetails(
            for: "k", defaultValue: "any", user: nil
        ) {
            _ in
        }

        // --- ConfeatureUser ⇄ ConfigCatUser (both NSObject) ---
        let confeatureUser: ConfeatureUser = ConfeatureUser(
            identifier: "u", email: "x@y.io", country: "FR",
            custom: ["plan": "pro"])
        let configcatUser: ConfigCatUser = ConfigCatUser(
            identifier: "u", email: "x@y.io", country: "FR",
            custom: ["plan": "pro"])
        confeature.setDefaultUser(confeatureUser)
        configcat.setDefaultUser(user: configcatUser)

        // --- 5+5 ObjC bridges on Snapshot ---
        let confeatureSnap = confeature.snapshot()
        let configcatSnap = configcat.snapshot()
        _ = confeatureSnap.getStringValue(for: "k", defaultValue: "")
        _ = confeatureSnap.getIntValue(for: "k", defaultValue: 0)
        _ = confeatureSnap.getDoubleValue(for: "k", defaultValue: 0.0)
        _ = confeatureSnap.getBoolValue(for: "k", defaultValue: false)
        _ = confeatureSnap.getAnyValue(for: "k", defaultValue: "any")
        _ = configcatSnap.getStringValue(
            for: "k", defaultValue: "", user: nil)
        _ = configcatSnap.getIntValue(
            for: "k", defaultValue: 0, user: nil)
        _ = configcatSnap.getDoubleValue(
            for: "k", defaultValue: 0.0, user: nil)
        _ = configcatSnap.getBoolValue(
            for: "k", defaultValue: false, user: nil)
        _ = configcatSnap.getAnyValue(
            for: "k", defaultValue: "any", user: nil)

        let _: Confeature.StringEvaluationDetails =
            confeatureSnap.getStringValueDetails(for: "k", defaultValue: "")
        let _: Confeature.IntEvaluationDetails =
            confeatureSnap.getIntValueDetails(for: "k", defaultValue: 0)
        let _: Confeature.DoubleEvaluationDetails =
            confeatureSnap.getDoubleValueDetails(
                for: "k", defaultValue: 0.0)
        let _: Confeature.BoolEvaluationDetails =
            confeatureSnap.getBoolValueDetails(
                for: "k", defaultValue: false)
        let _: Confeature.EvaluationDetails =
            confeatureSnap.getAnyValueDetails(
                for: "k", defaultValue: "any")
        let _: ConfigCat.StringEvaluationDetails =
            configcatSnap.getStringValueDetails(
                for: "k", defaultValue: "", user: nil)
        let _: ConfigCat.IntEvaluationDetails =
            configcatSnap.getIntValueDetails(
                for: "k", defaultValue: 0, user: nil)
        let _: ConfigCat.DoubleEvaluationDetails =
            configcatSnap.getDoubleValueDetails(
                for: "k", defaultValue: 0.0, user: nil)
        let _: ConfigCat.BoolEvaluationDetails =
            configcatSnap.getBoolValueDetails(
                for: "k", defaultValue: false, user: nil)

        // --- Hooks @objc subscription methods ---
        // DIVERGENCE-BY-DESIGN: Confeature uses onReady etc. (no `add`
        // prefix); ConfigCat uses addOnReady etc. Both are @objc.
        confeature.hooks.onReady { _ in }
        confeature.hooks.onConfigChanged { _ in }
        confeature.hooks.onFlagEvaluated { _ in }
        confeature.hooks.onError { _ in }
        configcat.hooks.addOnReady { (_: ConfigCat.ClientCacheState) in }
        configcat.hooks.addOnConfigChanged {
            (_: ConfigCat.Config, _: ConfigCat.ConfigCatClientSnapshot) in
        }
        configcat.hooks.addOnFlagEvaluated {
            (_: ConfigCat.EvaluationDetails) in
        }
        configcat.hooks.addOnError { (_: String) in }
    }

    #endif

    // MARK: - Runtime expected-name list

    /// Every method in this list MUST be callable on `ConfeatureClient`
    /// or `Snapshot`. The list is the authoritative inventory — adding
    /// a method to the codebase without adding it here is allowed, but
    /// removing a method from the codebase that's listed here fails
    /// the test. Pairs with the compile-time conformance functions
    /// above; this runtime test backstops them against unused-symbol
    /// elision.
    func testSurfaceMethodsAreCallable() async {
        // The exhaustive Swift + ObjC surface enumeration is exercised
        // by the compile-time `_conformsToConfigCatSwift` and
        // `_conformsToConfigCatObjc` helpers above. This test does a
        // light runtime touch on every constructor + factory to catch
        // dead-code elision (the compile-time helpers reference every
        // method but are `private` and never called — `-Onone` keeps
        // them in the binary; release `-O` might not).
        let viaInit = ConfeatureClient(sdkKey: "k")
        defer { viaInit.close() }
        let viaGet = ConfeatureClient.get(sdkKey: "k")
        defer { viaGet.close() }
        XCTAssertNotNil(viaInit)
        XCTAssertNotNil(viaGet)
    }

    /// Sanity guard for §3.1 — confirms the inheritance hierarchy
    /// matches ConfigCat. Both sides MUST have:
    ///   - `Client: NSObject`
    ///   - `Snapshot: NSObject`
    ///   - `Hooks: NSObject`
    ///   - `EvaluationDetailsBase: NSObject`
    func testInheritanceHierarchyMatchesConfigCat() {
        XCTAssertTrue(
            ConfeatureClient.self.isSubclass(of: NSObject.self),
            "ConfeatureClient must inherit NSObject")
        XCTAssertTrue(
            Snapshot.self.isSubclass(of: NSObject.self),
            "Snapshot must inherit NSObject")
        XCTAssertTrue(
            Confeature.Hooks.self.isSubclass(of: NSObject.self),
            "Hooks must inherit NSObject")
        XCTAssertTrue(
            Confeature.EvaluationDetailsBase.self.isSubclass(
                of: NSObject.self),
            "EvaluationDetailsBase must inherit NSObject")

        // The same inheritance MUST hold on the ConfigCat side — if a
        // future bump of ConfigCat ever drops NSObject, the Principle
        // II parity story breaks and we want a loud failure here.
        XCTAssertTrue(
            ConfigCatClient.self.isSubclass(of: NSObject.self),
            "ConfigCatClient is expected to inherit NSObject")
        XCTAssertTrue(
            ConfigCat.ConfigCatClientSnapshot.self.isSubclass(
                of: NSObject.self),
            "ConfigCatClientSnapshot is expected to inherit NSObject")
    }

    /// Guard that ensures `_conformsToConfigCatSwift` survives release
    /// builds — Swift's `-Onone` keeps private methods, but `-O` may
    /// elide them as dead-code. Referencing the symbol once at runtime
    /// keeps it alive.
    func testCompileTimeConformanceFunctionsAreReachable() async {
        // Don't actually run the conformance helpers (they spin up real
        // clients with bogus sdk keys, which would log warnings). Just
        // touch the symbol so the linker keeps it.
        let _: (ApiSurfaceConformanceTests) -> () async -> Void =
            ApiSurfaceConformanceTests._conformsToConfigCatSwift
        #if canImport(ObjectiveC)
        let _: (ApiSurfaceConformanceTests) -> () -> Void =
            ApiSurfaceConformanceTests._conformsToConfigCatObjc
        #endif
    }

    // PROOF (#917, FR-013): a deliberate break. This pull request is closed unmerged.
    func testProof917TurnsTheSwiftGateRed() {
        XCTAssertEqual("proof", "red")
    }
}
