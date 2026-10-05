// SPDX-License-Identifier: MIT

import Foundation

/// State of the client's local cache at the moment the
/// ``ConfeatureClient/waitForReady()`` barrier resolves, plus the
/// argument to ``Hooks/onReady(_:)``.
///
/// Mirrors ConfigCat 11.3.1's `ClientCacheState`
/// (`Sources/ConfigCat/ConfigCatOptions.swift:51`) 1:1 — same case
/// names, same raw integer values.
///
/// The raw integers MUST stay stable: the `@objc` bridge encodes
/// these as `NSInteger` and Objective-C consumers may compare against
/// the raw values.
@objc public enum ClientCacheState: Int {
    /// No flag data — neither a fetched config nor an override map
    /// is available.
    case noFlagData = 0

    /// Only local override flag data is available (LocalOnly client
    /// with override map; no remote fetch).
    case hasLocalOverrideFlagDataOnly = 1

    /// Cached flag data is available but may be stale (no successful
    /// fetch yet this session).
    case hasCachedFlagDataOnly = 2

    /// Cached flag data is up to date (first successful fetch in this
    /// session has completed).
    case hasUpToDateFlagData = 3
}
