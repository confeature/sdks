// SPDX-License-Identifier: MIT

import Foundation

/// The 36 ConfigCat `UserComparator` operations (research.md §R4), ported
/// field-for-field from `packages/sdk-shared/src/comparators.ts`.
///
/// Each comparator returns a ``MatchOutcome``: `.match`, `.noMatch`, or
/// `.validationError(message)` (a conversion / validation failure — bad
/// semver, non-numeric number, non-array array). An error short-circuits the
/// AND group like `.noMatch` but is surfaced rather than silently swallowed
/// (FR-010).
///
/// Attribute conversion + the missing-attribute / no-user gates live in the
/// evaluator's condition dispatch; the functions here receive an already
/// type-converted operand and apply the operator.
enum Comparators {
    // MARK: - UserComparator numeric tags (config-json.ts)

    static let textIsOneOf = 0
    static let textIsNotOneOf = 1
    static let textContainsAnyOf = 2
    static let textNotContainsAnyOf = 3
    static let semVerIsOneOf = 4
    static let semVerIsNotOneOf = 5
    static let semVerLess = 6
    static let semVerLessOrEquals = 7
    static let semVerGreater = 8
    static let semVerGreaterOrEquals = 9
    static let numberEquals = 10
    static let numberNotEquals = 11
    static let numberLess = 12
    static let numberLessOrEquals = 13
    static let numberGreater = 14
    static let numberGreaterOrEquals = 15
    static let sensitiveTextIsOneOf = 16
    static let sensitiveTextIsNotOneOf = 17
    static let dateTimeBefore = 18
    static let dateTimeAfter = 19
    static let sensitiveTextEquals = 20
    static let sensitiveTextNotEquals = 21
    static let sensitiveTextStartsWithAnyOf = 22
    static let sensitiveTextNotStartsWithAnyOf = 23
    static let sensitiveTextEndsWithAnyOf = 24
    static let sensitiveTextNotEndsWithAnyOf = 25
    static let sensitiveArrayContainsAnyOf = 26
    static let sensitiveArrayNotContainsAnyOf = 27
    static let textEquals = 28
    static let textNotEquals = 29
    static let textStartsWithAnyOf = 30
    static let textNotStartsWithAnyOf = 31
    static let textEndsWithAnyOf = 32
    static let textNotEndsWithAnyOf = 33
    static let arrayContainsAnyOf = 34
    static let arrayNotContainsAnyOf = 35

    // -----------------------------------------------------------------------
    // Attribute conversion helpers (common-js RolloutEvaluator.ts)
    // -----------------------------------------------------------------------

    /// True iff `value` is a `[String]` (common-js `isStringArray`).
    static func isStringArray(_ value: Any) -> [String]? {
        if let arr = value as? [String] { return arr }
        if let arr = value as? [Any], arr.allSatisfy({ $0 is String }) {
            return arr.compactMap { $0 as? String }
        }
        return nil
    }

    /// Stringify a user-attribute value exactly as common-js
    /// `userAttributeValueToString`: string verbatim; `Bool` → "true"/"false";
    /// string array → compact JSON; number → JS canonical string; `Date` →
    /// Unix seconds canonical string; else `String(describing:)`.
    static func userAttributeValueToString(_ value: Any) -> String {
        if let s = value as? String { return s }
        if let b = value as? Bool { return b ? "true" : "false" }
        if let arr = isStringArray(value) { return jsonStringifyStringArray(arr) }
        if let date = value as? Date {
            return numberToCanonicalString(date.timeIntervalSince1970)
        }
        if let n = asDouble(value) { return numberToCanonicalString(n) }
        return String(describing: value)
    }

    /// JSON-stringify a `[String]` compactly with no spaces, unescaped
    /// slashes + unicode (matches JS `JSON.stringify` for a string array).
    private static func jsonStringifyStringArray(_ arr: [String]) -> String {
        var out = "["
        for (i, s) in arr.enumerated() {
            if i > 0 { out += "," }
            out += jsonEncodeString(s)
        }
        out += "]"
        return out
    }

