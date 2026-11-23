// SPDX-License-Identifier: MIT

import Combine
import Confeature
import ConfeatureOpenFeature
import Foundation
import OpenFeature
import XCTest

final class ProviderTests: XCTestCase {
    private static let key =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    func testBorrowedClientIgnoresNativeDefaultUserAndKeepsContextsIsolated() async throws {
        let native = try targetingClient()
        defer { native.close() }
        let first = OpenFeatureAPI()
        let second = OpenFeatureAPI()
        let firstProvider = ConfeatureProvider(client: native)
        let secondProvider = ConfeatureProvider(client: native)
        let context = ImmutableContext(attributes: [
            "plan": .string("trial"),
            "Identifier": .string("shadow"),
            "targetingKey": .string("another-shadow"),
            "targeting_key": .string("ordinary-custom-attribute"),
        ])
        await first.setProviderAndWait(provider: firstProvider, initialContext: context)
        await second.setProviderAndWait(
            provider: secondProvider, initialContext: ImmutableContext(targetingKey: "subject"))

        let firstClient = first.getClient()
        let secondClient = second.getClient()
        let missing = firstClient.getBooleanDetails(key: "identity", defaultValue: false)
        XCTAssertFalse(missing.value)
        XCTAssertEqual(missing.variant, "base")
        XCTAssertNil(missing.errorCode)
        let custom = firstClient.getBooleanDetails(key: "custom", defaultValue: true)
        XCTAssertTrue(custom.value)
        XCTAssertEqual(custom.variant, "rollout")
        XCTAssertEqual(custom.reason, Reason.split.rawValue)
        XCTAssertTrue(firstClient.getBooleanValue(key: "snakeCaseAttribute", defaultValue: false))
        let identified = secondClient.getBooleanDetails(key: "identity", defaultValue: false)
        XCTAssertTrue(identified.value)
        XCTAssertEqual(identified.variant, "rollout")
        XCTAssertFalse(firstClient.getBooleanValue(key: "identity", defaultValue: true))

        await first.setEvaluationContextAndWait(
            evaluationContext: ImmutableContext(targetingKey: "first-subject"))
        XCTAssertTrue(firstClient.getBooleanValue(key: "identity", defaultValue: false))
        await first.setEvaluationContextAndWait(evaluationContext: ImmutableContext())
        XCTAssertFalse(firstClient.getBooleanValue(key: "identity", defaultValue: true))

        firstProvider.dispose()
        firstProvider.dispose()
        let disposed = firstClient.getBooleanDetails(key: "identity", defaultValue: true)
        XCTAssertTrue(disposed.value)
        XCTAssertEqual(disposed.errorCode, .providerNotReady)
        await first.clearProviderAndWait()
        let nativeValue = await native.getValue(forKey: "identity", defaultValue: false)
        XCTAssertTrue(nativeValue)
        XCTAssertTrue(secondClient.getBooleanValue(key: "identity", defaultValue: false))
        secondProvider.dispose()
        await second.clearProviderAndWait()
    }

    func testTypedEvaluationUsesEstablishedVariantAndTypedFallback() async throws {
        let native = try targetingClient()
        defer { native.close() }
        let api = OpenFeatureAPI()
        let provider = ConfeatureProvider(client: native)
        let context = ImmutableContext(attributes: ["plan": .string("trial")])
        await api.setProviderAndWait(provider: provider, initialContext: context)
        let flags = api.getClient()

        let text = flags.getStringDetails(key: "string", defaultValue: "configured")
        XCTAssertEqual(text.value, "configured")
        XCTAssertEqual(text.reason, Reason.targetingMatch.rawValue)
        XCTAssertNil(text.variant)
        XCTAssertNil(text.errorCode)
        XCTAssertEqual(flags.getIntegerDetails(key: "integer", defaultValue: 7).variant, "seven")
        XCTAssertEqual(flags.getDoubleDetails(key: "double", defaultValue: 0.5).variant, "half")

        let missing = flags.getIntegerDetails(key: "missing", defaultValue: Int64.max)
        XCTAssertEqual(missing.value, Int64.max)
        XCTAssertEqual(missing.errorCode, .flagNotFound)
        let wrong = flags.getBooleanDetails(key: "integer", defaultValue: true)
        XCTAssertTrue(wrong.value)
        XCTAssertEqual(wrong.errorCode, .typeMismatch)
        let objectFallback = Value.structure(["fallback": .boolean(true)])
        let object = flags.getObjectDetails(key: "integer", defaultValue: objectFallback)
        XCTAssertEqual(object.value, objectFallback)
        XCTAssertEqual(object.errorCode, .typeMismatch)

        native.close()
        let closed = flags.getStringDetails(key: "string", defaultValue: "closed")
        XCTAssertEqual(closed.value, "closed")
        XCTAssertEqual(closed.errorCode, .providerNotReady)
        await api.clearProviderAndWait()
    }

