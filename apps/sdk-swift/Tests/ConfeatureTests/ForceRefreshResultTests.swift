// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// #833 — ``ConfeatureClient/forceRefresh()`` reports the fetch outcome,
/// with ConfigCat Swift 11.3.1's `RefreshErrorCode` for each failure
/// (`Sources/ConfigCat/ConfigFetcher.swift`), and a key-free message.
///
/// MUTATION (applied, #833): return the unconditional
/// `RefreshResult(isSuccess: true, …)` after `refreshOnce()` again and
/// every failure test below goes red.
final class ForceRefreshResultTests: XCTestCase {
    private static let sdkKey =
        "configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB"
    private static let configBody = "{\"f\":{\"feature.on\":{\"t\":0,\"v\":{\"b\":true}}}}"

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient(sdkKey: String = sdkKey) -> ConfeatureClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let options = ConfeatureClientOptions(
            pollingMode: .manualPoll,
            requestTimeout: 5,
            cacheDirectory: CacheDirectorySentinel.memory,
            logger: NoOpLogger(),
            urlSession: URLSession(configuration: config)
        )
        return ConfeatureClient(sdkKey: sdkKey, options: options)
    }

    private func refresh(
        sdkKey: String = sdkKey, _ respond: @escaping (URLRequest) -> MockResponse
    ) async -> RefreshResult {
        MockURLProtocol.handler = respond
        let client = makeClient(sdkKey: sdkKey)
        defer { client.close() }
        return await client.forceRefresh()
    }

    private func assertFailure(
        _ result: RefreshResult, _ code: RefreshErrorCode,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertFalse(result.isSuccess, file: file, line: line)
        XCTAssertEqual(result.errorCode, code, file: file, line: line)
        let message = result.errorMessage ?? ""
        XCTAssertFalse(message.isEmpty, file: file, line: line)
        for secret in ["AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB"] {
            XCTAssertFalse(message.contains(secret), "key in \(message)", file: file, line: line)
        }
    }

    func testAFresh200IsASuccess() async {
        let result = await refresh { _ in
            MockResponse(statusCode: 200, headers: ["ETag": "v1"], body: Self.configBody)
        }
        XCTAssertTrue(result.isSuccess)
        XCTAssertEqual(result.errorCode, RefreshErrorCode.none)
        XCTAssertNil(result.errorMessage)
    }

    func testA304NotModifiedIsASuccess() async {
        MockURLProtocol.handler = { request in
            request.value(forHTTPHeaderField: "If-None-Match") == "v1"
                ? MockResponse(statusCode: 304, headers: ["ETag": "v1"], body: "")
                : MockResponse(statusCode: 200, headers: ["ETag": "v1"], body: Self.configBody)
        }
        let client = makeClient()
        defer { client.close() }
        _ = await client.forceRefresh()
        let result = await client.forceRefresh()
        XCTAssertEqual(MockURLProtocol.requestCount, 2)
        XCTAssertTrue(result.isSuccess)
        XCTAssertEqual(result.errorCode, RefreshErrorCode.none)
    }

    func testA404IsAnInvalidSdkKey() async {
        let result = await refresh { _ in MockResponse(statusCode: 404, headers: [:], body: "") }
        assertFailure(result, .invalidSdkKey)
    }

    func testA403IsAnInvalidSdkKey() async {
        let result = await refresh { _ in MockResponse(statusCode: 403, headers: [:], body: "") }
        assertFailure(result, .invalidSdkKey)
    }

    func testAnotherNon2xxIsAnUnexpectedHttpResponse() async {
        let result = await refresh { _ in MockResponse(statusCode: 500, headers: [:], body: "") }
        assertFailure(result, .unexpectedHttpResponse)
    }

    func testAnUnparseableBodyIsInvalidHttpResponseContent() async {
        let result = await refresh { _ in
            MockResponse(statusCode: 200, headers: [:], body: "{not json")
        }
        assertFailure(result, .invalidHttpResponseContent)
    }

    func testANetworkErrorIsAnHttpRequestFailure() async {
        let result = await refresh { _ in
            MockResponse(
                statusCode: 0, headers: [:], body: "",
                failure: .beforeResponse(
                    NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)))
        }
        assertFailure(result, .httpRequestFailure)
    }

    func testATimeoutIsAnHttpRequestTimeout() async {
        let result = await refresh { _ in
            MockResponse(
                statusCode: 0, headers: [:], body: "",
                failure: .beforeResponse(
                    NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)))
        }
        assertFailure(result, .httpRequestTimeout)
    }

    func testAKeyRefusedBeforeSendingIsAnInvalidSdkKey() async {
        let result = await refresh(sdkKey: "..") { _ in
            MockResponse(statusCode: 200, headers: [:], body: Self.configBody)
        }
        assertFailure(result, .invalidSdkKey)
        XCTAssertEqual(MockURLProtocol.requestCount, 0)
    }

    func testTheCodesAreConfigCatsRawValues() {
        let pairs: [(RefreshErrorCode, Int)] = [
            (.unexpectedError, -1), (.none, 0), (.localOnlyClient, 1), (.offlineClient, 3200),
            (.invalidSdkKey, 1100), (.unexpectedHttpResponse, 1101), (.httpRequestTimeout, 1102),
            (.httpRequestFailure, 1103), (.invalidHttpResponseContent, 1105),
        ]
        for (code, raw) in pairs {
            XCTAssertEqual(code.rawValue, raw, "\(code)")
        }
    }
}
