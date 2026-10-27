// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// The one set of rules a wire-case is judged by, shared by the hermetic
/// suite (``WireCasesTests``, a `URLProtocol` mock) and the live suite
/// (``WireCasesLiveTests``, the running live-contract harness, #924), so the
/// two cannot drift: what the offline suite proves against a mock is what
/// the live suite proves against the reference origin.
///
/// The corpus is `packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`,
/// read with `JSONSerialization` rather than Codable:
/// `expected.requestHeaderIfNoneMatch` is three-state (absent / null /
/// string), and Codable's optional-of-optional folds absent into null.
enum WireCaseAssertions {
    /// One corpus case, as decoded.
    typealias WireCase = [String: Any]

    /// What one fetch sent, as the suite observed it: the request target's
    /// path (still percent-encoded, query excluded), the full target, and
    /// the If-None-Match header (nil when absent).
    struct SentRequest {
        let path: String
        let url: String
        let ifNoneMatch: String?
    }

    /// Every field this consumer reads. A corpus field outside these sets
    /// fails its case (schema 1.3): a new expectation is never skipped.
    private static let knownFields: [String: Set<String>] = [
        "case": ["id", "description", "given", "server", "expected"],
        "given": ["previousEtag", "baseUrl", "sdkKey"],
        "server": ["behavior", "status", "headers", "bodyRef", "body"],
        "expected": [
            "requestHeaderIfNoneMatch", "outcome", "resultingEtag", "hasConfig", "errorClass",
            "requestUrlPrefix", "requestPath",
        ],
    ]

    /// The fixtures directory of the shared corpus package.
    static var fixturesURL: URL {
        WorkspaceRoot.url().appendingPathComponent("packages/test-fixtures-sdk-parity/fixtures")
    }

