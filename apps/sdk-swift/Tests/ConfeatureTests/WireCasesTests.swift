// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Wire-protocol fixture suite (Swift consumer).
///
/// Drives sdk-swift's ``ConfigFetcher`` against each case in
/// `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`. The
/// corpus is the language-agnostic contract; this file is the Swift
/// consumer that maps the fetcher's typed ``Status`` + stringly-typed
/// ``FetchResult/error`` onto the corpus's normalised
/// `{fetched, notModified, failed}` x `{fetchFailed, timeout,
/// parseFailed, invalidSdkKey}` vocabulary — the same mapping
/// sdk-node / sdk-browser-js / sdk-bun / sdk-deno / sdk-python /
/// sdk-go / sdk-rust already conform to.
///
/// Layer choice: this drives the fetcher directly (NOT the public
/// ``ConfeatureClient``), matching what the other federation
/// consumers do — the wire-cases corpus by name tests wire behaviour,
/// and the fetcher is sdk-swift's wire layer. Driving the public
/// client would add poll-service indirection (cache writes, AutoPoll
/// ticker hooks, hook bus) the corpus does not assert.
///
/// Spec 112 / Epic #146 / Issue #148 (slice 15).
///
/// Request side (schema 1.3, #803): a case's `given.sdkKey` configures
/// the fetcher, `expected.requestUrlPrefix` and `expected.requestPath`
/// (the parsed, still percent-encoded path, query excluded) are
/// asserted, and an unknown `given` / `server` / `expected` field FAILS
/// the case — a new expectation can never be skipped silently.
///
/// Transport behaviours (`server.behavior`, 1.2): `timeout` and
/// `close-mid-response` are forced on the mock as the errors
/// URLSession raises for them (`NSURLErrorTimedOut`; head + half the
/// body, then `NSURLErrorNetworkConnectionLost`), not by waiting out a
/// real request budget.
///
/// Constitution invariant (Principle II NON-NEGOTIABLE): every case MUST
/// pass. If a case drifts, STOP and investigate the fetcher — never
/// mutate the corpus to make the test green (Principle IV — additive
/// only).
final class WireCasesTests: XCTestCase {
    private static let wireTestSdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    override func tearDown() {
        WireMockURLProtocol.reset()
        super.tearDown()
    }

    /// Every corpus case against the mock, judged by ``WireCaseAssertions``,
    /// the rules the live suite applies to the reference origin (#924).
    func testWireCasesCorpusConformance() async throws {
        let cases = try WireCaseAssertions.loadCorpus()
        XCTAssertFalse(cases.isEmpty, "wire-cases.json carries no cases")
        for wireCase in cases {
            try await runWireCase(wireCase)
        }
    }

    /// The error mapping fails closed: a reason it does not know, or a
    /// failure with no reason, is `unknown` and fails its case, never a
    /// silent fetchFailed (MUTATION: map the default to fetchFailed).
    func testErrorClassFailsClosed() {
        XCTAssertEqual(WireCaseAssertions.errorClass(nil), "unknown")
        XCTAssertEqual(WireCaseAssertions.errorClass("cancelled"), "unknown")
        XCTAssertEqual(WireCaseAssertions.errorClass("url_error_-1"), "unknown")
        XCTAssertEqual(WireCaseAssertions.errorClass("HTTP 403"), "invalidSdkKey")
        XCTAssertEqual(WireCaseAssertions.errorClass("HTTP 503"), "fetchFailed")
        XCTAssertEqual(WireCaseAssertions.errorClass("connection_lost"), "fetchFailed")
    }

