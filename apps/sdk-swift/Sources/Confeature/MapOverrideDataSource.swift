// SPDX-License-Identifier: MIT

import Foundation

/// Production-default in-memory implementation of
/// ``OverrideDataSource``.
///
/// Accepts a `[String: Any]` where each value is a primitive scalar —
/// `Bool` / `Int` / `Double` / `String`. Other shapes pass through
/// unchanged; the type-mismatch branch of the decision tree surfaces
/// invalid entries by returning the customer's default.
public struct MapOverrideDataSource: OverrideDataSource, @unchecked Sendable {
    private let map: [String: Any]

    /// Constructs a ``MapOverrideDataSource`` from the given override
    /// map. The dictionary is captured by value; later mutations on
    /// the caller's copy do not affect the data source.
    public init(_ map: [String: Any]) {
        self.map = map
    }

    /// Returns the captured override map.
    public func getOverridesSync() -> [String: Any]? {
        map
    }
}
