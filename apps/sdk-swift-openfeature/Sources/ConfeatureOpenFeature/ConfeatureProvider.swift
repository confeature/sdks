// SPDX-License-Identifier: MIT

import Combine
@_spi(OpenFeature) import Confeature
import Foundation
import OpenFeature

/// Resolves flags from the current snapshot of a borrowed Confeature client.
/// Applications refresh LazyLoad clients through a native asynchronous read or `forceRefresh()`.
/// Create a separate provider for each OpenFeature API instance.
public final class ConfeatureProvider: FeatureProvider {
    private struct Metadata: ProviderMetadata {
        let name: String? = "Confeature"
    }

    private let client: ConfeatureClient
    private let tracker = ProviderStatusTracker()
    private let lifecycle = NSLock()
    private var disposed = false
    public let metadata: ProviderMetadata = Metadata()
    public let hooks: [any Hook] = []

    public init(client: ConfeatureClient) {
        self.client = client
    }

    public var status: ProviderStatus { tracker.status }

    public func observe() -> AnyPublisher<ProviderEvent, Never> { tracker.observe() }

    public func initialize(initialContext: EvaluationContext?) -> Future<Void, Never> {
        Future { [self] promise in
            lifecycle.withLock {
                tracker.send(disposed ? .error(nil) : .ready(nil))
            }
            promise(.success(()))
        }
    }

    public func onContextSet(
        oldContext: EvaluationContext?, newContext: EvaluationContext
    ) -> Future<Void, Never> {
        Future { $0(.success(())) }
    }

    /// Stops provider evaluations. The application continues to own the SDK client.
    public func dispose() {
        lifecycle.withLock {
            guard !disposed else { return }
            disposed = true
            tracker.send(.error(nil))
        }
    }

    public func getBooleanEvaluation(
        key: String, defaultValue: Bool, context: EvaluationContext?
    ) throws
        -> ProviderEvaluation<Bool>
    {
        try resolve(key, defaultValue: defaultValue, context: context)
    }

    public func getStringEvaluation(
        key: String, defaultValue: String, context: EvaluationContext?
    ) throws
        -> ProviderEvaluation<String>
    {
        try resolve(key, defaultValue: defaultValue, context: context)
    }

    public func getIntegerEvaluation(
        key: String, defaultValue: Int64, context: EvaluationContext?
    ) throws
        -> ProviderEvaluation<Int64>
    {
        // Native evaluation uses Swift Int. On failure the official client
        // supplies its original Int64 default without converting it.
        let result = try resolve(key, defaultValue: Int(0), context: context)
        return ProviderEvaluation(
            value: Int64(result.value), variant: result.variant, reason: result.reason)
    }

    public func getDoubleEvaluation(
        key: String, defaultValue: Double, context: EvaluationContext?
    ) throws
        -> ProviderEvaluation<Double>
    {
        try resolve(key, defaultValue: defaultValue, context: context)
    }

    public func getObjectEvaluation(
        key: String, defaultValue: Value, context: EvaluationContext?
    ) throws
        -> ProviderEvaluation<Value>
    {
        throw OpenFeatureError.typeMismatchError
    }

    private func resolve<T>(
        _ key: String, defaultValue: T, context: EvaluationContext?
    ) throws -> ProviderEvaluation<T> {
        guard !lifecycle.withLock({ disposed }) else {
            throw OpenFeatureError.providerNotReadyError
        }
        let user = ContextAttributes(context)
        let result = client.evaluateCachedFlag(
            forKey: key, defaultValue: defaultValue, identifier: user.identifier,
            email: user.email, country: user.country, attributes: user.custom)
        switch result.errorCode {
        case .none:
            return ProviderEvaluation(
                value: result.value, variant: result.variationId,
                reason: reason(for: result.match).rawValue)
        case .settingKeyMissing: throw OpenFeatureError.flagNotFoundError(key: "<unavailable>")
        case .settingValueTypeMismatch: throw OpenFeatureError.typeMismatchError
        case .configJsonNotAvailable: throw OpenFeatureError.providerNotReadyError
        default:
            throw OpenFeatureError.generalError(message: "Confeature could not evaluate the flag.")
        }
    }

    private func reason(for match: CachedEvaluationMatch) -> Reason {
        switch match {
        case .unmatched: return .unknown
        case .targetingRule: return .targetingMatch
        case .percentageOption: return .split
        }
    }
}