    /// The corpus's cases, keyed by nothing: in corpus order.
    static func loadCorpus() throws -> [WireCase] {
        let data = try Data(contentsOf: fixturesURL.appendingPathComponent("wire-cases.json"))
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cases = root["cases"] as? [WireCase]
        else {
            throw NSError(
                domain: "WireCaseAssertions", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "wire-cases.json is not {cases: [...]}"])
        }
        // A case pending for sdk-swift (wire-cases-pending.json, 1.4, #994) is
        // left out BY NAME, under a proof that the entry is still true: this
        // reader still cannot read it. The day it can, loading throws and the
        // entry must go.
        var pending = try loadPendingCases()
        var runnable: [WireCase] = []
        for wireCase in cases {
            guard let ticket = pending.removeValue(forKey: id(wireCase)) else {
                runnable.append(wireCase)
                continue
            }
            if unknownFields(wireCase).isEmpty {
                throw NSError(
                    domain: "WireCaseAssertions", code: 2,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "\(id(wireCase)) is pending for sdk-swift (\(ticket)) but this reader reads "
                            + "every field of it — remove it from wire-cases-pending.json and run it"
                    ])
            }
            let unread = unknownFields(wireCase)
            print("pending (\(ticket)): \(id(wireCase)) — this reader cannot read \(unread)")
        }
        if !pending.isEmpty {
            throw NSError(
                domain: "WireCaseAssertions", code: 3,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "wire-cases-pending.json lists \(pending.keys.sorted()) for sdk-swift, not in the corpus"
                ])
        }
        return runnable
    }

    /// sdk-swift's entry of `wire-cases-pending.json`: case id to ticket.
    static func loadPendingCases() throws -> [String: String] {
        let url = fixturesURL.appendingPathComponent("wire-cases-pending.json")
        let data = try Data(contentsOf: url)
        guard
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let pending = root["pending"] as? [String: Any]
        else {
            throw NSError(
                domain: "WireCaseAssertions", code: 4,
                userInfo: [
                    NSLocalizedDescriptionKey: "wire-cases-pending.json: no {pending: {...}}"
                ])
        }
        guard let entry = pending["sdk-swift"] as? [String: Any],
            let ticket = entry["ticket"] as? String,
            let ids = entry["cases"] as? [String]
        else { return [:] }
        return Dictionary(uniqueKeysWithValues: ids.map { ($0, ticket) })
    }

    static func id(_ wireCase: WireCase) -> String { (wireCase["id"] as? String) ?? "<unknown>" }
    static func given(_ wireCase: WireCase) -> [String: Any] {
        (wireCase["given"] as? [String: Any]) ?? [:]
    }
    static func server(_ wireCase: WireCase) -> [String: Any] {
        (wireCase["server"] as? [String: Any]) ?? [:]
    }
    static func expected(_ wireCase: WireCase) -> [String: Any] {
        (wireCase["expected"] as? [String: Any]) ?? [:]
    }

    /// The fields of `wireCase` this consumer does not read, as
    /// `section.field`, sorted; a malformed section is reported too.
    static func unknownFields(_ wireCase: WireCase) -> [String] {
        var unknown: [String] = []
        let sections: [(String, Any?)] = [
            ("case", wireCase), ("given", wireCase["given"]), ("server", wireCase["server"]),
            ("expected", wireCase["expected"]),
        ]
        for (section, raw) in sections {
            guard let fields = raw as? [String: Any] else {
                unknown.append("\(section) (not an object)")
                continue
            }
            for field in fields.keys where !(knownFields[section] ?? []).contains(field) {
                unknown.append("\(section).\(field)")
            }
        }
        return unknown.sorted()
    }

    /// The key a suite configures its fetcher with: the corpus's
    /// `given.sdkKey` when the case pins one, else the suite's default (a
    /// legacy-shaped key offline, the case id live, the key the harness
    /// seeds).
    static func sdkKey(for wireCase: WireCase, default fallback: String) -> String {
        (given(wireCase)["sdkKey"] as? String) ?? fallback
    }

    /// `given.previousEtag`, explicitly nullable in the corpus.
    static func previousETag(_ wireCase: WireCase) -> String? {
        given(wireCase)["previousEtag"] as? String
    }

    /// The exact path a case's request must carry (#803 FR-001): the
    /// corpus's `requestPath` when the case pins one, else ConfigCat's
    /// `/configuration-files/<sdkKey>/config_v6.json` with the key verbatim,
    /// which is how a suite proves the SDK sent the key it was configured
    /// with.
    static func requestPath(for wireCase: WireCase, sdkKey: String) -> String {
        (expected(wireCase)["requestPath"] as? String)
            ?? "/configuration-files/\(sdkKey)/config_v6.json"
    }

    /// Maps the fetcher's FIXED reason codes (#803 FR-002) onto the
    /// corpus's error-class vocabulary. A reason not listed here maps to
    /// `unknown` and FAILS its case: folding an unexpected failure into
    /// fetchFailed would hide it (sdk-go's `goErrorToClass`).
    ///
    ///   - `MALFORMED_JSON`                     -> parseFailed
    ///   - `INVALID_SDK_KEY`, `HTTP 403`/`404`   -> invalidSdkKey (ConfigCat's
    ///                                             only invalid-key statuses)
    ///   - `HTTP <other>`                       -> fetchFailed
    ///   - `timeout`                            -> timeout (NSURLErrorTimedOut)
    ///   - `connection_lost`, `connect_error`,  -> fetchFailed (transport)
    ///     `offline`, `too_many_redirects`,
    ///     `network_error`, `NON_HTTP_RESPONSE`
    static func errorClass(_ error: String?) -> String {
        guard let error else { return "unknown" }
        switch error {
        case "MALFORMED_JSON": return "parseFailed"
        case "INVALID_SDK_KEY", "HTTP 403", "HTTP 404": return "invalidSdkKey"
        case "timeout": return "timeout"
        case "connection_lost", "connect_error", "offline", "too_many_redirects", "network_error",
            "NON_HTTP_RESPONSE":
            return "fetchFailed"
        default:
            return error.hasPrefix("HTTP ") ? "fetchFailed" : "unknown"
        }
    }

    /// Judges one fetch of `wireCase`, the request it sent and the result
    /// it returned, by the corpus's expectations.
    static func assertWireCase(
        _ wireCase: WireCase, sdkKey: String, sent: SentRequest,
        result: ConfigFetcher.FetchResult, file: StaticString = #filePath, line: UInt = #line
    ) {
        assertRequest(wireCase, sdkKey: sdkKey, sent: sent, file: file, line: line)
        assertOutcome(wireCase, result: result, file: file, line: line)
    }

    /// The request side: the exact path as sent, no legacy `/v2/`, a custom
    /// base leading the fetcher's URL, and the If-None-Match round-trip.
    static func assertRequest(
        _ wireCase: WireCase, sdkKey: String, sent: SentRequest, file: StaticString, line: UInt
    ) {
        let id = id(wireCase)
        let given = given(wireCase)
        let expected = expected(wireCase)
        XCTAssertEqual(
            sent.path, requestPath(for: wireCase, sdkKey: sdkKey), "case \(id): request path",
            file: file, line: line)
        XCTAssertFalse(
            sent.url.contains("/v2/"), "case \(id): \(sent.url) uses /v2/", file: file, line: line)
        // A custom base must lead the request URL (custom-base-url). Checked
        // on the fetcher's `url`, the one place the GET's URL is formed,
        // because the case's host is not routable from a test.
        let baseURL = given["baseUrl"] as? String
        let prefix = expected["requestUrlPrefix"] as? String
        XCTAssertEqual(
            baseURL == nil, prefix == nil,
            "case \(id): given.baseUrl and expected.requestUrlPrefix come together",
            file: file, line: line)
        if let baseURL, let prefix {
            let custom = ConfigFetcher(
                sdkKey: sdkKey, version: "0.0.0-wire-test", baseURL: baseURL, logger: NoOpLogger())
            let url = custom.url?.absoluteString ?? "<none>"
            XCTAssertTrue(
                url.hasPrefix(prefix), "case \(id): URL \(url) does not start with \(prefix)",
                file: file, line: line)
        }
        guard expected.keys.contains("requestHeaderIfNoneMatch") else { return }
        switch expected["requestHeaderIfNoneMatch"] {
        case is NSNull:
            XCTAssertNil(
                sent.ifNoneMatch, "case \(id): If-None-Match must be absent", file: file,
                line: line)
        case let wanted as String:
            XCTAssertEqual(
                sent.ifNoneMatch, wanted, "case \(id): If-None-Match", file: file, line: line)
        default:
            XCTFail(
                "case \(id): requestHeaderIfNoneMatch is neither null nor a string", file: file,
                line: line)
        }
    }

    /// The outcome side: the typed status and reason code against the
    /// corpus's `{fetched, notModified, failed}` x errorClass, and hasConfig.
    static func assertOutcome(
        _ wireCase: WireCase, result: ConfigFetcher.FetchResult, file: StaticString, line: UInt
    ) {
        let id = id(wireCase)
        let expected = expected(wireCase)
        let detail = "error=\(String(describing: result.error))"
        switch (expected["outcome"] as? String) ?? "" {
        case "fetched":
            XCTAssertEqual(
                result.status, .fetched, "case \(id): status (\(detail))", file: file, line: line)
            XCTAssertNotNil(
                result.body, "case \(id): a fetched outcome has a body", file: file, line: line)
            if let etag = expected["resultingEtag"] as? String {
                XCTAssertEqual(result.etag, etag, "case \(id): ETag", file: file, line: line)
            }
        case "notModified":
            XCTAssertEqual(
                result.status, .notModified, "case \(id): status (\(detail))", file: file,
                line: line)
            XCTAssertNil(
                result.body, "case \(id): a notModified outcome has no body", file: file, line: line
            )
            if let etag = expected["resultingEtag"] as? String {
                XCTAssertEqual(result.etag, etag, "case \(id): ETag", file: file, line: line)
            }
        case "failed":
            XCTAssertEqual(
                result.status, .failed, "case \(id): status (\(detail))", file: file, line: line)
            XCTAssertEqual(
                errorClass(result.error), (expected["errorClass"] as? String) ?? "<none>",
                "case \(id): errorClass (\(detail))", file: file, line: line)
        case let outcome:
            XCTFail("case \(id): unknown outcome \(outcome) in corpus", file: file, line: line)
        }
        if let hasConfig = expected["hasConfig"] as? Bool {
            XCTAssertEqual(
                result.body != nil, hasConfig, "case \(id): hasConfig", file: file, line: line)
        }
    }
}
