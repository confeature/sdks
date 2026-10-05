// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for ``ConfigFetcher``.
///
/// Network calls are intercepted via `URLProtocol` so the tests do
/// not require network access. Each test installs a fresh URLSession
/// configured with ``MockURLProtocol`` and dispatches a single
/// request through ``ConfigFetcher/fetch(previousETag:)``.
final class ConfigFetcherTests: XCTestCase {
    private static let testSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private static let configCatSdkKey =
        "configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/pQ5rS7tU9vW1xY3zA5bC7d"

    private func makeFetcher(
        sdkKey: String, logger: Logger = NoOpLogger(), session: URLSession? = nil
    ) -> ConfigFetcher {
        ConfigFetcher(
            sdkKey: sdkKey,
            version: "0.1.0",
            baseURL: "https://cdn.example",
            session: session ?? makeSession(),
            logger: logger
        )
    }

    /// The PARSED path, still percent-encoded and without the query,
    /// so an escaped `/` stays distinguishable from a raw one and the
    /// version carrier (#807) does not break these pins.
    private func parsedPath(_ url: URL?) -> String? {
        guard let url else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
    }

    /// Fetches once through ``MockURLProtocol`` and returns the parsed
    /// path of the request that reached the wire.
    private func wirePath(sdkKey: String) async -> String? {
        MockURLProtocol.handler = { _ in
            MockResponse(statusCode: 200, headers: [:], body: "{\"f\": {}}")
        }
        let result = await makeFetcher(sdkKey: sdkKey).fetch(previousETag: nil)
        XCTAssertEqual(result.status, .fetched, "error=\(String(describing: result.error))")
        XCTAssertEqual(MockURLProtocol.requestCount, 1)
        return parsedPath(MockURLProtocol.lastRequest?.url)
    }

    /// #803 FR-001: a legacy key travels raw, as ConfigCat-iOS sends
    /// its key (`url + "/configuration-files/" + sdkKey + ...`). No
    /// `/v2/`, no cache-key tail.
    func testLegacyKeyTravelsRawInThePath() async {
        let expected = "/configuration-files/\(Self.testSdkKey)/config_v6.json"
        XCTAssertEqual(parsedPath(makeFetcher(sdkKey: Self.testSdkKey).url), expected)
        let onTheWire = await wirePath(sdkKey: Self.testSdkKey)
        XCTAssertEqual(onTheWire, expected)
        XCTAssertEqual(MockURLProtocol.lastRequest?.url?.host, "cdn.example")
    }

    /// #803 FR-001: a ConfigCat-shaped key travels raw — three path
    /// segments, the exact bytes a stock ConfigCat SDK sends (no `%2F`).
    func testConfigCatShapedKeyTravelsRawAsThreeSegments() async {
        let expected =
            "/configuration-files/configcat-sdk-1/aB3_-dE5fG7hI9jK1lM3nO/"
            + "pQ5rS7tU9vW1xY3zA5bC7d/config_v6.json"
        XCTAssertEqual(parsedPath(makeFetcher(sdkKey: Self.configCatSdkKey).url), expected)
        let onTheWire = await wirePath(sdkKey: Self.configCatSdkKey)
        XCTAssertEqual(onTheWire, expected)
    }

    /// #803 FR-001: a key failing the shape check is escaped into ONE
    /// segment (Go's `url.PathEscape`), so its `/`, `?`, `#` and `%`
    /// cannot leave it — nor reach the query or fragment.
    func testMalformedKeyIsOneEscapedSegment() async {
        let sdkKey = "bad/../key?x=1#frag%"
        let expected = "/configuration-files/bad%2F..%2Fkey%3Fx=1%23frag%25/config_v6.json"
        let url = makeFetcher(sdkKey: sdkKey).url
        XCTAssertEqual(parsedPath(url), expected)
        XCTAssertNil(url?.query)
        XCTAssertNil(url?.fragment)
        let onTheWire = await wirePath(sdkKey: sdkKey)
        XCTAssertEqual(onTheWire, expected)
    }

    /// #803 FR-001: "", "." and ".." cannot be one path segment (`URL`
    /// resolves `.` / `..` as dot segments), so the fetcher refuses:
    /// no request at all, a redacted `INVALID_SDK_KEY` log line, a
    /// failed result.
    func testEmptyAndDotKeysRequestNothing() async {
        for sdkKey in ["", ".", ".."] {
            MockURLProtocol.reset()
            MockURLProtocol.handler = { _ in
                MockResponse(statusCode: 200, headers: [:], body: "{\"f\": {}}")
            }
            let logger = RecordingLogger()
            let fetcher = makeFetcher(sdkKey: sdkKey, logger: logger)
            XCTAssertEqual(fetcher.target, .invalidSdkKey, "key=\"\(sdkKey)\"")
            XCTAssertNil(fetcher.url, "key=\"\(sdkKey)\"")

            let result = await fetcher.fetch(previousETag: nil)
            XCTAssertEqual(result.status, .failed, "key=\"\(sdkKey)\"")
            XCTAssertEqual(result.error, "INVALID_SDK_KEY", "key=\"\(sdkKey)\"")
            XCTAssertEqual(MockURLProtocol.requestCount, 0, "key=\"\(sdkKey)\" was requested")
            XCTAssertTrue(
                logger.entries().contains { $0.message.contains("INVALID_SDK_KEY") },
                "key=\"\(sdkKey)\": no INVALID_SDK_KEY log line"
            )
        }
    }

