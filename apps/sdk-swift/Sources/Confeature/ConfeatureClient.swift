// SPDX-License-Identifier: MIT

import Foundation

/// Options bundle for ``ConfeatureClient``. Mirrors `ConfigCat-iOS`'s
/// option-builder surface (option keys + defaults) without coupling
/// to the dependent type's name.
public struct ConfeatureClientOptions: @unchecked Sendable {
    /// Polling mode. Default: ``PollingMode/defaultMode`` (AutoPoll
    /// with 60 s / 5 s defaults).
    public var pollingMode: PollingMode

    /// CDN base URL. Default: `https://cdn-global.confeature.io`.
    public var baseURL: String?

    /// Per-request HTTP timeout in seconds. Default: 30 s.
    public var requestTimeout: TimeInterval

    /// Custom on-disk cache directory. Default:
    /// `FileManager.default.urls(for: .cachesDirectory, in:
    /// .userDomainMask).first / Confeature` (FR-014).
    public var cacheDirectory: URL?

    /// Customer-supplied ``ConfigCache`` instance. When set, it
    /// overrides ``cacheDirectory`` entirely (the SDK reads and
    /// writes via the supplied instance instead of touching the
    /// filesystem).
    public var configCache: ConfigCache?

    /// Customer-supplied ``Logger``. Default: ``OSLogger`` at
    /// ``LogLevel/error``.
    public var logger: Logger

    /// Flag-override bundle. Default: `nil` (no overrides).
    public var flagOverrides: FlagOverrides?

    /// Default ``User`` applied when ``ConfeatureClient/getValue(forKey:defaultValue:user:)``
    /// is called with `user = nil`.
    public var defaultUser: User?

    /// Customer-supplied URLSession (e.g. for tests / connection
    /// pool sharing). Default: ephemeral session created internally.
    public var urlSession: URLSession?

    /// When `true`, the client starts in offline mode — no HTTP calls
    /// are issued until ``ConfeatureClient/setOnline()`` is called.
    /// Default: `false`. Mirrors ConfigCat 11.3.1's `offline` option.
    public var offline: Bool

    /// Customer-supplied ``Hooks`` instance. When `nil`, the client
    /// creates a fresh ``Hooks`` at init. Pass an explicit instance
    /// to wire `onReady` / `onConfigChanged` / `onFlagEvaluated` /
    /// `onError` BEFORE the client begins fetching. Mirrors
    /// ConfigCat 11.3.1's `hooks` option.
    public var hooks: Hooks?

    public init(
        pollingMode: PollingMode = .defaultMode,
        baseURL: String? = nil,
        requestTimeout: TimeInterval = 30,
        cacheDirectory: URL? = nil,
        configCache: ConfigCache? = nil,
        logger: Logger = OSLogger(),
        flagOverrides: FlagOverrides? = nil,
        defaultUser: User? = nil,
        urlSession: URLSession? = nil,
        offline: Bool = false,
        hooks: Hooks? = nil
    ) {
        self.pollingMode = pollingMode
        self.baseURL = baseURL
        self.requestTimeout = requestTimeout
        self.cacheDirectory = cacheDirectory
        self.configCache = configCache
        self.logger = logger
        self.flagOverrides = flagOverrides
        self.defaultUser = defaultUser
        self.urlSession = urlSession
        self.offline = offline
        self.hooks = hooks
    }
}

/// Sentinel for the in-memory cache mode. Passing `URL(string:
/// ":memory:")` as ``ConfeatureClientOptions/cacheDirectory``
/// switches the cache to a pure-memory implementation — useful for
/// the parity-corpus tests where filesystem residue would leak
/// across runs.
public enum CacheDirectorySentinel {
    /// In-memory sentinel URL. Comparing
    /// `options.cacheDirectory?.path == CacheDirectorySentinel.memory.path`
    /// detects opt-in memory mode.
    public static let memory = URL(fileURLWithPath: ":memory:")
}