    /// Encode a single string as a JSON string literal, matching JS
    /// `JSON.stringify` (only the mandatory escapes; non-ASCII passes through).
    private static func jsonEncodeString(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// Read a `Double` out of an `Any` numeric (Int/Double/Float/NSNumber),
    /// rejecting `Bool` (NSNumber bridging can blur it).
    static func asDouble(_ value: Any) -> Double? {
        if value is Bool { return nil }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let i = value as? Int64 { return Double(i) }
        if let f = value as? Float { return Double(f) }
        if let n = value as? NSNumber {
            // Exclude the bool-typed NSNumber.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            return n.doubleValue
        }
        return nil
    }

    /// Stringify a number as ConfigCat's canonical string (ECMAScript
    /// `Number::toString`). NaN / ±Infinity print as "NaN" / "Infinity" /
    /// "-Infinity"; otherwise the SHORTEST round-tripping digit sequence,
    /// fixed-point unless the magnitude warrants exponential (e.g.
    /// `-1.23456789e+96` must NOT expand to its full integer form).
    static func numberToCanonicalString(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value > 0 ? "Infinity" : "-Infinity" }
        if value == 0 { return "0" }
        return jsNumberToString(value)
    }

    /// Render a finite non-zero double exactly as ECMAScript
    /// `Number::toString` (ported from PHP `jsNumberToString`).
    private static func jsNumberToString(_ value: Double) -> String {
        let sign = value < 0 ? "-" : ""
        let av = abs(value)
        let (digits, point) = shortestDigitsAndPoint(av)
        let k = digits.count
        let n = point

        if n >= k && n <= 21 {
            return sign + digits + String(repeating: "0", count: n - k)
        }
        if n > 0 && n <= 21 {
            let idx = digits.index(digits.startIndex, offsetBy: n)
            return sign + String(digits[..<idx]) + "." + String(digits[idx...])
        }
        if n > -6 && n <= 0 {
            return sign + "0." + String(repeating: "0", count: -n) + digits
        }
        let e = n - 1
        let expSign = e >= 0 ? "+" : "-"
        let mant: String
        if k == 1 {
            mant = String(digits.first!)
        } else {
            let idx = digits.index(after: digits.startIndex)
            mant = String(digits.first!) + "." + String(digits[idx...])
        }
        return sign + mant + "e" + expSign + String(abs(e))
    }

    /// Decompose the shortest round-tripping repr of a positive double into
    /// `(digits, point)` — `point` is the count of significant digits before
    /// the decimal point in normalized form (the ECMAScript `n`).
    private static func shortestDigitsAndPoint(_ av: Double) -> (String, Int) {
        // Swift's default `Double` description is already the shortest
        // round-tripping representation.
        let shortest = shortestRepr(av)
        var mant = shortest
        var expVal = 0
        if let eIdx = shortest.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mant = String(shortest[..<eIdx])
            expVal = Int(shortest[shortest.index(after: eIdx)...]) ?? 0
        }
        let intPart: String
        let fracPart: String
        if let dot = mant.firstIndex(of: ".") {
            intPart = String(mant[..<dot])
            fracPart = String(mant[mant.index(after: dot)...])
        } else {
            intPart = mant
            fracPart = ""
        }
        var raw = Array((intPart + fracPart))
        var point = intPart.count + expVal