    /// A key of dots that is NOT a dot segment (`...`) is a valid
    /// segment and is still requested.
    func testTripleDotKeyIsRequested() async {
        let onTheWire = await wirePath(sdkKey: "...")
        XCTAssertEqual(onTheWire, "/configuration-files/.../config_v6.json")
    }

    func testDefaultBaseURLUsedWhenNil() {
        let fetcher = ConfigFetcher(
            sdkKey: Self.testSdkKey, version: "0.1.0", logger: NoOpLogger())
        XCTAssertTrue(
            fetcher.url?.absoluteString.hasPrefix(
                "https://cdn-global.confeature.io/configuration-files/") ?? false)
    }

    /// #803 FR-002: only an error's identity picks the reason code;
    /// its message and `userInfo` — which quote the URL, key included —
    /// never pass. The last case is the old `localizedDescription`
    /// fallback this replaced.
    func testClassifyReturnsFixedCodes() {
        let quoted =
            "https://cdn.example/configuration-files/\(Self.configCatSdkKey)/config_v6.json"
        let info: [String: Any] = [NSLocalizedDescriptionKey: "failed for url (\(quoted))"]
        let cases: [(Error, String)] = [
            (
                NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: info),
                "timeout"
            ),
            (
                NSError(
                    domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: info),
                "connection_lost"
            ),
            (
                NSError(
                    domain: NSURLErrorDomain, code: NSURLErrorHTTPTooManyRedirects, userInfo: info),
                "too_many_redirects"
            ),
            (
                NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled, userInfo: info),
                "cancelled"
            ),
            (NSError(domain: NSURLErrorDomain, code: -1_234, userInfo: info), "url_error_-1234"),
            (CancellationError(), "cancelled"),
            (NSError(domain: "TestTransport", code: 7, userInfo: info), "network_error"),
        ]
        for (error, code) in cases {
            XCTAssertEqual(ConfigFetcher.classify(error: error), code)
        }
    }

    /// #803 FR-004: the key is in the URL now, so force a timeout, a
    /// mid-body reset and a redirect loop on the mock — each error
    /// quoting the URL the way Foundation's do — and assert the full
    /// key and each of its secret parts appear in no log line and not
    /// in `FetchResult.error`.
    func testTransportFailuresNeverLeakTheKey() async {
        let scenarios: [(String, (URL) -> MockFailure)] = [
            ("timeout", { .beforeResponse(Self.urlError(NSURLErrorTimedOut, quoting: $0)) }),
            (
                "mid-body reset",
                {
                    .midBody(
                        "{\"f\": {\"flag\": ",
                        Self.urlError(NSURLErrorNetworkConnectionLost, quoting: $0))
                }
            ),
            (
                "redirect loop",
                { .beforeResponse(Self.urlError(NSURLErrorHTTPTooManyRedirects, quoting: $0)) }
            ),
            (
                "foreign error",
                {
                    .beforeResponse(
                        NSError(
                            domain: "TestTransport", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "boom (\($0.absoluteString))"]))
                }
            ),
        ]
        for sdkKey in [Self.configCatSdkKey, Self.testSdkKey] {
            let secrets = [sdkKey] + Self.secretParts(of: sdkKey)
            for (name, makeFailure) in scenarios {
                MockURLProtocol.reset()
                MockURLProtocol.handler = { request in
                    MockResponse(
                        statusCode: 200, headers: ["ETag": "v1"], body: "",
                        failure: makeFailure(request.url!))
                }
                let logger = RecordingLogger()
                let result = await makeFetcher(sdkKey: sdkKey, logger: logger)
                    .fetch(previousETag: nil)

                XCTAssertEqual(MockURLProtocol.requestCount, 1, "\(name): no request was made")
                XCTAssertEqual(result.status, .failed, "\(name)")
                XCTAssertNotNil(result.error, "\(name)")
                XCTAssertFalse(logger.entries().isEmpty, "\(name): the failure was not logged")
                let texts = logger.entries().map(\.message) + [result.error ?? ""]
                for text in texts {
                    for secret in secrets {
                        XCTAssertFalse(
                            text.contains(secret),
                            "\(name): a key part leaked into \"\(text)\"")
                    }
                }
            }
        }
    }

    /// An `NSURLErrorDomain` error carrying the request URL the way
    /// Foundation's do: `userInfo` URL keys and the description.
    private static func urlError(_ code: Int, quoting url: URL) -> NSError {
        NSError(
            domain: NSURLErrorDomain, code: code,
            userInfo: [
                NSURLErrorFailingURLErrorKey: url,
                NSURLErrorFailingURLStringErrorKey: url.absoluteString,
                NSLocalizedDescriptionKey: "The request failed. (\(url.absoluteString))",
            ])
    }

    /// The secret parts of a key: the two 22-character parts of a
    /// ConfigCat-shaped key, or the two 32-character parts of a legacy
    /// one.
    private static func secretParts(of sdkKey: String) -> [String] {
        if sdkKey.hasPrefix("configcat-sdk-1/") {
            let parts = sdkKey.split(separator: "/").dropFirst().map(String.init)
            XCTAssertEqual(parts.map(\.count), [22, 22])
            return parts
        }
        let rest = sdkKey.dropFirst("confeature-sdk-1-".count)
        return [String(rest.prefix(32)), String(rest.suffix(32))]
    }

    func testUserAgentFormat() {
        let fetcher = ConfigFetcher(
            sdkKey: Self.testSdkKey, version: "1.2.3", logger: NoOpLogger())
        XCTAssertEqual(fetcher.userAgent, "confeature-swift-sdk/1.2.3")
    }

    func testFetchSuccessReturnsBody() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "User-Agent"),
                "confeature-swift-sdk/0.1.0")
            return MockResponse(
                statusCode: 200,
                headers: ["ETag": "v1"],
                body: "{\"f\": {}}"
            )
        }
        let fetcher = ConfigFetcher(
            sdkKey: Self.testSdkKey,
            version: "0.1.0",
            session: makeSession(),
            logger: NoOpLogger()
        )
        let result = await fetcher.fetch(previousETag: nil)
        XCTAssertEqual(result.status, .fetched)
        XCTAssertEqual(result.body, "{\"f\": {}}")
        XCTAssertEqual(result.etag, "v1")
    }

    func testFetchSends304WhenIfNoneMatchProvided() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "v1")
            return MockResponse(statusCode: 304, headers: ["ETag": "v1"], body: "")
        }
        let fetcher = ConfigFetcher(
            sdkKey: Self.testSdkKey,
            version: "0.1.0",
            session: makeSession(),
            logger: NoOpLogger()
        )
        let result = await fetcher.fetch(previousETag: "v1")
        XCTAssertEqual(result.status, .notModified)
        XCTAssertEqual(result.etag, "v1")
        XCTAssertNil(result.body)
    }

    func testFetchHttpErrorReturnsFailed() async throws {
        MockURLProtocol.handler = { _ in
            MockResponse(statusCode: 503, headers: [:], body: "")
        }
        let fetcher = ConfigFetcher(
            sdkKey: Self.testSdkKey,
            version: "0.1.0",
            session: makeSession(),
            logger: NoOpLogger()
        )
        let result = await fetcher.fetch(previousETag: nil)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.error, "HTTP 503")
    }
}

