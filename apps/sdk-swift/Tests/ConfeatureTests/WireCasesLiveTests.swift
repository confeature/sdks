// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// sdk-swift live wire-cases (#924, after sdk-go's #921).
///
/// sdk-swift's own ``ConfigFetcher``, on its real `URLSession` stack, against
/// a RUNNING live-contract harness serving the reference origin of the CDN
/// read path. Every seeded wire-case is replayed and judged by
/// ``WireCaseAssertions``, the SAME rules the hermetic suite
/// (``WireCasesTests``) applies to a `URLProtocol` mock. Nothing is
/// hand-built and no admin write is made:
///
///   - the case set comes from the running harness (`GET /admin/state` ->
///     `keys`), never recomputed from the corpus: `http-403` among them, an
///     unseeded key answered by the Worker itself;
///   - the request each case sent is read back from the harness
///     (`GET /admin/requests?sdkKey=`), so the key and If-None-Match are
///     judged on the wire, and each fetch must add exactly one entry;
///   - a timeout case is ended by the SDK's OWN deadline (the fetcher's
///     timeout, a quarter of the harness's hold);
///   - US4: one unseeded key reaches the Worker's own unknown-key answer.
///
/// It runs through the harness wrapper, the manifest's `liveSuite.runner`,
/// natively in sdk-gates.yml's macOS job (run-live-suite.mjs): the runner
/// filters `swift test` to this class and requires that it ran its tests
/// with none skipped.
///
/// GATING (fail closed): skipped only when CONFEATURE_LIVE is unset, the
/// hermetic `swift test`. Set without LIVE_HARNESS_URL, or with a harness
/// that does not answer, it FAILS; it never skips.
final class WireCasesLiveTests: XCTestCase {
    private static let sdkVersion = "0.0.0-live-wire"

    /// The running harness's base URL, or a skip (hermetic run) or a
    /// failure (live run with no harness named).
    private func harnessBase() throws -> String? {
        let env = ProcessInfo.processInfo.environment
        guard env["CONFEATURE_LIVE"] == "1" else {
            throw XCTSkip("hermetic run: CONFEATURE_LIVE is not set")
        }
        guard let base = env["LIVE_HARNESS_URL"], !base.isEmpty else {
            XCTFail(
                "CONFEATURE_LIVE=1 but LIVE_HARNESS_URL is not set — run through "
                    + "`live-contract-harness --corpus-seed --exec -- …`; a live suite must never "
                    + "pass by skipping")
            return nil
        }
        return base.hasSuffix("/") ? String(base.dropLast()) : base
    }

    /// The harness's JSON answer to `GET <base><path>`, or a thrown error
    /// naming the path.
    private func harnessJSON(_ base: String, _ path: String) async throws -> [String: Any] {
        guard let url = URL(string: base + path) else {
            throw LiveError("harness URL \(base + path) does not parse")
        }
        let (data, response) = try await URLSession(configuration: .ephemeral).data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw LiveError(
                "harness \(path) answered \(status): \(String(decoding: data, as: UTF8.self))")
        }
        return json
    }

    /// The requests the harness logged for `sdkKey`, oldest first.
    private func requests(_ base: String, _ sdkKey: String) async throws -> [[String: Any]] {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "sdkKey", value: sdkKey)]
        let body = try await harnessJSON(
            base, "/admin/requests?" + (query.percentEncodedQuery ?? ""))
        guard body["ok"] as? Bool == true, let log = body["requests"] as? [[String: Any]] else {
            throw LiveError("harness refused /admin/requests: \(body["error"] ?? "no log")")
        }
        return log
    }

    /// Replays every seeded case. Each case is judged on its own: a case
    /// that fails is reported and the next one still runs.
    func testWireCasesLive() async throws {
        guard let base = try harnessBase() else { return }
        let state = try await harnessJSON(base, "/admin/state")
        let ids = ((state["keys"] as? [String]) ?? []).sorted()
        XCTAssertFalse(
            ids.isEmpty, "the harness reports no seeded case — an empty run checks nothing")
        let faults = (state["faults"] as? [String: Any]) ?? [:]
        let corpus = Dictionary(
            try WireCaseAssertions.loadCorpus().map { (WireCaseAssertions.id($0), $0) },
            uniquingKeysWith: { first, _ in first })
        for id in ids {
            guard let wireCase = corpus[id] else {
                XCTFail("seeded key \(id) is missing from the corpus")
                continue
            }
            do {
                try await runLiveCase(wireCase, base: base, fault: faults[id] as? [String: Any])
            } catch {
                XCTFail("case \(id): \(error)")
            }
        }
    }

    private func runLiveCase(
        _ wireCase: WireCaseAssertions.WireCase, base: String, fault: [String: Any]?
    ) async throws {
        let id = WireCaseAssertions.id(wireCase)
        let unknown = WireCaseAssertions.unknownFields(wireCase)
        guard unknown.isEmpty else {
            XCTFail("case \(id): unknown corpus field(s) \(unknown) — read them first")
            return
        }
        // A timeout case: the SDK's own deadline, a quarter of the hold,
        // must end the fetch, not the harness releasing it (#783 A8).
        var hold: TimeInterval = 0
        if (WireCaseAssertions.server(wireCase)["behavior"] as? String) == "timeout" {
            guard let ms = fault?["ms"] as? Int, ms > 0 else {
                XCTFail("case \(id) is seeded without a timeout fault")
                return
            }
            hold = TimeInterval(ms) / 1000
        }
        // The harness seeds each case under its id; a case pinning
        // given.sdkKey is configured with that key instead (#803 FR-003).
        let sdkKey = WireCaseAssertions.sdkKey(for: wireCase, default: id)
        let before = try await requests(base, sdkKey).count
        let fetcher = ConfigFetcher(
            sdkKey: sdkKey, version: Self.sdkVersion, baseURL: base,
            timeout: hold > 0 ? hold / 4 : 10, logger: NoOpLogger())
        let started = Date()
        let result = await fetcher.fetch(previousETag: WireCaseAssertions.previousETag(wireCase))
        let elapsed = Date().timeIntervalSince(started)

        let log = try await requests(base, sdkKey)
        // Exactly one request per fetch: a retrying SDK, or a request an
        // earlier run logged, must not stand in for the one under test.
        guard log.count - before == 1, let last = log.last, let target = last["url"] as? String
        else {
            XCTFail("case \(id): one fetch sent \(log.count - before) requests, not exactly one")
            return
        }
        if hold > 0 {
            XCTAssertLessThan(
                elapsed, hold, "case \(id): took \(elapsed) s, the harness holds \(hold) s")
        }
        let path = String(
            target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        WireCaseAssertions.assertWireCase(
            wireCase, sdkKey: sdkKey,
            sent: .init(path: path, url: target, ifNoneMatch: last["ifNoneMatch"] as? String),
            result: result)
    }

    /// US4: no seed, no fault — the CDN's own unknown-key answer,
    /// ConfigCat's 403 since #785, classed like a 404 as invalidSdkKey.
    func testUnseededKey() async throws {
        guard let base = try harnessBase() else { return }
        let fetcher = ConfigFetcher(
            sdkKey: "never-seeded-924", version: Self.sdkVersion, baseURL: base, timeout: 10,
            logger: NoOpLogger())
        let result = await fetcher.fetch(previousETag: nil)
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(
            WireCaseAssertions.errorClass(result.error), "invalidSdkKey",
            "raw error=\(String(describing: result.error))")
    }
}

/// A harness answer the live suite cannot use.
private struct LiveError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
