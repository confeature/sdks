// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for the ``Hooks`` event-emitter (spec 073 / FR-013).
///
/// Mirrors ConfigCat 11.3.1's `Hooks` 1:1 — late-subscription
/// semantics on `onReady`, multi-subscriber fan-out, recursive-lock
/// re-entry safety, and thread-safe concurrent `onFlagEvaluated`
/// invocation.
final class HooksTests: XCTestCase {
    func testFreshHooksHasNoSubscribers() {
        let hooks = Hooks()
        XCTAssertFalse(hooks.hasOnFlagEvaluatedHandlers())
    }

    func testOnReadyFiresOnInvocation() {
        let hooks = Hooks()
        var captured: ClientCacheState?
        hooks.onReady { state in captured = state }
        hooks.invokeOnReady(.hasUpToDateFlagData)
        XCTAssertEqual(captured, .hasUpToDateFlagData)
    }

    func testOnReadyLateSubscriptionFiresImmediately() {
        let hooks = Hooks()
        hooks.invokeOnReady(.hasLocalOverrideFlagDataOnly)

        var captured: ClientCacheState?
        hooks.onReady { state in captured = state }
        XCTAssertEqual(captured, .hasLocalOverrideFlagDataOnly)
    }

    func testOnReadyFiresHandlersOnceAcrossInvocations() {
        let hooks = Hooks()
        var calls = 0
        hooks.onReady { _ in calls += 1 }
        hooks.invokeOnReady(.hasUpToDateFlagData)
        hooks.invokeOnReady(.hasUpToDateFlagData)  // second invocation must be a no-op
        XCTAssertEqual(calls, 1)
    }

    func testOnConfigChangedFiresOnInvocation() {
        let hooks = Hooks()
        var captured: [String: Any]?
        hooks.onConfigChanged { config in captured = config }
        let newConfig: [String: Any] = ["f": ["k": "v"]]
        hooks.invokeOnConfigChanged(newConfig)
        XCTAssertEqual((captured?["f"] as? [String: String])?["k"], "v")
    }

    func testOnFlagEvaluatedFiresOnInvocation() {
        let hooks = Hooks()
        var captured: EvaluationDetails?
        hooks.onFlagEvaluated { details in captured = details }
        XCTAssertTrue(hooks.hasOnFlagEvaluatedHandlers())

        let details = EvaluationDetails(
            key: "k", value: true, variationId: nil, user: nil,
            isDefaultValue: false, error: nil, errorCode: .none,
            fetchTime: Date(timeIntervalSince1970: 0))
        hooks.invokeOnFlagEvaluated(details)
        XCTAssertEqual(captured?.key, "k")
        XCTAssertEqual(captured?.value as? Bool, true)
    }

    func testOnErrorFiresOnInvocation() {
        let hooks = Hooks()
        var captured: String?
        hooks.onError { msg in captured = msg }
        hooks.invokeOnError("boom")
        XCTAssertEqual(captured, "boom")
    }

    func testRecursiveOnErrorDoesNotDeadlock() {
        // An onError handler that triggers another invokeOnError must
        // not deadlock — the NSRecursiveLock + outside-lock invocation
        // pattern guarantees this.
        let hooks = Hooks()
        var calls: [String] = []
        hooks.onError { msg in
            calls.append(msg)
            if msg == "first" {
                hooks.invokeOnError("second")
            }
        }
        hooks.invokeOnError("first")
        XCTAssertEqual(calls, ["first", "second"])
    }

    func testConcurrentOnFlagEvaluatedIsSafe() {
        let hooks = Hooks()
        let counter = AtomicCounter()
        hooks.onFlagEvaluated { _ in counter.increment() }

        let details = EvaluationDetails(
            key: "k", value: true, variationId: nil, user: nil,
            isDefaultValue: false, error: nil, errorCode: .none,
            fetchTime: Date(timeIntervalSince1970: 0))

        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            hooks.invokeOnFlagEvaluated(details)
        }
        XCTAssertEqual(counter.value, 100)
    }

    func testClearRemovesAllHandlers() {
        let hooks = Hooks()
        var calls = 0
        hooks.onReady { _ in calls += 1 }
        hooks.onConfigChanged { _ in calls += 1 }
        hooks.onFlagEvaluated { _ in calls += 1 }
        hooks.onError { _ in calls += 1 }
        hooks.clear()
        hooks.invokeOnConfigChanged([:])
        hooks.invokeOnError("x")
        XCTAssertEqual(calls, 0)
        XCTAssertFalse(hooks.hasOnFlagEvaluatedHandlers())
    }
}

/// Tiny thread-safe counter for `testConcurrentOnFlagEvaluatedIsSafe`.
private final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = 0
    func increment() {
        lock.lock()
        _value += 1
        lock.unlock()
    }
    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }
}