    private func runWireCase(_ wireCase: WireCaseAssertions.WireCase) async throws {
        let id = WireCaseAssertions.id(wireCase)
        let unknown = WireCaseAssertions.unknownFields(wireCase)
        guard unknown.isEmpty else {
            XCTFail("case \(id): unknown corpus field(s) \(unknown) — read them first")
            return
        }
        let given = WireCaseAssertions.given(wireCase)
        let server = WireCaseAssertions.server(wireCase)
        let behavior = (server["behavior"] as? String) ?? "respond"
        guard ["respond", "timeout", "close-mid-response"].contains(behavior) else {
            XCTFail("case \(id): unknown server.behavior \(behavior)")
            return
        }
        let sdkKey = WireCaseAssertions.sdkKey(for: wireCase, default: Self.wireTestSdkKey)
        let baseURL = (given["baseUrl"] as? String) ?? "https://cdn.wire-test.confeature.io"
        let bodyData = try resolveBody(server: server)
        let serverStatus = (server["status"] as? Int) ?? 0
        let serverHeaders = (server["headers"] as? [String: String]) ?? [:]

        // The handler stashes each outbound request, so the request side is
        // judged on what was sent, and exactly one must have been.
        WireMockURLProtocol.reset()
        WireMockURLProtocol.handler = { request in
            WireMockURLProtocol.capturedRequests.append(request)
            return WireMockResponse(
                statusCode: serverStatus,
                headers: serverHeaders,
                bodyData: bodyData,
                behavior: behavior
            )
        }
        defer { WireMockURLProtocol.reset() }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [WireMockURLProtocol.self]
        let fetcher = ConfigFetcher(
            sdkKey: sdkKey,
            version: "0.0.0-wire-test",
            baseURL: baseURL,
            session: URLSession(configuration: config),
            logger: NoOpLogger()
        )
        let result = await fetcher.fetch(previousETag: WireCaseAssertions.previousETag(wireCase))

        let requests = WireMockURLProtocol.capturedRequests
        guard requests.count == 1, let request = requests.first, let url = request.url else {
            XCTFail("case \(id): one fetch sent \(requests.count) requests, not exactly one")
            return
        }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        WireCaseAssertions.assertWireCase(
            wireCase, sdkKey: sdkKey,
            sent: .init(
                path: path, url: url.absoluteString,
                ifNoneMatch: request.value(forHTTPHeaderField: "If-None-Match")),
            result: result)
    }

    /// A case's response body: a sibling fixture (`bodyRef`) or raw text
    /// (`body`, the malformed payloads); neither for a 304.
    private func resolveBody(server: [String: Any]) throws -> Data? {
        if let ref = server["bodyRef"] as? String {
            return try Data(contentsOf: WireCaseAssertions.fixturesURL.appendingPathComponent(ref))
        }
        if let raw = server["body"] as? String {
            return raw.data(using: .utf8) ?? Data()
        }
        return nil
    }
}

// MARK: - Mock URLProtocol

/// Wire-cases-local mock response carrying a binary body so JSON
/// fixtures round-trip byte-identical (the existing
/// `ConfigFetcherTests.MockResponse` is string-only).
private struct WireMockResponse {
    let statusCode: Int
    let headers: [String: String]
    let bodyData: Data?
    /// `server.behavior`: `respond`, `timeout` or `close-mid-response`.
    let behavior: String
}

/// File-local URLProtocol mock. Kept private + uniquely named so it
/// cannot collide with `ConfigFetcherTests.MockURLProtocol`, which is
/// a separate type registered against a separate
/// `URLSessionConfiguration`. The handler + capturedRequests are reset
/// between cases via `WireMockURLProtocol.reset()` in `runWireCase`.
private final class WireMockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> WireMockResponse)?
    nonisolated(unsafe) static var capturedRequests: [URLRequest] = []

    static func reset() {
        handler = nil
        capturedRequests = []
    }

    override class func canInit(with request: URLRequest) -> Bool {
        handler != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = WireMockURLProtocol.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: NSError(
                    domain: NSURLErrorDomain, code: NSURLErrorUnknown, userInfo: nil))
            return
        }
        let response = handler(request)
        if response.behavior == "timeout" {
            client?.urlProtocol(self, didFailWithError: Self.urlError(NSURLErrorTimedOut, request))
            return
        }
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        if response.behavior == "close-mid-response" {
            let body = response.bodyData ?? Data()
            client?.urlProtocol(self, didLoad: body.prefix(body.count / 2))
            client?.urlProtocol(
                self, didFailWithError: Self.urlError(NSURLErrorNetworkConnectionLost, request))
            return
        }
        if let data = response.bodyData {
            client?.urlProtocol(self, didLoad: data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    /// The error URLSession raises for a transport failure, quoting the
    /// request URL (key included) as Foundation's errors do.
    private static func urlError(_ code: Int, _ request: URLRequest) -> NSError {
        NSError(
            domain: NSURLErrorDomain, code: code,
            userInfo: [NSURLErrorFailingURLErrorKey: request.url as Any])
    }

    override func stopLoading() {
        // No-op — the synchronous handler is already done.
    }
}