    func testFlatOverridesAreReadOnceAndObjectDoesNotRead() async {
        let source = CountedOverrides(["good": true, "bad": 7, "null": NSNull()])
        let native = nativeClient(overrides: FlagOverrides.localOnly(source))
        defer { native.close() }
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: ConfeatureProvider(client: native))
        let flags = api.getClient()
        XCTAssertEqual(source.reads, 0)
        XCTAssertNil(flags.getBooleanDetails(key: "good", defaultValue: true).errorCode)
        XCTAssertEqual(
            flags.getBooleanDetails(key: "bad", defaultValue: true).errorCode, .typeMismatch)
        XCTAssertEqual(flags.getBooleanDetails(key: "null", defaultValue: true).errorCode, .general)
        XCTAssertEqual(
            flags.getBooleanDetails(key: "absent", defaultValue: true).errorCode, .flagNotFound)
        XCTAssertEqual(
            flags.getObjectDetails(key: "good", defaultValue: .null).errorCode, .typeMismatch)
        XCTAssertEqual(source.reads, 4)

        let unavailable = CountedOverrides(nil)
        let cold = nativeClient(overrides: FlagOverrides.localOnly(unavailable))
        defer { cold.close() }
        await api.setProviderAndWait(provider: ConfeatureProvider(client: cold))
        let fallback = flags.getBooleanDetails(key: "good", defaultValue: true)
        XCTAssertTrue(fallback.value)
        XCTAssertEqual(fallback.errorCode, .providerNotReady)
        XCTAssertEqual(unavailable.reads, 1)
        await api.clearProviderAndWait()
    }

    func testColdManualPollAndLazyLoadReturnCallerFallback() async {
        for mode in [PollingMode.manualPoll, .defaultLazyLoad] {
            let native = nativeClient(pollingMode: mode)
            defer { native.close() }
            let api = OpenFeatureAPI()
            await api.setProviderAndWait(provider: ConfeatureProvider(client: native))
            XCTAssertEqual(api.getProviderStatus(), .ready)
            let cold = api.getClient().getBooleanDetails(key: "flag", defaultValue: true)
            XCTAssertTrue(cold.value)
            XCTAssertEqual(cold.errorCode, .providerNotReady)
            await api.clearProviderAndWait()
        }
    }

    func testFoundationNumbersKeepTheirOverrideTypes() async {
        let source = CountedOverrides([
            "integer": NSNumber(value: 1),
            "double": NSNumber(value: 7.0),
            "boolean": NSNumber(value: false),
        ])
        let native = nativeClient(overrides: .localOnly(source))
        defer { native.close() }
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: ConfeatureProvider(client: native))
        let flags = api.getClient()
        XCTAssertEqual(
            flags.getBooleanDetails(key: "integer", defaultValue: false).errorCode, .typeMismatch)
        XCTAssertEqual(
            flags.getDoubleDetails(key: "integer", defaultValue: 42.5).errorCode, .typeMismatch)
        XCTAssertEqual(
            flags.getIntegerDetails(key: "double", defaultValue: 42).errorCode, .typeMismatch)
        XCTAssertEqual(flags.getIntegerDetails(key: "integer", defaultValue: 42).value, 1)
        XCTAssertEqual(flags.getDoubleDetails(key: "double", defaultValue: 42.5).value, 7.0)
        XCTAssertFalse(flags.getBooleanDetails(key: "boolean", defaultValue: true).value)
        XCTAssertEqual(source.reads, 6)
        await api.clearProviderAndWait()
    }

    func testProviderErrorsAndEventsDoNotExposeNativeDataOrContext() async {
        let native = nativeClient(
            overrides: .fromConfig([
                "f": ["malformed": ["t": 1, "v": ["not-a-string-slot": "private-body-sentinel"]]]
            ]))
        defer { native.close() }
        var nativeEvaluations = 0
        native.hooks.onFlagEvaluated { _ in nativeEvaluations += 1 }
        let api = OpenFeatureAPI()
        let provider = ConfeatureProvider(client: native)
        let ready = expectation(description: "Provider publishes one sanitized ready event")
        let subscription = provider.observe().sink { event in
            if case .ready(let details) = event {
                XCTAssertNil(details)
                ready.fulfill()
            }
        }
        defer { subscription.cancel() }
        let context = ImmutableContext(
            targetingKey: "private-user-sentinel",
            structure:
                ImmutableStructure(attributes: ["private": .string("private-context-sentinel")]))
        await api.setProviderAndWait(provider: provider, initialContext: context)
        await fulfillment(of: [ready], timeout: 2)
        let flags = api.getClient()
        let missing = flags.getStringDetails(key: "private-key-sentinel", defaultValue: "fallback")
        let malformed = flags.getStringDetails(key: "malformed", defaultValue: "fallback")
        XCTAssertEqual(missing.errorCode, .flagNotFound)
        XCTAssertEqual(malformed.errorCode, .general)
        for result in [missing, malformed] {
            XCTAssertEqual(result.value, "fallback")
            XCTAssertFalse(result.errorMessage?.contains("private-") ?? true)
        }
        XCTAssertEqual(nativeEvaluations, 0)
        let nativeResult = await native.getValueDetails(
            forKey: "malformed", defaultValue: "fallback")
        XCTAssertTrue(nativeResult.isDefaultValue)
        XCTAssertEqual(nativeEvaluations, 1)
        provider.dispose()
        await api.clearProviderAndWait()
    }

    private func targetingClient() throws -> ConfeatureClient {
        let config = #"""
            {"f":{
                "identity":{"t":0,"v":{"b":false},"i":"base","p":[{"p":100,"v":{"b":true},"i":"rollout"}]},
                "custom":{"t":0,"v":{"b":false},"i":"base","a":"plan","p":[{"p":100,"v":{"b":true},"i":"rollout"}]},
                "snakeCaseAttribute":{"t":0,"v":{"b":false},"a":"targeting_key","p":[{"p":100,"v":{"b":true}}]},
                "integer":{"t":2,"v":{"i":7},"i":"seven"},
                "double":{"t":3,"v":{"d":0.5},"i":"half"},
                "string":{"t":1,"v":{"s":"base"},"i":"base",
                    "r":[{"c":[{"u":{"a":"plan","c":28,"s":"trial"}}],"s":{"v":{"s":"configured"}}}]}
            }}
            """#
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(config.utf8)) as? [String: Any])
        return nativeClient(
            overrides: .fromConfig(parsed), user: User(identifier: "native-default"))
    }

    private func nativeClient(
        pollingMode: PollingMode = .manualPoll, overrides: FlagOverrides? = nil, user: User? = nil
    ) -> ConfeatureClient {
        ConfeatureClient(
            sdkKey: Self.key,
            options: ConfeatureClientOptions(
                pollingMode: pollingMode, cacheDirectory: CacheDirectorySentinel.memory,
                logger: NoOpLogger(), flagOverrides: overrides, defaultUser: user))
    }
}

private final class CountedOverrides: OverrideDataSource, @unchecked Sendable {
    private let lock = NSLock()
    private let values: [String: Any]?
    private var count = 0

    init(_ values: [String: Any]?) { self.values = values }

    var reads: Int { lock.withLock { count } }

    func getOverridesSync() -> [String: Any]? {
        lock.withLock {
            count += 1
            return values
        }
    }
}
