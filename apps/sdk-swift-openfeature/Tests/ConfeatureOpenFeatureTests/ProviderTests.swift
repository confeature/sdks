// SPDX-License-Identifier: MIT

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
        let firstProvider = try ConfeatureProvider(client: native)
        let secondProvider = try ConfeatureProvider(client: native)
        let context = ImmutableContext(attributes: [
            "plan": .string("trial"),
            "Identifier": .string("shadow"),
            "targetingKey": .string("another-shadow"),
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
        let identified = secondClient.getBooleanDetails(key: "identity", defaultValue: false)
        XCTAssertTrue(identified.value)
        XCTAssertEqual(identified.variant, "rollout")
        XCTAssertFalse(firstClient.getBooleanValue(key: "identity", defaultValue: true))

        firstProvider.dispose()
        firstProvider.dispose()
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
        let provider = try ConfeatureProvider(client: native)
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

    func testFlatOverridesAreReadOnceAndObjectDoesNotRead() async throws {
        let source = CountedOverrides(["good": true, "bad": 7, "null": NSNull()])
        let native = nativeClient(overrides: FlagOverrides.localOnly(source))
        defer { native.close() }
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: try ConfeatureProvider(client: native))
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
        await api.setProviderAndWait(provider: try ConfeatureProvider(client: cold))
        let fallback = flags.getBooleanDetails(key: "good", defaultValue: true)
        XCTAssertTrue(fallback.value)
        XCTAssertEqual(fallback.errorCode, .providerNotReady)
        XCTAssertEqual(unavailable.reads, 1)
        await api.clearProviderAndWait()
    }

    func testColdRegistrationCompletesAndLazyLoadRequiresAnAsyncProvider() async throws {
        let native = nativeClient()
        defer { native.close() }
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: try ConfeatureProvider(client: native))
        XCTAssertEqual(api.getProviderStatus(), .ready)
        let cold = api.getClient().getBooleanDetails(key: "flag", defaultValue: true)
        XCTAssertTrue(cold.value)
        XCTAssertEqual(cold.errorCode, .providerNotReady)
        await api.clearProviderAndWait()

        let lazy = nativeClient(pollingMode: .defaultLazyLoad)
        defer { lazy.close() }
        XCTAssertThrowsError(try ConfeatureProvider(client: lazy)) { error in
            XCTAssertEqual(
                error as? ConfeatureProvider.InitializationError, .lazyLoadRequiresAsyncEvaluation)
        }
    }

    private func targetingClient() throws -> ConfeatureClient {
        let config = #"""
            {"f":{
                "identity":{"t":0,"v":{"b":false},"i":"base","p":[{"p":100,"v":{"b":true},"i":"rollout"}]},
                "custom":{"t":0,"v":{"b":false},"i":"base","a":"plan","p":[{"p":100,"v":{"b":true},"i":"rollout"}]},
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