/// Top-level entry point of the Confeature Swift SDK. Mirrors
/// `ConfigCat-iOS`'s `ConfigCatClient` surface (constructor, factory,
/// `getValue` / `forceRefresh` / `close` / `snapshot`).
///
/// Migration from `ConfigCat-iOS` is two lines: swap the SwiftPM
/// dependency and replace `import ConfigCat` with
/// `import Confeature` (constitution Principle II — NON-NEGOTIABLE).
public final class ConfeatureClient: NSObject, @unchecked Sendable {
    private let sdkKey: String
    private let options: ConfeatureClientOptions
    private let logger: Logger
    private let fetcher: ConfigFetcher
    private let cache: ConfigCache
    private let cacheKey: String
    // Serial queue protects every mutable state slot below. Using a
    // queue (vs NSLock) keeps the locking calls usable from async
    // contexts under Swift 6 strict-concurrency mode.
    private let stateQueue = DispatchQueue(
        label: "io.confeature.sdk.client-state", qos: .userInitiated)
    private var cachedBody: [String: Any]?
    private var cachedETag: String?
    private var closed: Bool = false
    private var pollTask: Task<Void, Never>?

    // Spec 073 — new mutable state slots, all guarded by stateQueue.
    private var defaultUserSlot: User?
    private var offline: Bool
    private var fetchTime: Date
    private var readyState: ClientCacheState?
    private var readyContinuations: [UnsafeContinuation<ClientCacheState, Never>] = []

    /// Hooks event emitter. Captured at init from
    /// `options.hooks ?? Hooks()` and exposed as a public read-only
    /// property so customers can subscribe to lifecycle events.
    @objc public let hooks: Hooks

    /// Designated initializer. Constructs a client without performing
    /// any I/O — the eager initial fetch happens lazily on the first
    /// `getValue` or via the AutoPoll background task started below.
    ///
    /// Inherits `NSObject` (spec 073 — Principle II parity with
    /// `ConfigCat.ConfigCatClient: NSObject` + ObjC-bridge enablement).
    /// The designated init chains `super.init()` as required.
    ///
    /// NOT `@objc` because the `options:` parameter is a Swift struct
    /// (`ConfeatureClientOptions`) which cannot be bridged. ObjC
    /// consumers use ``initWithSdkKey(_:)`` for the no-options case
    /// or build options on the Swift side and pass them through.
    public init(
        sdkKey: String, options: ConfeatureClientOptions = ConfeatureClientOptions()
    ) {
        self.sdkKey = sdkKey
        self.options = options
        self.logger = options.logger
        self.cacheKey = SdkKey.deriveCacheKey(sdkKey)
        self.fetcher = ConfigFetcher(
            sdkKey: sdkKey,
            version: Version.sdk,
            baseURL: options.baseURL,
            timeout: options.requestTimeout,
            session: options.urlSession,
            logger: options.logger
        )
        self.defaultUserSlot = options.defaultUser
        self.offline = options.offline
        self.fetchTime = Date(timeIntervalSince1970: 0)
        self.hooks = options.hooks ?? Hooks()

        // Cache selection. Order of precedence:
        //   1. Customer-supplied ConfigCache instance.
        //   2. cacheDirectory == CacheDirectorySentinel.memory → in-memory.
        //   3. cacheDirectory set → FilesystemCache rooted there.
        //   4. Default: FilesystemCache rooted at FilesystemCache.defaultDirectory().
        if let customCache = options.configCache {
            self.cache = customCache
        } else if let dir = options.cacheDirectory,
            dir.path == CacheDirectorySentinel.memory.path
        {
            self.cache = InMemoryCache()
        } else {
            let directory = options.cacheDirectory ?? FilesystemCache.defaultDirectory()
            self.cache = FilesystemCache(
                directory: directory, sdkKey: sdkKey, logger: options.logger)
        }

        super.init()

        // Validate format AFTER cache wiring so a bad key still has a
        // working logger / cache pair (matches Rust + Python).
        if !SdkKey.isValidConfeatureKeyFormat(sdkKey) {
            logger.warning(
                "INVALID_SDK_KEY format; continuing — runtime is lenient "
                    + "(sdkKey=\(SdkKey.redact(sdkKey)))"
            )
        }

        // Restore any persisted entry so the first getValue can
        // resolve against on-disk state before the first fetch
        // lands.
        var restoredEntry = false
        if let raw = cache.read(forKey: cacheKey),
            let data = raw.data(using: .utf8),
            let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            stateQueue.sync {
                if let body = entry["body"] as? [String: Any] {
                    cachedBody = body
                    restoredEntry = true
                }
                if let etag = entry["etag"] as? String {
                    cachedETag = etag
                }
            }
        }

