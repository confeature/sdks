// SPDX-License-Identifier: MIT

import Foundation

/// Internal targeting user the evaluator reads attributes from.
///
/// The public ``User`` carries `custom: [String: Any]` (matching upstream
/// `ConfigCatUser(custom: [String: Any]?)`). The ConfigCat conformance corpus
/// feeds NATIVE typed custom attributes (numbers, arrays, epochs) for the
/// `comparison_attribute_conversion` cases. `EvalUser` carries the same
/// `custom: [String: Any]` so a typed attribute reaches the comparator layer
/// un-stringified — the string values flow through the same string-conversion
/// path with no change.
///
/// Attribute lookup mirrors common-js `getUserAttribute`: the three
/// well-known attributes (`Identifier` / `Email` / `Country`) are read from
/// the dedicated fields; any other name reads `custom`.
struct EvalUser {
    let identifier: String
    let email: String?
    let country: String?
    let custom: [String: Any]

    init(
        identifier: String, email: String? = nil, country: String? = nil,
        custom: [String: Any] = [:]
    ) {
        self.identifier = identifier
        self.email = email
        self.country = country
        self.custom = custom
    }

    /// Build an `EvalUser` from the public ``User``. ``User/custom`` is
    /// already `[String: Any]` (spec 151 / #468), so typed attributes
    /// (`Int` / `Double` / `Bool` / `Date` / `[String]`) reach the
    /// comparator layer un-stringified; the string path is unchanged.
    init(_ user: User) {
        self.identifier = user.identifier
        self.email = user.email
        self.country = user.country
        self.custom = user.custom
    }

    /// Read an attribute by name (common-js `getUserAttribute`). Returns
    /// `nil` when the attribute is absent.
    func attribute(_ name: String) -> Any? {
        switch name {
        case "Identifier": return identifier
        case "Email": return email
        case "Country": return country
        default: return custom[name]
        }
    }
}
