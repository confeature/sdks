// SPDX-License-Identifier: MIT

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// HTTP wrapper around `URLSession` for the Confeature CDN.
///
/// Responsibilities:
/// - User-Agent: `confeature-swift-sdk/{version}` (FR-012).
/// - `If-None-Match` support for 304 reuse (FR-011).
/// - Configurable request timeout (default 30 s).
/// - SDK key redaction in EVERY log line + error message (FR-013):
///   the raw key is NEVER interpolated; ``SdkKey/redact(_:)`` is the
///   only path.
///
/// SECURITY (#803 FR-002): the request URL carries the SDK key —
/// ConfigCat's wire protocol — and Foundation quotes the URL in its
/// errors (`NSURLErrorFailingURLErrorKey`, `localizedDescription`).
/// No error text is ever passed on: a failure is reduced to a FIXED,
/// key-free reason code by ``classify(error:)``.
struct ConfigFetcher: Sendable {
    /// Production CDN base URL.
    static let defaultBaseURL = "https://cdn-global.confeature.io"

    /// Default per-request timeout.
    static let defaultTimeout: TimeInterval = 30

    let baseURL: String
    let userAgent: String
    let session: URLSession
    let logger: Logger
    let sdkKey: String

    /// Constructs a ``ConfigFetcher``.
    ///
    /// - `baseURL` empty → ``defaultBaseURL``.
    /// - `timeout` `<= 0` → ``defaultTimeout``.
    /// - `session` `nil` → fresh `URLSession(configuration: .ephemeral)`
    ///   with the resolved timeout.
    init(
        sdkKey: String,
        version: String,
        baseURL: String? = nil,
        timeout: TimeInterval = ConfigFetcher.defaultTimeout,
        session: URLSession? = nil,
        logger: Logger
    ) {
        let trimmedBase: String
        if let baseURL, !baseURL.isEmpty {
            trimmedBase = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        } else {
            trimmedBase = Self.defaultBaseURL
        }
        self.baseURL = trimmedBase
        self.userAgent = "confeature-swift-sdk/\(version)"
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            let resolvedTimeout = timeout > 0 ? timeout : Self.defaultTimeout
            config.timeoutIntervalForRequest = resolvedTimeout
            config.timeoutIntervalForResource = resolvedTimeout
            self.session = URLSession(configuration: config)
        }
        self.logger = logger
        self.sdkKey = sdkKey
    }

    /// What ``target`` resolves to: the URL to request, or why there
    /// is none.
    enum Target: Equatable {
        /// `<base>/configuration-files/<key path>/config_v6.json`.
        case url(URL)
        /// The key is `""`, `"."` or `".."`: it cannot be a path
        /// segment, so nothing is requested.
        case invalidSdkKey
        /// The configured base URL does not parse into a URL.
        case invalidBaseURL
    }

    /// The CDN URL the fetcher targets — ConfigCat's
    /// `<base>/configuration-files/<sdkKey>/config_v6.json` — and the
    /// ONE place it is built (#803 FR-001), so the version carrier
    /// (#807) lands here only. Mirrors ConfigCat-iOS
    /// (`configcat/swift-sdk` `Sources/ConfigCat/ConfigFetcher.swift`,
    /// `url + "/configuration-files/" + sdkKey + "/" + configJsonName`).
    ///
    /// - A well-shaped key (``SdkKey/isValidConfeatureKeyFormat(_:)``)
    ///   travels RAW: its `/`-separated parts each path-segment-escaped
    ///   (a no-op for a valid key). A ConfigCat-shaped key is three
    ///   segments — the exact bytes a stock ConfigCat SDK sends.
    /// - Any other key is escaped into ONE segment (the runtime is
    ///   lenient), so a `/`, `?` or `#` in it cannot leave its segment.
    /// - `""`, `"."` and `".."` cannot be one segment — no escaper keeps
    ///   them in place, and `URL` resolves `.` / `..` as dot segments —
    ///   so the fetcher requests nothing (``Target/invalidSdkKey``).
    var target: Target {
        let keyPath: String
        if SdkKey.isValidConfeatureKeyFormat(sdkKey) {
            keyPath = sdkKey.split(separator: "/", omittingEmptySubsequences: false)
                .map { Self.pathSegmentEscape(String($0)) }
                .joined(separator: "/")
        } else {
            if sdkKey.isEmpty || sdkKey == "." || sdkKey == ".." {
                return .invalidSdkKey
            }
            keyPath = Self.pathSegmentEscape(sdkKey)
        }
        guard let url = URL(string: "\(baseURL)/configuration-files/\(keyPath)/config_v6.json")
        else { return .invalidBaseURL }
        return .url(url)
    }

    /// ``target``'s URL, or `nil` when there is none.
    var url: URL? {
        if case .url(let url) = target {
            return url
        }
        return nil
    }

    /// The bytes one path segment may carry unescaped: exactly Go's
    /// `url.PathEscape` set — ASCII alphanumerics, `-_.~` and
    /// `$&+:=@` — so the federation escapes a malformed key alike.
    /// Built from ASCII ranges: `CharacterSet.alphanumerics` would
    /// admit non-ASCII letters.
    private static let pathSegmentAllowed: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "A"..."Z")
        set.insert(charactersIn: "a"..."z")
        set.insert(charactersIn: "0"..."9")
        set.insert(charactersIn: "-_.~$&+:=@")
        return set
    }()

    /// Percent-escapes `segment` so it stays ONE path segment.
    /// `addingPercentEncoding` returns `nil` only for a string that is
    /// not valid Unicode, which a Swift `String` cannot be.
    static func pathSegmentEscape(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed) ?? ""
    }

    /// Outcome status of one fetch call.
    enum Status: Equatable {
        case fetched
        case notModified
        case failed
    }

    /// Result envelope returned by ``fetch(previousETag:)``. `body`
    /// is set only when `status == .fetched`. `error` carries a
    /// short, key-free reason code when `status == .failed`.
    struct FetchResult {
        var status: Status
        var body: String?
        var etag: String?
        var error: String?
    }

    /// Issues a single GET. Never throws; failures land in
    /// `FetchResult(status: .failed, error: "...")` with the SDK
    /// key redacted in any log line.
    func fetch(previousETag: String?) async -> FetchResult {
        let url: URL
        switch target {
        case .url(let resolved):
            url = resolved
        case .invalidSdkKey:
            logger.error(
                "ConfigFetcher: INVALID_SDK_KEY — the key cannot be a URL path segment; "
                    + "not fetching (sdkKey=\(SdkKey.redact(sdkKey)))"
            )
            return FetchResult(status: .failed, body: nil, etag: nil, error: "INVALID_SDK_KEY")
        case .invalidBaseURL:
            return fail("invalid_request")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let previousETag, !previousETag.isEmpty {
            request.setValue(previousETag, forHTTPHeaderField: "If-None-Match")
        }

        let raw: (Data, URLResponse)
        do {
            raw = try await session.data(for: request)
        } catch let error {
            return fail(Self.classify(error: error))
        }

        let (data, response) = raw
        guard let httpResponse = response as? HTTPURLResponse else {
            logger.error(
                "ConfigFetcher: non-HTTP response (sdkKey=\(SdkKey.redact(sdkKey)))"
            )
            return FetchResult(
                status: .failed, body: nil, etag: nil, error: "NON_HTTP_RESPONSE")
        }

        let etag =
            (httpResponse.allHeaderFields["Etag"] as? String)
            ?? (httpResponse.allHeaderFields["ETag"] as? String)
            ?? (httpResponse.value(forHTTPHeaderField: "ETag"))

        if httpResponse.statusCode == 304 {
            return FetchResult(status: .notModified, body: nil, etag: etag, error: nil)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            let reason = "HTTP \(httpResponse.statusCode)"
            logger.error(
                "ConfigFetcher: fetch failed (sdkKey=\(SdkKey.redact(sdkKey)), "
                    + "reason=\(reason))"
            )
            return FetchResult(status: .failed, body: nil, etag: nil, error: reason)
        }

        guard let body = String(data: data, encoding: .utf8) else {
            logger.error(
                "ConfigFetcher: non-UTF8 body (sdkKey=\(SdkKey.redact(sdkKey)))"
            )
            return FetchResult(
                status: .failed, body: nil, etag: nil, error: "NON_UTF8_BODY")
        }
        // Shape validation: a valid config_v6.json carries the
        // {p, f, s} top-level shape. sdk-node / sdk-browser-js /
        // sdk-bun / sdk-deno / sdk-python / sdk-go / sdk-rust ship
        // the same guard so the corpus-wide
        // `wire-cases.json::malformed-json-200` and `wrong-shape-200`
        // cases surface the same `parseFailed` everywhere (epic #146
        // / issue #148 / spec 112). Probing the `f` key alone is
        // sufficient — it is the only mandatory top-level key in the
        // schema. Without this guard the wire-cases corpus would
        // silently classify both cases as `fetched`, breaking
        // Principle II parity.
        guard
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            parsed["f"] != nil
        else {
            logger.error(
                "ConfigFetcher: fetched body failed shape check "
                    + "(sdkKey=\(SdkKey.redact(sdkKey)))"
            )
            return FetchResult(
                status: .failed, body: nil, etag: nil, error: "MALFORMED_JSON")
        }
        return FetchResult(status: .fetched, body: body, etag: etag, error: nil)
    }

    /// Logs a fixed reason code and returns it as a failed result.
    private func fail(_ reason: String) -> FetchResult {
        logger.error(
            "ConfigFetcher: fetch raised (sdkKey=\(SdkKey.redact(sdkKey)), reason=\(reason))"
        )
        return FetchResult(status: .failed, body: nil, etag: nil, error: reason)
    }

    /// Reduces a URLSession error to a FIXED, key-free reason code
    /// (#803 FR-002) — sdk-go's `classifyError` pattern. Only the
    /// error's identity (domain + code) picks the code; its message
    /// and `userInfo` quote the request URL, which holds the SDK key,
    /// and are never passed on. A mid-body reset surfaces here too:
    /// `data(for:)` throws instead of returning a truncated body.
    /// The ``RefreshErrorCode`` ConfigCat Swift reports for the same
    /// failure, from a failed result's key-free reason
    /// (`Sources/ConfigCat/ConfigFetcher.swift`, 11.3.1): 403 / 404 →
    /// `invalidSdkKey`, any other status → `unexpectedHttpResponse`, a
    /// timeout → `httpRequestTimeout`, any other transport error →
    /// `httpRequestFailure`, an unusable 200 body →
    /// `invalidHttpResponseContent`. A key refused before sending is
    /// `invalidSdkKey`; a base URL that cannot carry the request is
    /// `unexpectedError` (#833).
    static func refreshErrorCode(for reason: String?) -> RefreshErrorCode {
        switch reason {
        case "INVALID_SDK_KEY", "HTTP 403", "HTTP 404": return .invalidSdkKey
        case "timeout": return .httpRequestTimeout
        case "NON_UTF8_BODY", "MALFORMED_JSON": return .invalidHttpResponseContent
        case "NON_HTTP_RESPONSE": return .unexpectedHttpResponse
        case "invalid_request", nil: return .unexpectedError
        case let r? where r.hasPrefix("HTTP "): return .unexpectedHttpResponse
        default: return .httpRequestFailure
        }
    }

    static func classify(error: Error) -> String {
        if error is CancellationError {
            return "cancelled"
        }
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return "network_error" }
        switch ns.code {
        case NSURLErrorTimedOut: return "timeout"
        case NSURLErrorCancelled: return "cancelled"
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
            return "connect_error"
        case NSURLErrorNotConnectedToInternet: return "offline"
        case NSURLErrorNetworkConnectionLost: return "connection_lost"
        case NSURLErrorHTTPTooManyRedirects: return "too_many_redirects"
        default: return "url_error_\(ns.code)"
        }
    }
}
