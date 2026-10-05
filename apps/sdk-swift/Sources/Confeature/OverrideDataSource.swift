// SPDX-License-Identifier: MIT

import Foundation

/// Source of override values.
///
/// Customers implementing this protocol MUST return a stable
/// dictionary from ``getOverridesSync()`` — the override-eval helper
/// consults it on every flag evaluation. A `nil` return signals "no
/// synchronous data" and falls through to the cached remote config
/// (Branch 3 of the decision tree).
public protocol OverrideDataSource: Sendable {
    /// Returns the override map synchronously, or `nil` to signal
    /// "no sync data".
    func getOverridesSync() -> [String: Any]?
}
