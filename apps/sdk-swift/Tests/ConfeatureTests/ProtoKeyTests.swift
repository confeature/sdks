// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// #826 — ConfigCat reserves no setting key, so the api serves `__proto__`
/// as an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
/// settings into a plain object; this holds the Swift SDK to keeping it from
/// the served bytes and from a local override.
final class ProtoKeyTests: XCTestCase {
    private static let testSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private static let served =
        "{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"},"
        + "\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}"

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    func testAServedProtoFlagReturnsItsServedValue() async {
        MockURLProtocol.handler = { _ in
            MockResponse(statusCode: 200, headers: ["ETag": "v1"], body: Self.served)
        }
        let session = URLSessionConfiguration.ephemeral
        session.protocolClasses = [MockURLProtocol.self]
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: URLSession(configuration: session)
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        _ = await client.forceRefresh()
        let got = await client.getValue(forKey: "__proto__", defaultValue: false)
        XCTAssertTrue(got, "__proto__ must resolve to its served value, not the default")
    }

    func testALocalOnlyOverrideKeyedProtoReturnsTheOverride() async {
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            flagOverrides: FlagOverrides.localOnly(MapOverrideDataSource(["__proto__": true]))
        )
        let client = ConfeatureClient(sdkKey: Self.testSdkKey, options: options)
        defer { client.close() }

        let got = await client.getValue(forKey: "__proto__", defaultValue: false)
        XCTAssertTrue(got, "the __proto__ override must win under LocalOnly")
    }
}
