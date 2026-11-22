// SPDX-License-Identifier: MIT

import OpenFeature

struct ContextAttributes {
    private static let reserved: Set<String> = [
        "Identifier", "Email", "Country", "targetingKey",
    ]

    let identifier: String?
    let email: String?
    let country: String?
    var custom: [String: Any] = [:]

    init(_ context: EvaluationContext?) {
        let key = context?.getTargetingKey()
        identifier = key?.isEmpty == false ? key : nil
        let fields = context?.asMap() ?? [:]
        email = fields["Email"]?.asString()
        country = fields["Country"]?.asString()
        for (name, value) in fields where !Self.reserved.contains(name) {
            custom[name] = Self.convert(value)
        }
    }

    private static func convert(_ value: Value) -> Any? {
        switch value {
        case .boolean(let flag): return flag
        case .string(let text): return text
        case .integer(let number): return number
        case .double(let number): return number.isFinite ? number : nil
        case .date(let instant): return instant
        case .list(let items):
            let strings = items.compactMap { $0.asString() }
            return strings.count == items.count ? strings : nil
        case .structure, .null: return nil
        }
    }
}