        // Strip leading zeros (adjusting point), then trailing zeros.
        var lead = 0
        while lead < raw.count - 1 && raw[lead] == "0" {
            lead += 1
            point -= 1
        }
        raw = Array(raw[lead...])
        while raw.count > 1 && raw.last == "0" {
            raw.removeLast()
        }
        var digits = String(raw)
        if digits.isEmpty { digits = "0" }
        return (digits, point)
    }

    /// Shortest decimal representation of a positive finite double. Swift's
    /// `String(_:)` for `Double` produces the shortest round-tripping form
    /// (and may include scientific notation, handled by the caller).
    private static func shortestRepr(_ av: Double) -> String {
        // A whole double prints as "1.0" — strip the trailing ".0" so the
        // decomposition treats it like the JS integer form.
        var s = String(av)
        if s.hasSuffix(".0") {
            s = String(s.dropLast(2))
        }
        return s
    }

    /// Strict whole-string float parse, mirroring common-js
    /// `parseFloatStrict`: rejects empty / all-whitespace and a leading `0`
    /// followed by a non-digit/non-`.`/non-`e`; accepts "Infinity",
    /// "-Infinity", "NaN", and full-string floats.
    static func parseFloatStrict(_ value: String) -> Double {
        if value.isEmpty { return .nan }
        if matchesLeadingReject(value) { return .nan }
        let stripped = value.trimmingCharacters(in: .whitespaces)
        if stripped == "Infinity" { return .infinity }
        if stripped == "-Infinity" { return -.infinity }
        if stripped == "NaN" { return .nan }
        if !matchesFloat(stripped) { return .nan }
        return Double(stripped) ?? .nan
    }

    private static let leadingRejectRe = try? NSRegularExpression(
        pattern: "^\\s*$|^\\s*0[^\\d.eE]")
    private static let floatRe = try? NSRegularExpression(
        pattern: "^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$")

    private static func matchesLeadingReject(_ s: String) -> Bool {
        guard let re = leadingRejectRe else { return false }
        let ns = s as NSString
        return re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) != nil
    }

    private static func matchesFloat(_ s: String) -> Bool {
        guard let re = floatRe else { return false }
        let ns = s as NSString
        return re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) != nil
    }

    // -----------------------------------------------------------------------
    // Sensitive hashing (length-prefixed slice scheme)
    // -----------------------------------------------------------------------

    /// Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator
    /// (common-js `hashComparisonValueSlice`):
    /// `sha256(sliceBytes ++ utf8(configSalt) ++ utf8(contextSalt))`.
    private static func hashComparisonValueSlice(
        _ slice: Data, configSalt: String, contextSalt: String
    ) -> String {
        var buf = Data()
        buf.append(slice)
        buf.append(Data(configSalt.utf8))
        buf.append(Data(contextSalt.utf8))
        return Hashing.sha256Hex(buf)
    }

    // -----------------------------------------------------------------------
    // Text — cleartext (case-sensitive, no trim)
    // -----------------------------------------------------------------------

    static func evaluateTextEquals(
        _ text: String, _ comparisonValue: String, negate: Bool
    )
        -> MatchOutcome
    {
        bool((text == comparisonValue) != negate)
    }

    static func evaluateTextIsOneOf(
        _ text: String, _ values: [String], negate: Bool
    )
        -> MatchOutcome
    {
        bool(values.contains(text) != negate)
    }

    static func evaluateTextContainsAnyOf(
        _ text: String, _ values: [String], negate: Bool
    )
        -> MatchOutcome
    {
        for item in values where text.contains(item) {
            return bool(!negate)
        }
        return bool(negate)
    }

    /// Cleartext startsWith/endsWith-any-of. Items longer than the text are
    /// skipped.
    static func evaluateTextSliceEqualsAnyOf(
        _ text: String, _ values: [String], startsWith: Bool, negate: Bool
    ) -> MatchOutcome {
        for item in values {
            if text.count < item.count { continue }
            let result = startsWith ? text.hasPrefix(item) : text.hasSuffix(item)
            if result { return bool(!negate) }
        }
        return bool(negate)
    }

    // -----------------------------------------------------------------------
    // Text — sensitive (SHA-256 salted)
    // -----------------------------------------------------------------------

    static func evaluateSensitiveTextEquals(
        _ text: String, _ comparisonValue: String, configSalt: String, contextSalt: String,
        negate: Bool
    ) -> MatchOutcome {
        let hash = Hashing.hashComparisonValue(
            text, configSalt: configSalt, contextSalt: contextSalt)
        return bool((hash == comparisonValue) != negate)
    }

    static func evaluateSensitiveTextIsOneOf(
        _ text: String, _ values: [String], configSalt: String, contextSalt: String, negate: Bool
    ) -> MatchOutcome {
        let hash = Hashing.hashComparisonValue(
            text, configSalt: configSalt, contextSalt: contextSalt)
        return bool(values.contains(hash) != negate)
    }

    /// Sensitive startsWith/endsWith-any-of. Each operand is `"<byteLen>_<hash>"`;
    /// the SDK hashes the matching-length BYTE prefix/suffix of the attribute
    /// (UTF-8 bytes, not code points) and compares to `<hash>`.
    static func evaluateSensitiveTextSliceEqualsAnyOf(
        _ text: String, _ values: [String], configSalt: String, contextSalt: String,
        startsWith: Bool, negate: Bool
    ) -> MatchOutcome {
        let textBytes = Data(text.utf8)
        for item in values {
            guard let underscore = item.firstIndex(of: "_") else { continue }
            let lenStr = String(item[..<underscore])
            guard let sliceLength = Int(lenStr) else { continue }
            if textBytes.count < sliceLength { continue }
            let slice: Data =
                startsWith
                ? textBytes.prefix(sliceLength)
                : textBytes.suffix(sliceLength)
            let expected = String(item[item.index(after: underscore)...])
            let hash = hashComparisonValueSlice(
                Data(slice), configSalt: configSalt, contextSalt: contextSalt)
            if hash == expected { return bool(!negate) }
        }
        return bool(negate)
    }

    // -----------------------------------------------------------------------
    // Semver
    // -----------------------------------------------------------------------

    /// Semver IS-ONE-OF / IS-NOT-ONE-OF. Each operand is trimmed first; an
    /// operand that is empty AFTER trimming (incl. whitespace-only) is skipped —
    /// matching ConfigCat, which trims before the empty check. A non-empty but
    /// unparseable operand makes the whole comparator `.noMatch`. Iterates ALL
    /// operands (no early-out on match).
    static func evaluateSemVerIsOneOf(
        _ version: SemVer, _ values: [String], negate: Bool
    )
        -> MatchOutcome
    {
        var result = false
        for rawItem in values {
            let item = rawItem.trimmingCharacters(in: .whitespaces)
            if item.isEmpty { continue }
            guard let version2 = SemVer.parse(item) else {
                return .noMatch
            }
            if !result && version.compare(version2) == 0 { result = true }
        }
        return bool(result != negate)
    }

    /// Semver relations. An unparseable operand is a non-match.
    static func evaluateSemVerRelation(
        _ version: SemVer, comparator: Int, comparisonValue: String
    ) -> MatchOutcome {
        guard let version2 = SemVer.parse(comparisonValue.trimmingCharacters(in: .whitespaces))
        else { return .noMatch }
        let cmp = version.compare(version2)
        switch comparator {
        case semVerLess: return bool(cmp < 0)
        case semVerLessOrEquals: return bool(cmp <= 0)
        case semVerGreater: return bool(cmp > 0)
        case semVerGreaterOrEquals: return bool(cmp >= 0)
        default: return .noMatch
        }
    }

    // -----------------------------------------------------------------------
    // Number
    // -----------------------------------------------------------------------

    static func evaluateNumberRelation(
        _ num: Double, comparator: Int, comparisonValue: Double
    )
        -> MatchOutcome
    {
        switch comparator {
        case numberEquals: return bool(num == comparisonValue)
        case numberNotEquals: return bool(num != comparisonValue)
        case numberLess: return bool(num < comparisonValue)
        case numberLessOrEquals: return bool(num <= comparisonValue)
        case numberGreater: return bool(num > comparisonValue)
        case numberGreaterOrEquals: return bool(num >= comparisonValue)
        default: return .noMatch
        }
    }

    // -----------------------------------------------------------------------
    // Datetime (Unix seconds)
    // -----------------------------------------------------------------------

    static func evaluateDateTimeRelation(
        _ seconds: Double, comparisonValue: Double, before: Bool
    )
        -> MatchOutcome
    {
        bool(before ? seconds < comparisonValue : seconds > comparisonValue)
    }

    // -----------------------------------------------------------------------
    // Array (cleartext + sensitive)
    // -----------------------------------------------------------------------

    static func evaluateArrayContainsAnyOf(
        _ array: [String], _ values: [String], negate: Bool
    )
        -> MatchOutcome
    {
        for item in array where values.contains(item) {
            return bool(!negate)
        }
        return bool(negate)
    }

    static func evaluateSensitiveArrayContainsAnyOf(
        _ array: [String], _ values: [String], configSalt: String, contextSalt: String, negate: Bool
    ) -> MatchOutcome {
        for item in array {
            let hash = Hashing.hashComparisonValue(
                item, configSalt: configSalt, contextSalt: contextSalt)
            if values.contains(hash) { return bool(!negate) }
        }
        return bool(negate)
    }

    // -----------------------------------------------------------------------
    // Attribute → typed value, with three-valued error outcome (FR-010)
    // -----------------------------------------------------------------------

    /// Result of an attribute conversion: the typed value, or an error string.
    enum ConvertResult<T> {
        case ok(T)
        case error(String)
    }

    private static func invalidAttr(_ attr: String, _ reason: String) -> String {
        "cannot evaluate, the User.\(attr) attribute is invalid (\(reason))"
    }

    /// Attribute → text (string verbatim; else stringified — never errors).
    static func attributeAsText(_ value: Any) -> String {
        if let s = value as? String { return s }
        return userAttributeValueToString(value)
    }

    /// Attribute → semver, or a validation error.
    static func attributeAsSemVer(_ attr: String, _ value: Any) -> ConvertResult<SemVer> {
        if let s = value as? String,
            let version = SemVer.parse(s.trimmingCharacters(in: .whitespaces))
        {
            return .ok(version)
        }
        return .error(
            invalidAttr(
                attr, "'\(userAttributeValueToString(value))' is not a valid semantic version")
        )
    }

    /// Attribute → number, or a validation error.
    static func attributeAsNumber(_ attr: String, _ value: Any) -> ConvertResult<Double> {
        if let n = asDouble(value) { return .ok(n) }
        if let s = value as? String {
            let num = parseFloatStrict(s.replacingOccurrences(of: ",", with: "."))
            if !num.isNaN || s.trimmingCharacters(in: .whitespaces) == "NaN" {
                return .ok(num)
            }
        }
        return .error(
            invalidAttr(
                attr, "'\(userAttributeValueToString(value))' is not a valid decimal number"))
    }

    /// Attribute → Unix seconds, or a validation error. `Date` → seconds; a
    /// numeric attribute is already seconds; a string is parsed strictly.
    static func attributeAsUnixTimeSeconds(_ attr: String, _ value: Any) -> ConvertResult<Double> {
        if let date = value as? Date { return .ok(date.timeIntervalSince1970) }
        if let n = asDouble(value) { return .ok(n) }
        if let s = value as? String {
            let num = parseFloatStrict(s.replacingOccurrences(of: ",", with: "."))
            if !num.isNaN || s.trimmingCharacters(in: .whitespaces) == "NaN" {
                return .ok(num)
            }
        }
        return .error(
            invalidAttr(
                attr,
                "'\(userAttributeValueToString(value))' is not a valid Unix timestamp "
                    + "(number of seconds elapsed since Unix epoch)"))
    }

    /// Attribute → string array, or a validation error. A string attribute is
    /// JSON-parsed; the result must be a string array.
    static func attributeAsStringArray(_ attr: String, _ value: Any) -> ConvertResult<[String]> {
        var candidate: Any = value
        if let s = value as? String,
            let data = s.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        {
            candidate = parsed
        }
        if let arr = isStringArray(candidate) { return .ok(arr) }
        return .error(
            invalidAttr(attr, "'\(userAttributeValueToString(value))' is not a valid string array"))
    }

    private static func bool(_ value: Bool) -> MatchOutcome {
        value ? .match : .noMatch
    }
}
