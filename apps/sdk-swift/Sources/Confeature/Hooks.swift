// SPDX-License-Identifier: MIT

import Foundation

/// Event emitter consumed by ``ConfeatureClient`` to publish four
/// lifecycle hooks: ``onReady(_:)`` / ``onConfigChanged(_:)`` /
/// ``onFlagEvaluated(_:)`` / ``onError(_:)``.
///
/// Mirrors ConfigCat 11.3.1's `Hooks`
/// (`Sources/ConfigCat/ConfigCatOptions.swift:63`) 1:1 — `onReady`
/// fires on the first ready-state transition (LocalOnly init / first
/// successful AutoPoll fetch / cache restore for ManualPoll &
/// LazyLoad), and subscribers added AFTER that transition receive the
/// captured state immediately ("late subscription").
///
/// Subscription methods carry `@objc public` so Objective-C consumers
/// can register completion handlers. The handler-list mutation lives
/// inside an `NSRecursiveLock`-guarded critical section; the handler
/// INVOCATION happens OUTSIDE the lock so a handler that triggers
/// another invocation does not deadlock (recursive-lock re-entry only
/// helps for re-entrant subscription, not re-entrant fan-out).
public final class Hooks: NSObject {
    private let lock = NSRecursiveLock()
    private var readyState: ClientCacheState?
    private var onReadyHandlers: [(ClientCacheState) -> Void] = []
    private var onConfigChangedHandlers: [([String: Any]) -> Void] = []
    private var onFlagEvaluatedHandlers: [(EvaluationDetails) -> Void] = []
    private var onErrorHandlers: [(String) -> Void] = []

    public override init() {
        super.init()
    }

    /// Subscribes a handler for the ready-state transition. If the
    /// transition has already fired, the handler is invoked
    /// immediately with the captured state (late-subscription
    /// semantics — matches ConfigCat).
    @objc public func onReady(_ handler: @escaping (ClientCacheState) -> Void) {
        lock.lock()
        if let captured = readyState {
            lock.unlock()
            handler(captured)
            return
        }
        onReadyHandlers.append(handler)
        lock.unlock()
    }

    /// Subscribes a handler for `onConfigChanged` events. The handler
    /// fires whenever the cached `config_v6.json` body's ETag changes.
    @objc public func onConfigChanged(_ handler: @escaping ([String: Any]) -> Void) {
        lock.lock()
        onConfigChangedHandlers.append(handler)
        lock.unlock()
    }

    /// Subscribes a handler for `onFlagEvaluated` events. Fires from
    /// every ``ConfeatureClient/getValue(forKey:defaultValue:user:)``
    /// and ``ConfeatureClient/getValueDetails(forKey:defaultValue:user:)``
    /// call site after the snapshot returns. The client gates on
    /// ``hasOnFlagEvaluatedHandlers()`` for O(1) bypass when no
    /// subscribers are present.
    @objc public func onFlagEvaluated(_ handler: @escaping (EvaluationDetails) -> Void) {
        lock.lock()
        onFlagEvaluatedHandlers.append(handler)
        lock.unlock()
    }

    /// Subscribes a handler for error-level log events.
    @objc public func onError(_ handler: @escaping (String) -> Void) {
        lock.lock()
        onErrorHandlers.append(handler)
        lock.unlock()
    }

    /// Fires the ready transition. Idempotent — subsequent calls are
    /// no-ops (the captured state stays sticky for late subscribers).
    /// Called from ``ConfeatureClient/setReadyState(_:)``.
    internal func invokeOnReady(_ state: ClientCacheState) {
        lock.lock()
        if readyState != nil {
            // Idempotent — already fired.
            lock.unlock()
            return
        }
        readyState = state
        let handlers = onReadyHandlers
        onReadyHandlers.removeAll()
        lock.unlock()
        for handler in handlers { handler(state) }
    }

    /// Fans out a config-changed event. Called from
    /// ``ConfeatureClient/refreshOnce()`` when the new ETag differs
    /// from the cached one.
    internal func invokeOnConfigChanged(_ config: [String: Any]) {
        lock.lock()
        let handlers = onConfigChangedHandlers
        lock.unlock()
        for handler in handlers { handler(config) }
    }

    /// Fans out a flag-evaluated event.
    internal func invokeOnFlagEvaluated(_ details: EvaluationDetails) {
        lock.lock()
        let handlers = onFlagEvaluatedHandlers
        lock.unlock()
        for handler in handlers { handler(details) }
    }

    /// Fans out an error event.
    internal func invokeOnError(_ message: String) {
        lock.lock()
        let handlers = onErrorHandlers
        lock.unlock()
        for handler in handlers { handler(message) }
    }

    /// O(1) check used by ``ConfeatureClient`` to short-circuit
    /// flag-evaluated event construction when no subscribers are
    /// present.
    internal func hasOnFlagEvaluatedHandlers() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !onFlagEvaluatedHandlers.isEmpty
    }

    /// Drops every registered handler. Called from
    /// ``ConfeatureClient/close()``.
    internal func clear() {
        lock.lock()
        onReadyHandlers.removeAll()
        onConfigChangedHandlers.removeAll()
        onFlagEvaluatedHandlers.removeAll()
        onErrorHandlers.removeAll()
        lock.unlock()
    }
}
