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

    // -----------------------------------------------------------------
    // Corpus shape — decoded ad-hoc via JSONSerialization rather than
    // Codable. `expected.requestHeaderIfNoneMatch` is intentionally
    // three-state (absent / explicit null / explicit string) and
    // Codable's optional-of-optional collapses absent and null into
    // the same `nil`, so we read the raw `[String: Any]` and probe
    // `keys.contains` to preserve the distinction.
    // -----------------------------------------------------------------

    func testWireCasesCorpusConformance() async throws {
        let corpusURL = WorkspaceRoot.url().appendingPathComponent(
            "packages/test-fixtures-sdk-parity/fixtures/wire-cases.json")
        let data = try Data(contentsOf: corpusURL)
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cases = root["cases"] as? [[String: Any]]
        else {
            XCTFail("wire-cases.json: top-level shape MUST be {cases: [...]}")
            return
        }
        XCTAssertFalse(
            cases.isEmpty,
            "wire-cases.json carries no cases — fixture is FROZEN at 12 cases"
        )

        for rawCase in cases {
            try await runWireCase(rawCase)
        }
    }

    /// Every field this consumer reads. A corpus field outside these
    /// sets fails its case (schema 1.3 rule).
    private static let knownCaseFields: Set<String> = [
        "id", "description", "given", "server", "expected",
    ]
    private static let knownGivenFields: Set<String> = ["previousEtag", "baseUrl", "sdkKey"]
    private static let knownServerFields: Set<String> = [
        "behavior", "status", "headers", "bodyRef", "body",
    ]
    private static let knownExpectedFields: Set<String> = [
        "requestHeaderIfNoneMatch", "outcome", "resultingEtag", "hasConfig", "errorClass",
        "requestUrlPrefix", "requestPath",
    ]

    private func runWireCase(_ rawCase: [String: Any]) async throws {
        let id = (rawCase["id"] as? String) ?? "<unknown>"
        guard
            let given = rawCase["given"] as? [String: Any],
            let server = rawCase["server"] as? [String: Any],
            let expected = rawCase["expected"] as? [String: Any]
        else {
            XCTFail("case \(id): malformed corpus entry")
            return
        }
        let sections: [(String, [String: Any], Set<String>)] = [
            ("case", rawCase, Self.knownCaseFields),
            ("given", given, Self.knownGivenFields),
            ("server", server, Self.knownServerFields),
            ("expected", expected, Self.knownExpectedFields),
        ]
        var unknown: [String] = []
        for (section, fields, known) in sections {
            for field in fields.keys where !known.contains(field) {
                unknown.append("\(section).\(field)")
            }
        }
        guard unknown.isEmpty else {
            XCTFail("case \(id): unknown corpus field(s) \(unknown.sorted()) — read them first")
            return
        }

        let behavior = (server["behavior"] as? String) ?? "respond"
        guard ["respond", "timeout", "close-mid-response"].contains(behavior) else {
            XCTFail("case \(id): unknown server.behavior \(behavior)")
            return
        }
        let sdkKey = (given["sdkKey"] as? String) ?? Self.wireTestSdkKey
        let baseURL = (given["baseUrl"] as? String) ?? "https://cdn.wire-test.confeature.io"

        let bodyData = try resolveBody(server: server, caseId: id)
        let serverStatus = (server["status"] as? Int) ?? 0
        let serverHeaders = (server["headers"] as? [String: String]) ?? [:]

        // previousEtag is explicitly nullable in the corpus.
        let previousETag: String?
        if let raw = given["previousEtag"], !(raw is NSNull) {
            previousETag = raw as? String
        } else {
            previousETag = nil
        }

        // Install the per-case mock handler. The handler stashes the
        // outbound request on the shared protocol class so we can
        // assert request-side invariants (URL shape, If-None-Match
        // echo, raw-key absence) after the fetch completes.
        WireMockURLProtocol.reset()
        WireMockURLProtocol.handler = { request in
            WireMockURLProtocol.capturedRequest = request
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
        let session = URLSession(configuration: config)

        let fetcher = ConfigFetcher(
            sdkKey: sdkKey,
            version: "0.0.0-wire-test",
            baseURL: baseURL,
            session: session,
            logger: NoOpLogger()
        )

        let result = await fetcher.fetch(previousETag: previousETag)

        // ---- Request-side assertions --------------------------------
        guard let request = WireMockURLProtocol.capturedRequest else {
            XCTFail("case \(id): fetcher MUST issue exactly one HTTP request")
            return
        }
        let urlString = request.url?.absoluteString ?? ""
        XCTAssertTrue(
            urlString.contains("/configuration-files/"),
            "case \(id): URL \(urlString) missing /configuration-files/"
        )
        XCTAssertTrue(
            urlString.hasSuffix("/config_v6.json"),
            "case \(id): URL \(urlString) missing /config_v6.json suffix"
        )
        // The path carries the SDK key itself, as ConfigCat's does
        // (#803): never the retired `/v2/` + cache-key-tail route.
        XCTAssertFalse(urlString.contains("/v2/"), "case \(id): URL \(urlString) uses /v2/")
        if let prefix = expected["requestUrlPrefix"] as? String {
            XCTAssertTrue(
                urlString.hasPrefix(prefix),
                "case \(id): URL \(urlString) does not start with \(prefix)"
            )
        }
        if let wantedPath = expected["requestPath"] as? String {
            // The PARSED path, still percent-encoded, query excluded.
            let path = request.url.flatMap {
                URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath
            }
            XCTAssertEqual(path, wantedPath, "case \(id): request path mismatch")
        }

        // If-None-Match three-state assertion: absent (don't probe),
        // explicit null (header MUST NOT be sent), explicit string
        // (header MUST equal). The corpus encodes "absent" by omitting
        // the key, "null" via JSON null, and "value" via JSON string.
        if expected.keys.contains("requestHeaderIfNoneMatch") {
            let rawExpected = expected["requestHeaderIfNoneMatch"]
            let actual = request.value(forHTTPHeaderField: "If-None-Match")
            if rawExpected is NSNull {
                XCTAssertNil(
                    actual,
                    "case \(id): If-None-Match must be absent; got \(String(describing: actual))"
                )
            } else if let wanted = rawExpected as? String {
                XCTAssertEqual(
                    actual, wanted,
                    "case \(id): If-None-Match mismatch (got=\(String(describing: actual)))"
                )
            }
        }

        // ---- Outcome assertions -------------------------------------
        if let hasConfig = expected["hasConfig"] as? Bool {
            XCTAssertEqual(
                result.body != nil, hasConfig,
                "case \(id): hasConfig=\(hasConfig) but body=\(String(describing: result.body))"
            )
        }
        let outcome = (expected["outcome"] as? String) ?? ""
        switch outcome {
        case "fetched":
            XCTAssertEqual(
                result.status, .fetched,
                "case \(id): status=\(result.status); want fetched (error=\(String(describing: result.error)))"
            )
            if let wantedEtag = expected["resultingEtag"] as? String {
                XCTAssertEqual(
                    result.etag, wantedEtag,
                    "case \(id): ETag mismatch"
                )
            }
            XCTAssertNotNil(
                result.body,
                "case \(id): body must be populated on fetched outcome"
            )
        case "notModified":
            XCTAssertEqual(
                result.status, .notModified,
                "case \(id): status=\(result.status); want notModified (error=\(String(describing: result.error)))"
            )
            if let wantedEtag = expected["resultingEtag"] as? String {
                XCTAssertEqual(
                    result.etag, wantedEtag,
                    "case \(id): ETag mismatch"
                )
            }
            XCTAssertNil(
                result.body,
                "case \(id): body must be nil on notModified; got \(String(describing: result.body))"
            )
        case "failed":
            XCTAssertEqual(
                result.status, .failed,
                "case \(id): status=\(result.status); want failed (body=\(String(describing: result.body)))"
            )
            let wantedClass = (expected["errorClass"] as? String) ?? ""
            let mapped = Self.swiftErrorToClass(result.error)
            XCTAssertEqual(
                mapped, wantedClass,
                "case \(id): errorClass=\(mapped) (mapped from raw=\(String(describing: result.error))); want \(wantedClass)"
            )
        default:
            XCTFail("case \(id): unknown outcome \(outcome) in corpus")
        }
    }

    // -----------------------------------------------------------------
    // Body resolution — `bodyRef` points to a sibling fixture JSON
    // under `packages/test-fixtures-sdk-parity/fixtures`; `body` is a
    // raw string used for malformed-payload cases. Either may be
    // absent (304 has no body).
    // -----------------------------------------------------------------
    private func resolveBody(server: [String: Any], caseId: String) throws -> Data? {
        if let ref = server["bodyRef"] as? String {
            let path = WorkspaceRoot.url().appendingPathComponent(
                "packages/test-fixtures-sdk-parity/fixtures/\(ref)")
            return try Data(contentsOf: path)
        }
        if let raw = server["body"] as? String {
            return raw.data(using: .utf8) ?? Data()
        }
        return nil
    }

    // -----------------------------------------------------------------
    // Maps Swift's stringly-typed `FetchResult.error` onto the
    // corpus's normalised error-class vocabulary. Mirrors the
    // identical mapping in sdk-go (`goErrorToClass`), sdk-python
    // (`_python_error_to_class`), and the typed-enum variants in
    // sdk-node / sdk-rust. When the Swift fetcher graduates to a
    // typed enum, this switch moves to a `switch` on that enum.
    //
    //   - "MALFORMED_JSON"           -> parseFailed   (JSON.parse failure OR wrong top-level shape)
    //   - "INVALID_SDK_KEY"          -> invalidSdkKey (key cannot be a path segment; no request)
    //   - "HTTP 403" / "HTTP 404"    -> invalidSdkKey (CDN rejected the key — per ConfigCat only
    //                                   403/404 are invalid-SDK-key statuses; 401 is a generic
    //                                   retryable failure)
    //   - "HTTP <other-non-2xx>"     -> fetchFailed
    //   - "timeout"                  -> timeout       (NSURLErrorTimedOut)
    //   - any other fixed reason     -> fetchFailed   (connection_lost, too_many_redirects, …)
    //   - everything else            -> fetchFailed
    // -----------------------------------------------------------------
    private static func swiftErrorToClass(_ error: String?) -> String {
        guard let error else { return "fetchFailed" }
        if error == "MALFORMED_JSON" { return "parseFailed" }
        if error == "INVALID_SDK_KEY" { return "invalidSdkKey" }
        if error == "HTTP 403" || error == "HTTP 404" { return "invalidSdkKey" }
        if error.hasPrefix("HTTP ") { return "fetchFailed" }
        if error == "timeout" { return "timeout" }
        return "fetchFailed"
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
/// `URLSessionConfiguration`. The handler + capturedRequest are reset
/// between cases via `WireMockURLProtocol.reset()` in `runWireCase`.
private final class WireMockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> WireMockResponse)?
    nonisolated(unsafe) static var capturedRequest: URLRequest?

    static func reset() {
        handler = nil
        capturedRequest = nil
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