// MARK: - Mock URLProtocol

struct MockResponse {
    let statusCode: Int
    let headers: [String: String]
    let body: String
    /// When set, the transport fails instead of finishing normally.
    var failure: MockFailure?
}

/// A forced transport failure (#803 FR-004).
enum MockFailure {
    /// Fails before any response head is delivered (timeout, redirect
    /// loop, connection refused).
    case beforeResponse(NSError)
    /// Delivers the response head and these body bytes, then fails —
    /// a connection reset mid-body.
    case midBody(String, NSError)
}

final class MockURLProtocol: URLProtocol {
    // Shared single-test handler. Concurrency: tests are
    // serialised by XCTest within a single suite invocation; the
    // handler is reset in `tearDown`.
    nonisolated(unsafe) static var handler: ((URLRequest) -> MockResponse)?
    /// The last request that reached the mock, and how many did.
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var requestCount = 0

    static func reset() {
        handler = nil
        lastRequest = nil
        requestCount = 0
    }

    override class func canInit(with request: URLRequest) -> Bool {
        handler != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: NSError(
                    domain: NSURLErrorDomain, code: NSURLErrorUnknown, userInfo: nil))
            return
        }
        MockURLProtocol.lastRequest = request
        MockURLProtocol.requestCount += 1
        let response = handler(request)
        if case .beforeResponse(let error) = response.failure {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        if case .midBody(let partial, let error) = response.failure {
            client?.urlProtocol(self, didLoad: Data(partial.utf8))
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        if let data = response.body.data(using: .utf8) {
            client?.urlProtocol(self, didLoad: data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        // No-op — the synchronous handler is already done.
    }
}
