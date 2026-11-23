// SPDX-License-Identifier: MIT

import Confeature
import ConfeatureOpenFeature
import Foundation
import OpenFeature
import XCTest

final class LoopbackTests: XCTestCase {
    private static let sdkKey =
        "confeature-sdk-1-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"

    func testNativeManualAndAutoPollOwnRequestsAndRecoverCachedEvaluation() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CONFEATURE_LIVE"] == "1" else {
            throw XCTSkip("Run the HTTP case through the seeded live-contract harness.")
        }
        let origin = try XCTUnwrap(ExactOriginGuard.origin)
        let session = newSession()
        defer { session.invalidateAndCancel() }
        let initial = try await requests(origin, session: session)

        let manual = nativeClient(polling: .manualPoll, origin: origin, session: session)
        defer { manual.close() }
        let manualProvider = ConfeatureProvider(client: manual)
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: manualProvider)
        let flags = api.getClient()
        let cold = flags.getBooleanDetails(key: "loopback", defaultValue: false)
        XCTAssertFalse(cold.value)
        XCTAssertEqual(cold.errorCode, .providerNotReady)
        let afterCold = try await requests(origin, session: session)
        XCTAssertEqual(afterCold.count, initial.count)

        let refresh = await manual.forceRefresh()
        XCTAssertTrue(refresh.isSuccess)
        let ready = flags.getBooleanDetails(key: "loopback", defaultValue: true)
        XCTAssertTrue(ready.value)
        XCTAssertNil(ready.errorCode)
        XCTAssertEqual(ready.variant, "served")
        let afterRefresh = try await requests(origin, session: session)
        XCTAssertEqual(afterRefresh.count, initial.count + 1)

        manual.setOffline()
        XCTAssertTrue(flags.getBooleanValue(key: "loopback", defaultValue: false))
        let offline = try await requests(origin, session: session)
        XCTAssertEqual(offline.count, afterRefresh.count)
        manual.setOnline()
        let reconnect = await manual.forceRefresh()
        XCTAssertTrue(reconnect.isSuccess)
        let reconnected = try await requests(origin, session: session)
        XCTAssertEqual(reconnected.count, offline.count + 1)
        XCTAssertEqual(reconnected.last?["ifNoneMatch"] as? String, "\"swift-provider\"")
        manualProvider.dispose()
        await api.clearProviderAndWait()
        let borrowedValue = await manual.getValue(forKey: "loopback", defaultValue: false)
        XCTAssertTrue(borrowedValue)

        let automatic = nativeClient(
            polling: .autoPoll(pollInterval: 3600, maxInitWaitTime: 3),
            origin: origin, session: session)
        defer { automatic.close() }
        let autoApi = OpenFeatureAPI()
        let autoProvider = ConfeatureProvider(client: automatic)
        await autoApi.setProviderAndWait(provider: autoProvider)
        _ = await automatic.waitForReady()
        XCTAssertTrue(autoApi.getClient().getBooleanValue(key: "loopback", defaultValue: false))
        let afterAutomatic = try await requests(origin, session: session)
        XCTAssertEqual(afterAutomatic.count, reconnected.count + 1)
        autoProvider.dispose()
        await autoApi.clearProviderAndWait()

        let refused = try XCTUnwrap(URL(string: "http://127.0.0.1:1/"))
        do {
            _ = try await session.data(from: refused)
            XCTFail("The network guard accepted an out-of-origin URL.")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .unsupportedURL)
        }
    }

    func testLazyLoadOnlyFetchesThroughNativeAsyncEvaluation() async throws {
        guard ProcessInfo.processInfo.environment["CONFEATURE_LIVE"] == "1" else {
            throw XCTSkip("Run the HTTP case through the seeded live-contract harness.")
        }
        let origin = try XCTUnwrap(ExactOriginGuard.origin)
        let session = newSession()
        defer { session.invalidateAndCancel() }
        let initialCount = try await requests(origin, session: session).count

        let native = nativeClient(
            polling: .lazyLoad(cacheRefreshInterval: 0), origin: origin, session: session)
        defer { native.close() }
        let provider = ConfeatureProvider(client: native)
        let api = OpenFeatureAPI()
        await api.setProviderAndWait(provider: provider)
        let flags = api.getClient()
        let cold = flags.getBooleanDetails(key: "loopback", defaultValue: false)
        XCTAssertFalse(cold.value)
        XCTAssertEqual(cold.errorCode, .providerNotReady)
        let coldCount = try await requests(origin, session: session).count
        XCTAssertEqual(coldCount, initialCount)

        let nativeValue = await native.getValue(forKey: "loopback", defaultValue: false)
        XCTAssertTrue(nativeValue)
        let refreshedCount = try await requests(origin, session: session).count
        XCTAssertEqual(refreshedCount, initialCount + 1)

        let cached = flags.getBooleanDetails(key: "loopback", defaultValue: false)
        XCTAssertTrue(cached.value)
        XCTAssertNil(cached.errorCode)
        XCTAssertEqual(cached.variant, "served")
        let cachedCount = try await requests(origin, session: session).count
        XCTAssertEqual(cachedCount, refreshedCount)
        provider.dispose()
        await api.clearProviderAndWait()
    }

    private func nativeClient(
        polling: PollingMode, origin: URL, session: URLSession
    ) -> ConfeatureClient {
        ConfeatureClient(
            sdkKey: Self.sdkKey,
            options: ConfeatureClientOptions(
                pollingMode: polling, baseURL: origin.absoluteString,
                requestTimeout: 3, cacheDirectory: CacheDirectorySentinel.memory,
                logger: NoOpLogger(), urlSession: session))
    }

    private func newSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ExactOriginGuard.self]
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config, delegate: RejectRedirects(), delegateQueue: nil)
    }

    private func requests(_ origin: URL, session: URLSession) async throws -> [[String: Any]] {
        var url = try XCTUnwrap(URLComponents(url: origin, resolvingAgainstBaseURL: false))
        url.path = "/admin/requests"
        url.queryItems = [URLQueryItem(name: "sdkKey", value: Self.sdkKey)]
        let (data, response) = try await session.data(from: XCTUnwrap(url.url))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(document["requests"] as? [[String: Any]])
    }
}

private final class ExactOriginGuard: URLProtocol {
    static let origin: URL? = {
        let raw = ProcessInfo.processInfo.environment["LIVE_HARNESS_URL"] ?? ""
        guard let parts = URLComponents(string: raw), parts.scheme == "http",
            parts.host == "127.0.0.1", let port = parts.port, (1024...65535).contains(port),
            parts.path.isEmpty, parts.user == nil, parts.password == nil,
            parts.query == nil, parts.fragment == nil
        else { return nil }
        return parts.url
    }()

    override class func canInit(with request: URLRequest) -> Bool {
        guard let origin, let url = request.url else { return true }
        return url.scheme != origin.scheme || url.host != origin.host || url.port != origin.port
            || url.user != nil || url.password != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }

    override func stopLoading() {}
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