        // Ready-state transition for client kinds that complete their
        // initial readiness synchronously at init (spec 073 §4.8):
        // LocalOnly clients are immediately ready with override data;
        // ManualPoll / LazyLoad clients are ready once the cache
        // restore attempt has completed (either hasCachedFlagDataOnly
        // or noFlagData). AutoPoll fires its ready transition from
        // refreshOnce later.
        if isLocalOnly() {
            setReadyState(.hasLocalOverrideFlagDataOnly)
        } else if case .manualPoll = options.pollingMode {
            setReadyState(restoredEntry ? .hasCachedFlagDataOnly : .noFlagData)
        } else if case .lazyLoad = options.pollingMode {
            setReadyState(restoredEntry ? .hasCachedFlagDataOnly : .noFlagData)
        }

        // Start the AutoPoll task when applicable. LocalOnly
        // overrides skip the network path entirely (matches every
        // other SDK).
        if shouldStartPolling() {
            startPolling()
        }
    }

    /// Convenience factory mirroring ConfigCat-iOS's
    /// `ConfigCatClient.get(sdkKey:)` shape. Returns a fully-
    /// constructed client; no I/O is performed synchronously.
    public static func get(
        sdkKey: String, options: ConfeatureClientOptions = ConfeatureClientOptions()
    ) -> ConfeatureClient {
        ConfeatureClient(sdkKey: sdkKey, options: options)
    }

    /// Resolves `key` with the supplied `defaultValue`. Generic
    /// parameter `T` is one of ``Bool``, ``String``, ``Int``, or
    /// ``Double`` for the v1 four-type evaluator. Returns
    /// `defaultValue` when the client is closed, the cached config
    /// is empty (`NO_CONFIG`), the cached setting's `t` tag does
    /// not match `T` (`TYPE_MISMATCH`), the cached value slot is
    /// malformed (`MALFORMED_VALUE`), or the cached setting's `t`
    /// tag is truly unknown — only for a `t` outside `{0, 1, 2, 3}`
    /// (`UNSUPPORTED_TYPE`).
    public func getValue<T>(forKey key: String, defaultValue: T, user: User? = nil) async -> T {
        if isClosed() {
            logger.warning(
                "getValue called after close (sdkKey=\(SdkKey.redact(sdkKey)), key=\(key))"
            )
            return defaultValue
        }

        // LazyLoad triggers an on-demand refresh when the cache is
        // older than cacheRefreshInterval. The v1 implementation
        // refreshes on every call when LazyLoad is configured — a
        // future iteration can compare timestamps. ManualPoll does
        // not auto-fetch. AutoPoll's background task handles
        // freshness.
        if case .lazyLoad = options.pollingMode, !isLocalOnly(), !isOffline {
            await refreshOnce()
        }

        let snap = snapshot()
        let effectiveUser = user ?? stateQueue.sync { defaultUserSlot }
        let value: T = snap.getValue(
            forKey: key, defaultValue: defaultValue, user: effectiveUser)

        // O(1) bypass when no subscribers are present — avoids the
        // EvaluationDetails allocation on the hot path.
        if hooks.hasOnFlagEvaluatedHandlers() {
            let details = snap.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: effectiveUser,
                fetchTime: currentFetchTime())
            let bridge = EvaluationDetails(
                key: details.key,
                value: details.value,
                variationId: details.variationId,
                user: details.user,
                isDefaultValue: details.isDefaultValue,
                error: details.error,
                errorCode: details.errorCode,
                fetchTime: details.fetchTime
            )
            hooks.invokeOnFlagEvaluated(bridge)
        }

        return value
    }

    /// Resolves `key` and returns the full ``TypedEvaluationDetails``
    /// envelope. Mirrors ConfigCat 11.3.1's
    /// `getValueDetails<Value>(for:defaultValue:user:)`.
    public func getValueDetails<T>(
        forKey key: String, defaultValue: T, user: User? = nil
    ) async -> TypedEvaluationDetails<T> {
        if isClosed() {
            return TypedEvaluationDetails<T>.fromError(
                key: key, value: defaultValue, user: user,
                error: "CLIENT_CLOSED", errorCode: .unexpectedError,
                fetchTime: currentFetchTime())
        }
        if case .lazyLoad = options.pollingMode, !isLocalOnly(), !isOffline {
            await refreshOnce()
        }
        let effectiveUser = user ?? stateQueue.sync { defaultUserSlot }
        let details = snapshot().getValueDetails(
            forKey: key, defaultValue: defaultValue, user: effectiveUser,
            fetchTime: currentFetchTime())
        if hooks.hasOnFlagEvaluatedHandlers() {
            let bridge = EvaluationDetails(
                key: details.key,
                value: details.value,
                variationId: details.variationId,
                user: details.user,
                isDefaultValue: details.isDefaultValue,
                error: details.error,
                errorCode: details.errorCode,
                fetchTime: details.fetchTime
            )
            hooks.invokeOnFlagEvaluated(bridge)
        }
        return details
    }

    /// Returns the full ``EvaluationDetails`` envelope for every key
    /// in the cache + overrides. Mirrors ConfigCat 11.3.1's
    /// `getAllValueDetails(user:)`.
    public func getAllValueDetails(user: User? = nil) async -> [EvaluationDetails] {
        if isClosed() { return [] }
        let effectiveUser = user ?? stateQueue.sync { defaultUserSlot }
        return snapshot().getAllValueDetails(
            user: effectiveUser, fetchTime: currentFetchTime())
    }

    /// Returns every key/value in the cache + override map. Values
    /// are `Any` because each setting may have a different type.
    /// Mirrors ConfigCat 11.3.1's `getAllValues(user:)`.
    public func getAllValues(user: User? = nil) async -> [String: Any] {
        if isClosed() { return [:] }
        let effectiveUser = user ?? stateQueue.sync { defaultUserSlot }
        return snapshot().getAllValues(user: effectiveUser)
    }

    /// Returns every key present in the cache + override map. Sorted
    /// ascending. Mirrors ConfigCat 11.3.1's `getAllKeys()`.
    @objc public func getAllKeys() async -> [String] {
        if isClosed() { return [] }
        return snapshot().getAllKeys()
    }

    /// Looks up the `KeyValue` whose setting has the given
    /// `variationId`. Returns `nil` if no setting matches. v1 only
    /// scans top-level setting identifiers — does NOT iterate
    /// targeting rules or percentage options.
    @objc public func getKeyAndValue(for variationId: String) async -> KeyValue? {
        if isClosed() { return nil }
        return snapshot().getKeyAndValue(for: variationId)
    }

    /// Returns an immutable ``Snapshot`` of the last-known config
    /// plus a detached reference to the flag-override bundle.
    @objc public func snapshot() -> Snapshot {
        let bodyCopy = stateQueue.sync { cachedBody }
        let defaultUser = stateQueue.sync { defaultUserSlot }
        return Snapshot(
            config: bodyCopy,
            overrides: options.flagOverrides,
            defaultUser: defaultUser
        )
    }

    /// Triggers an immediate fetch + cache update. Returns a
    /// ``RefreshResult`` carrying success/failure plus a typed
    /// ``RefreshErrorCode``.
    ///
    /// **Pre-1.0 BC change (FR-018)**: the return type was `Void` in
    /// the prior boolean-only SDK; it is now `RefreshResult` so
    /// callers can inspect the outcome. Existing call sites that
    /// ignore the result should discard explicitly via `_ = await
    /// client.forceRefresh()`.
    @objc public func forceRefresh() async -> RefreshResult {
        if isClosed() {
            return RefreshResult(
                isSuccess: false, errorMessage: "Client is closed",
                errorCode: .unexpectedError)
        }
        if isLocalOnly() {
            let msg = "Client is configured to use the localOnly override behavior"
            logger.warning(msg)
            return RefreshResult(
                isSuccess: false, errorMessage: msg, errorCode: .localOnlyClient)
        }
        if isOffline {
            let msg = "Client is in offline mode, it cannot initiate HTTP calls"
            logger.warning(msg)
            return RefreshResult(
                isSuccess: false, errorMessage: msg, errorCode: .offlineClient)
        }
        await refreshOnce()
        return RefreshResult(isSuccess: true, errorMessage: nil, errorCode: .none)
    }

    /// Overrides ``ConfeatureClientOptions/defaultUser`` at runtime.
    /// Subsequent `getValue(..., user: nil)` calls consume this user.
    ///
    /// NOT `@objc` because ``User`` is a Swift struct.
    public func setDefaultUser(_ user: User) {
        stateQueue.sync { defaultUserSlot = user }
    }

    /// Reverts the default-user override set via ``setDefaultUser(_:)``
    /// (or ``ConfeatureClientOptions/defaultUser``) to `nil`.
    @objc public func clearDefaultUser() {
        stateQueue.sync { defaultUserSlot = nil }
    }

    /// Switches the client to ONLINE mode. If the client was started
    /// in `offline: true` AutoPoll mode (so polling was never started),
    /// `setOnline()` starts polling now.
    @objc public func setOnline() {
        let needsStart: Bool = stateQueue.sync { () -> Bool in
            let wasOffline = offline
            offline = false
            return wasOffline && shouldStartPollingLocked() && pollTask == nil
        }
        if needsStart {
            startPolling()
        }
        logger.info("Switched to ONLINE mode")
    }

    /// Switches the client to OFFLINE mode. AutoPoll's background
    /// task does NOT get cancelled — it keeps sleeping + rechecking
    /// the `offline` flag, so a later `setOnline()` resumes fetches
    /// without re-starting the task.
    @objc public func setOffline() {
        stateQueue.sync { offline = true }
        logger.info("Switched to OFFLINE mode")
    }

    /// `true` if the client is in offline mode.
    @objc public var isOffline: Bool {
        stateQueue.sync { offline }
    }

    /// Suspends until the client's first ready-state transition fires
    /// (LocalOnly init / first successful AutoPoll fetch / cache
    /// restore for ManualPoll & LazyLoad). Returns the captured
    /// ``ClientCacheState``. Late callers receive the captured state
    /// immediately.
    @objc public func waitForReady() async -> ClientCacheState {
        if let captured = stateQueue.sync(execute: { readyState }) {
            return captured
        }
        return await withUnsafeContinuation {
            (continuation: UnsafeContinuation<ClientCacheState, Never>) in
            let resumeNow: ClientCacheState? = stateQueue.sync {
                if let s = readyState {
                    return s
                }
                readyContinuations.append(continuation)
                return nil
            }
            if let s = resumeNow {
                continuation.resume(returning: s)
            }
        }
    }

    /// Idempotent close. Cancels the background AutoPoll task, clears
    /// hooks subscribers, and drains pending `waitForReady`
    /// continuations with ``ClientCacheState/noFlagData`` so callers
    /// don't leak.
    @objc public func close() {
        let (alreadyClosed, task, pendingContinuations) =
            stateQueue.sync {
                () -> (Bool, Task<Void, Never>?, [UnsafeContinuation<ClientCacheState, Never>]) in
                let was = closed
                closed = true
                let t = pollTask
                pollTask = nil
                let conts = readyContinuations
                readyContinuations.removeAll()
                return (was, t, conts)
            }
        if !alreadyClosed {
            task?.cancel()
            for continuation in pendingContinuations {
                continuation.resume(returning: .noFlagData)
            }
            hooks.clear()
        }
    }

    deinit {
        close()
    }

    // MARK: - Internal

    private func isClosed() -> Bool {
        stateQueue.sync { closed }
    }

    private func isLocalOnly() -> Bool {
        options.flagOverrides?.behaviour == .localOnly
    }

    private func shouldStartPolling() -> Bool {
        if isLocalOnly() { return false }
        if isOffline { return false }
        if case .autoPoll = options.pollingMode { return true }
        return false
    }

    /// Variant of ``shouldStartPolling()`` callable from inside the
    /// `stateQueue.sync { ... }` critical section — does NOT
    /// re-acquire `stateQueue` (would deadlock on a serial queue).
    private func shouldStartPollingLocked() -> Bool {
        if isLocalOnly() { return false }
        if offline { return false }
        if case .autoPoll = options.pollingMode { return true }
        return false
    }

    private func startPolling() {
        guard case .autoPoll(let interval, _) = options.pollingMode else { return }
        let task = Task { [weak self] in
            // First fetch immediately, then sleep / loop.
            while !Task.isCancelled {
                if self?.isOffline == true {
                    // Spec 073: skip the fetch when offline, but keep
                    // the task alive so a later `setOnline()` resumes
                    // polling without re-creating the Task.
                    let nanos = UInt64(max(interval, 0.001) * 1_000_000_000)
                    try? await Task.sleep(nanoseconds: nanos)
                    continue
                }
                await self?.refreshOnce()
                if Task.isCancelled { break }
                let nanos = UInt64(max(interval, 0.001) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
            }
        }
        stateQueue.sync {
            pollTask = task
        }
    }

    private func refreshOnce() async {
        let previousETag = stateQueue.sync { cachedETag }

        let result = await fetcher.fetch(previousETag: previousETag)
        switch result.status {
        case .fetched:
            guard let body = result.body,
                let data = body.data(using: .utf8),
                let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                let msg =
                    "ConfeatureClient: fetched body failed to parse "
                    + "(sdkKey=\(SdkKey.redact(sdkKey)))"
                logger.error(msg)
                hooks.invokeOnError(msg)
                // First fetch failed — fire the ready transition for
                // AutoPoll clients so `waitForReady` doesn't hang.
                if case .autoPoll = options.pollingMode {
                    setReadyState(.noFlagData)
                }
                return
            }
            let etagChanged = stateQueue.sync { () -> Bool in
                let changed = (cachedETag != result.etag) || (cachedBody == nil)
                cachedBody = parsed
                cachedETag = result.etag
                fetchTime = Date()
                return changed
            }
            persist(body: body, etag: result.etag ?? "")
            if etagChanged {
                hooks.invokeOnConfigChanged(parsed)
            }
            if case .autoPoll = options.pollingMode {
                setReadyState(.hasUpToDateFlagData)
            }
        case .notModified:
            if let etag = result.etag {
                stateQueue.sync {
                    cachedETag = etag
                    fetchTime = Date()
                }
            } else {
                stateQueue.sync { fetchTime = Date() }
            }
            if case .autoPoll = options.pollingMode {
                setReadyState(.hasUpToDateFlagData)
            }
        case .failed:
            // Already logged inside ConfigFetcher; first-fetch
            // failure still fires the ready transition for AutoPoll
            // clients so `waitForReady` doesn't hang.
            if case .autoPoll = options.pollingMode {
                let hasCache = stateQueue.sync { cachedBody != nil }
                setReadyState(hasCache ? .hasCachedFlagDataOnly : .noFlagData)
            }
        }
    }

    /// Returns the most recent `fetchTime` (epoch on a fresh client
    /// that has never fetched).
    internal func currentFetchTime() -> Date {
        stateQueue.sync { fetchTime }
    }

    /// Fires the ready-state transition exactly once. Idempotent —
    /// subsequent calls are no-ops. Drains pending `waitForReady`
    /// continuations and fans out to `hooks.invokeOnReady(_:)`.
    private func setReadyState(_ state: ClientCacheState) {
        let toResume: [UnsafeContinuation<ClientCacheState, Never>] =
            stateQueue.sync { () -> [UnsafeContinuation<ClientCacheState, Never>] in
                guard readyState == nil else { return [] }
                readyState = state
                let list = readyContinuations
                readyContinuations.removeAll()
                return list
            }
        for continuation in toResume {
            continuation.resume(returning: state)
        }
        hooks.invokeOnReady(state)
    }

    private func persist(body: String, etag: String) {
        // Serialize as `{"body": <parsed>, "etag": "..."}` so reads
        // can restore both halves without re-fetching ETag from
        // disk. JSONSerialization keeps key ordering stable enough
        // for the SDK's needs (key order is not part of the wire
        // contract).
        guard let bodyData = body.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: bodyData)
        else {
            return
        }
        let envelope: [String: Any] = ["body": parsed, "etag": etag]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: []),
            let serialised = String(data: data, encoding: .utf8)
        else {
            return
        }
        cache.write(value: serialised, forKey: cacheKey)
    }
}

