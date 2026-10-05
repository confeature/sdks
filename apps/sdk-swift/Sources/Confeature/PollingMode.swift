// SPDX-License-Identifier: MIT

import Foundation

/// How the SDK keeps the cached config fresh.
///
/// Mirrors the upstream `ConfigCat-iOS` `PollingMode` enum (variants,
/// factory-method names, defaults). Customers construct values via the
/// associated-value cases — `.autoPoll(pollInterval:maxInitWaitTime:)`,
/// `.lazyLoad(cacheRefreshInterval:)`, and `.manualPoll` — or via the
/// ``defaultAutoPoll``, ``defaultLazyLoad``, and ``defaultMode`` static
/// helpers that bake in ConfigCat's documented defaults (60 s / 5 s).
public enum PollingMode: Sendable, Equatable {
    /// Background-task polling.
    case autoPoll(pollInterval: TimeInterval, maxInitWaitTime: TimeInterval)
    /// On-demand fetch when the cached entry is older than
    /// `cacheRefreshInterval`.
    case lazyLoad(cacheRefreshInterval: TimeInterval)
    /// No automatic fetches; the customer drives
    /// ``ConfeatureClient/forceRefresh()`` explicitly.
    case manualPoll

    /// Returns the ``autoPoll(pollInterval:maxInitWaitTime:)`` case
    /// with ConfigCat's documented defaults (60 s / 5 s).
    public static var defaultAutoPoll: PollingMode {
        .autoPoll(pollInterval: 60, maxInitWaitTime: 5)
    }

    /// Returns the ``lazyLoad(cacheRefreshInterval:)`` case with
    /// ConfigCat's documented default (60 s).
    public static var defaultLazyLoad: PollingMode {
        .lazyLoad(cacheRefreshInterval: 60)
    }

    /// Default polling mode: ``autoPoll(pollInterval:maxInitWaitTime:)``
    /// with the documented 60 s / 5 s defaults.
    public static var defaultMode: PollingMode { .defaultAutoPoll }
}
