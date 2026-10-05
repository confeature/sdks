// SPDX-License-Identifier: MIT

import Foundation

/// Tuple of a setting key plus its resolved value, returned by
/// ``ConfeatureClient/getKeyAndValue(for:)``. Mirrors ConfigCat
/// 11.3.1's `KeyValue` (`Sources/ConfigCat/KeyValue.swift`) 1:1.
///
/// Declared as a `public final class: NSObject` (not a `struct`) so
/// the `@objc public let` fields work and Objective-C consumers can
/// `alloc` / `init` — matches ConfigCat's shape exactly.
public final class KeyValue: NSObject {
    /// The setting key the matched variation belongs to.
    @objc public let key: String

    /// The resolved value — one of `Bool` / `String` / `Int` /
    /// `Double` for the v1 four-type evaluator.
    @objc public let value: Any

    /// Designated initialiser.
    @objc public init(key: String, value: Any) {
        self.key = key
        self.value = value
        super.init()
    }
}