// MARK: - Objective-C bridge surface (spec 073 / FR-027)
//
// Per-type ObjC bridges that wrap the generic `getValue<T>` /
// `getValueDetails<T>` into a non-generic, completion-handler shape
// ObjC consumers can call. Mirrors ConfigCat 11.3.1's typed bridges
// in `Sources/ConfigCat/Extensions.swift:4-145`.
//
// Each `*Value` bridge wraps `getValue<T>` and returns the typed
// value via completion. Each `*ValueDetails` bridge wraps
// `getValueDetails<T>` and adapts the generic envelope into the
// concrete per-type ObjC box from `TypedEvaluationDetailsObjc.swift`.
//
// User parameter: bridges accept ``ConfeatureUser?`` (the ObjC bridge
// wrapper over the Swift ``User`` struct) so ObjC consumers can pass
// a user just like ConfigCat's `ConfigCatUser: NSObject` allows. The
// wrapper converts to the internal `User?` via ``ConfeatureUser/coreUser``
// before the evaluator call.

extension ConfeatureClient {
    /// ObjC bridge for `getValue<String>`.
    @objc public func getStringValue(
        for key: String, defaultValue: String, user: ConfeatureUser? = nil,
        completion: @escaping (String) -> Void
    ) {
        Task {
            let value: String = await self.getValue(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(value)
        }
    }

    /// ObjC bridge for `getValue<Int>`.
    @objc public func getIntValue(
        for key: String, defaultValue: Int, user: ConfeatureUser? = nil,
        completion: @escaping (Int) -> Void
    ) {
        Task {
            let value: Int = await self.getValue(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(value)
        }
    }

    /// ObjC bridge for `getValue<Double>`.
    @objc public func getDoubleValue(
        for key: String, defaultValue: Double, user: ConfeatureUser? = nil,
        completion: @escaping (Double) -> Void
    ) {
        Task {
            let value: Double = await self.getValue(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(value)
        }
    }

    /// ObjC bridge for `getValue<Bool>`.
    @objc public func getBoolValue(
        for key: String, defaultValue: Bool, user: ConfeatureUser? = nil,
        completion: @escaping (Bool) -> Void
    ) {
        Task {
            let value: Bool = await self.getValue(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(value)
        }
    }

    /// ObjC bridge for `getValue<Any>`.
    @objc public func getAnyValue(
        for key: String, defaultValue: Any, user: ConfeatureUser? = nil,
        completion: @escaping (Any) -> Void
    ) {
        Task {
            let value: Any = await self.getValue(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(value)
        }
    }

    /// ObjC bridge for `getValueDetails<String>`.
    @objc public func getStringValueDetails(
        for key: String, defaultValue: String, user: ConfeatureUser? = nil,
        completion: @escaping (StringEvaluationDetails) -> Void
    ) {
        Task {
            let typed: TypedEvaluationDetails<String> = await self.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(StringEvaluationDetails.fromTyped(typed))
        }
    }

    /// ObjC bridge for `getValueDetails<Int>`.
    @objc public func getIntValueDetails(
        for key: String, defaultValue: Int, user: ConfeatureUser? = nil,
        completion: @escaping (IntEvaluationDetails) -> Void
    ) {
        Task {
            let typed: TypedEvaluationDetails<Int> = await self.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(IntEvaluationDetails.fromTyped(typed))
        }
    }

    /// ObjC bridge for `getValueDetails<Double>`.
    @objc public func getDoubleValueDetails(
        for key: String, defaultValue: Double, user: ConfeatureUser? = nil,
        completion: @escaping (DoubleEvaluationDetails) -> Void
    ) {
        Task {
            let typed: TypedEvaluationDetails<Double> = await self.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(DoubleEvaluationDetails.fromTyped(typed))
        }
    }

    /// ObjC bridge for `getValueDetails<Bool>`.
    @objc public func getBoolValueDetails(
        for key: String, defaultValue: Bool, user: ConfeatureUser? = nil,
        completion: @escaping (BoolEvaluationDetails) -> Void
    ) {
        Task {
            let typed: TypedEvaluationDetails<Bool> = await self.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            completion(BoolEvaluationDetails.fromTyped(typed))
        }
    }

    /// ObjC bridge for `getValueDetails<Any>`. Returns the
    /// non-generic ``EvaluationDetails`` (no per-type subclass
    /// because `Any` would defeat the point).
    @objc public func getAnyValueDetails(
        for key: String, defaultValue: Any, user: ConfeatureUser? = nil,
        completion: @escaping (EvaluationDetails) -> Void
    ) {
        Task {
            let typed: TypedEvaluationDetails<Any> = await self.getValueDetails(
                forKey: key, defaultValue: defaultValue, user: user?.coreUser)
            let bridge = EvaluationDetails(
                key: typed.key,
                value: typed.value,
                variationId: typed.variationId,
                user: typed.user,
                isDefaultValue: typed.isDefaultValue,
                error: typed.error,
                errorCode: typed.errorCode,
                fetchTime: typed.fetchTime
            )
            completion(bridge)
        }
    }

    /// ObjC bridge for ``setDefaultUser(_:)``. Accepts the ObjC bridge
    /// wrapper (the Swift-struct form is unavailable from ObjC).
    @objc public func setDefaultUser(_ user: ConfeatureUser) {
        self.setDefaultUser(user.coreUser)
    }
}
