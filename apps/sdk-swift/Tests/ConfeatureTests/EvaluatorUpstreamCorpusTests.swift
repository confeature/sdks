// SPDX-License-Identifier: MIT

import Foundation
import XCTest

@testable import Confeature

/// ConfigCat conformance gate (spec 127, SC-001) — the Swift engine replays
/// the vendored upstream evaluation matrix. Mirrors the spec-117 TS reference
/// suite (`packages/sdk-shared/tests/parity-upstream.test.ts`) and the
/// spec-118…126 Python / Go / Ruby / PHP / .NET / Dart / Elixir / Rust / Java
/// ports — the PHP port (`apps/sdk-php/tests/EvaluatorUpstreamCorpusTest.php`)
/// is the closest analogue. The corpus
/// (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
/// `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is
/// the oracle: each `(config, key, user) → expected` tuple is checked against
/// `Evaluator.evaluateWith(...)` value (and `.variationId` for the
/// variation-id matrix).
///
/// Scope = the full conformance surface: US1 targeting rules, US2 the 36
/// comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
/// multilevel + circular detection) / AND-groups, US5 attribute conversion +
/// trimming + typed-attribute validation + variationId / matched detail. Per
/// FR-018 only structured value / identity is asserted — never a textual
/// trace.
///
/// The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
/// faithfully — most critically the Go `csv.Reader` LazyQuotes semantics (a
/// `"` only opens a quoted field at the field start), without which every
/// JSON-array attribute cell is corrupted.
///
/// Custom attributes are fed through ``CorpusUser`` (a typed value object the
/// evaluator reads as an ``EvalUser``) so the conversion-driver cases can
/// deliver numbers / arrays / epochs un-stringified — the public
/// ``ConfeatureUser`` stringifies custom values by contract, which would
/// defeat those cases.
final class EvaluatorUpstreamCorpusTests: XCTestCase {
    private static let nullToken = "##null##"

    private static let pkd = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
    private static let jcp = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"

    /// `dependentFeatureMultipleLevels` is the ONE corpus case whose config
    /// blob was NOT captured by the spec-117 vendoring (known DATA gap #401,
    /// not an engine gap). The multilevel-prerequisite path IS exercised by the
    /// 3-level `circular_dep` chain + the reconstructed-chain test below.
    /// Excluded LOUDLY (the same marker the TS / Python / Ruby / PHP references
    /// use), never silently.
    private static let unvendoredEvalLogKeys: Set<String> = ["dependentFeatureMultipleLevels"]

    // -----------------------------------------------------------------------
    // Corpus targeting user — typed custom attributes (mirror PHP CorpusUser).
    // -----------------------------------------------------------------------

    /// Targeting-context value object whose custom attributes stay TYPED. The
    /// public ``ConfeatureUser`` stringifies custom values (its documented
    /// contract); the conversion-driver cases feed numbers / arrays / epochs
    /// that MUST reach the comparator layer un-stringified. Converts to the
    /// internal ``EvalUser`` (`custom: [String: Any]`) for evaluation.
    struct CorpusUser {
        let identifier: String
        let email: String?
        let country: String?
        let custom: [String: Any]?

        init(
            _ identifier: String = "", _ email: String? = nil, _ country: String? = nil,
            _ custom: [String: Any]? = nil
        ) {
            self.identifier = identifier
            self.email = email
            self.country = country
            self.custom = custom
        }

        var evalUser: EvalUser {
            EvalUser(
                identifier: identifier, email: email, country: country, custom: custom ?? [:])
        }
    }

    // -----------------------------------------------------------------------
    // Config loaders (cached).
    // -----------------------------------------------------------------------

    private static var contentByKeyCache: [String: Any]?
    private static var evalLogConfigsCache: [String: Any]?

    private static func contentByKey() -> [String: Any] {
        if let cached = contentByKeyCache { return cached }
        let loaded = WorkspaceRoot.upstreamJson("content-by-key.json")
        contentByKeyCache = loaded
        return loaded
    }

    private static func evalLogConfigs() -> [String: Any] {
        if let cached = evalLogConfigsCache { return cached }
        let loaded = WorkspaceRoot.upstreamJson("evaluationlog/_configs-by-key.json")
        evalLogConfigsCache = loaded
        return loaded
    }

    // -----------------------------------------------------------------------
    // Matrix → SDK key mapping (verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    private struct MatrixEntry {
        let sdkKey: String
        let kind: String  // "value" or "variation"
    }

    private static func matrixEntry(_ matrix: String) -> MatrixEntry? {
        let map: [String: MatrixEntry] = [
            "testmatrix.csv": MatrixEntry(sdkKey: pkd + "AG6C1ngVb0CvM07un6JisQ", kind: "value"),
            "testmatrix_semantic.csv": MatrixEntry(
                sdkKey: pkd + "iV8vH2MBakKxkFZylxHmTg", kind: "value"),
            "testmatrix_number.csv": MatrixEntry(
                sdkKey: pkd + "FCWN-k1dV0iBf8QZrDgjdw", kind: "value"),
            "testmatrix_semantic_2.csv": MatrixEntry(
                sdkKey: pkd + "U8nt3zEhDEO5S2ulubCopA", kind: "value"),
            "testmatrix_sensitive.csv": MatrixEntry(
                sdkKey: pkd + "-0YmVOUNgEGKkgRF-rU65g", kind: "value"),
            "testmatrix_segments_old.csv": MatrixEntry(
                sdkKey: pkd + "y_ZB7o-Xb0Swxth-ZlMSeA", kind: "value"),
            "testmatrix_and_or.csv": MatrixEntry(
                sdkKey: jcp + "ByMO9yZNn02kXcm72lnY1A", kind: "value"),
            "testmatrix_comparators_v6.csv": MatrixEntry(
                sdkKey: jcp + "OfQqcTjfFUGBwMKqtyEOrQ", kind: "value"),
            "testmatrix_prerequisite_flag.csv": MatrixEntry(
                sdkKey: jcp + "JoGwdqJZQ0K2xDy7LnbyOg", kind: "value"),
            "testmatrix_segments.csv": MatrixEntry(
                sdkKey: jcp + "h99HYXWWNE2bH8eWyLAVMA", kind: "value"),
            "testmatrix_unicode.csv": MatrixEntry(
                sdkKey: jcp + "Da6w8dBbmUeMUBhh0iEeQQ", kind: "value"),
            "testmatrix_variationId.csv": MatrixEntry(
                sdkKey: pkd + "spQnkRTIPEWVivZkWM84lQ", kind: "variation"),
        ]
        return map[matrix]
    }

    // -----------------------------------------------------------------------
    // CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port). A
    // `"` only opens a quoted field when it is the FIRST char of the field;
    // anywhere else it is a literal quote. Getting this wrong corrupts every
    // JSON-array attribute cell.
    // -----------------------------------------------------------------------

    private static func parseCsvLine(_ line: String) -> [String] {
        var fields: [String] = []
        var field = ""
        var inQuotes = false
        var fieldStart = true
        let chars = Array(line)
        var i = 0
        let n = chars.count
        while i < n {
            let ch = chars[i]
            if inQuotes && ch == "\"" && i + 1 < n && chars[i + 1] == "\"" {
                field.append("\"")
                i += 1
            } else if inQuotes && ch == "\"" {
                inQuotes = false
            } else if inQuotes {
                field.append(ch)
            } else if ch == "\"" && fieldStart {
                inQuotes = true
                fieldStart = false
            } else if ch == ";" {
                fields.append(field)
                field = ""
                fieldStart = true
            } else {
                field.append(ch)
                fieldStart = false
            }
            i += 1
        }
        fields.append(field)
        return fields
    }

    /// Parse a CSV cell to its primitive (mirrors upstream `parseCell`).
    private static func parseCell(_ s: String) -> Any {
        if s.range(of: "^-?\\d+$", options: .regularExpression) != nil {
            if let n = Int(s), abs(n) <= 9_007_199_254_740_991, String(n) == s {
                return n
            }
        }
        if s.range(of: "^-?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$", options: .regularExpression)
            != nil
        {
            if let d = Double(s) { return d }
        }
        if s == "True" { return true }
        if s == "False" { return false }
        return s
    }

    /// Build a CorpusUser from the first four CSV columns (port `userFromRow`).
    private static func userFromRow(_ line: [String], customKey: String) -> CorpusUser? {
        if line.isEmpty || (line.first ?? "") == nullToken { return nil }
        func setOrNull(_ v: String?) -> String? {
            guard let v, !v.isEmpty, v != nullToken else { return nil }
            return v
        }
        let identifier = (line.count > 0 && !line[0].isEmpty) ? line[0] : ""
        let email = setOrNull(line.count > 1 ? line[1] : nil)
        let country = setOrNull(line.count > 2 ? line[2] : nil)
        let customVal = setOrNull(line.count > 3 ? line[3] : nil)
        let custom: [String: Any]? = customVal == nil ? nil : [customKey: customVal!]
        return CorpusUser(identifier, email, country, custom)
    }

    private struct MatrixTuple {
        let matrix: String
        let key: String
        let user: CorpusUser?
        let kind: String
        let expected: Any
        let config: [String: Any]
    }

    private static func loadMatrix(_ matrix: String) -> [MatrixTuple] {
        guard let entry = matrixEntry(matrix) else {
            fatalError("Unknown testmatrix file: \(matrix)")
        }
        guard let config = contentByKey()[entry.sdkKey] as? [String: Any] else {
            fatalError("No config for matrix \(matrix) (sdkKey \(entry.sdkKey))")
        }

        let text = WorkspaceRoot.upstreamText(matrix)
        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        let header = parseCsvLine(lines[0])
        let customKey = header.count > 3 ? header[3] : "Custom1"
        let settingKeys = Array(header.dropFirst(4))

        var tuples: [MatrixTuple] = []
        for r in 1..<lines.count {
            let cols = parseCsvLine(lines[r])
            let user = userFromRow(cols, customKey: customKey)
            for (c, key) in settingKeys.enumerated() {
                let raw = (c + 4) < cols.count ? cols[c + 4] : ""
                let expected: Any = entry.kind == "value" ? parseCell(raw) : raw
                tuples.append(
                    MatrixTuple(
                        matrix: matrix, key: key, user: user, kind: entry.kind,
                        expected: expected, config: config))
            }
        }
        return tuples
    }

    // -----------------------------------------------------------------------
    // evaluationlog/<scenario> (port loadEvalLogScenario).
    // -----------------------------------------------------------------------

    private static func evalLogUser(_ raw: [String: Any]?) -> CorpusUser? {
        guard let raw, !raw.isEmpty else { return nil }
        var identifier = ""
        var email: String?
        var country: String?
        var custom: [String: Any] = [:]
        for (k, v) in raw {
            switch k {
            // The three well-known attributes are typed string/?string on
            // CorpusUser (mirroring the public surface), so they coerce.
            case "Identifier": identifier = stringify(v)
            case "Email": email = stringify(v)
            case "Country": country = stringify(v)
            // Custom attributes keep their native JSON-decoded type so a
            // numeric/bool custom attr reaches the comparator un-stringified
            // (CorpusUser exercises the native-typed branch, not only the
            // string->float coercion path).
            default: custom[k] = v
            }
        }
        return CorpusUser(identifier, email, country, custom.isEmpty ? nil : custom)
    }

    private static func stringify(_ v: Any) -> String {
        if let s = v as? String { return s }
        return String(describing: v)
    }

    private static func evalLogConfig(_ suite: [String: Any]) -> [String: Any] {
        if let jsonOverride = suite["jsonOverride"] as? String {
            return WorkspaceRoot.upstreamJson("evaluationlog/_overrides/" + jsonOverride)
        }
        if let sdkKey = suite["sdkKey"] as? String {
            if let config = contentByKey()[sdkKey] as? [String: Any] { return config }
            if let config = evalLogConfigs()[sdkKey] as? [String: Any] { return config }
            fatalError("No config for eval-log sdkKey \(sdkKey)")
        }
        fatalError("Eval-log suite has neither jsonOverride nor sdkKey")
    }

    private struct EvalLogTuple {
        let scenario: String
        let key: String
        let defaultValue: Any?
        let user: CorpusUser?
        let expectedValue: Any?
        let config: [String: Any]
    }

    private static func loadEvalLogScenario(_ scenario: String) -> [EvalLogTuple] {
        let suite = WorkspaceRoot.upstreamJson("evaluationlog/\(scenario).json")
        let config = evalLogConfig(suite)
        let tests = suite["tests"] as? [[String: Any]] ?? []
        var out: [EvalLogTuple] = []
        for t in tests {
            out.append(
                EvalLogTuple(
                    scenario: scenario,
                    key: t["key"] as? String ?? "",
                    defaultValue: unwrapNull(t["defaultValue"]),
                    user: evalLogUser(t["user"] as? [String: Any]),
                    expectedValue: unwrapNull(t["returnValue"]),
                    config: config))
        }
        return out
    }

    private static func unwrapNull(_ v: Any?) -> Any? {
        if v is NSNull { return nil }
        return v
    }

    // -----------------------------------------------------------------------
    // Assertion helpers.
    // -----------------------------------------------------------------------

    private static func settingType(_ config: [String: Any], _ key: String) -> Int? {
        guard let settings = config["f"] as? [String: Any],
            let setting = settings[key] as? [String: Any]
        else { return nil }
        return Evaluator.readInt(setting["t"])
    }

    /// Type-appropriate default matching the resolved primitive type. The
    /// strict evaluator distinguishes int (t=2) from double (t=3), so the
    /// default must be the SAME numeric kind the setting type expects.
    private static func defaultFor(_ expected: Any, _ settingType: Int?) -> Any {
        if expected is Bool { return false }
        if expected is Int || expected is Double {
            return settingType == Evaluator.settingTypeDouble ? (0.0 as Any) : (0 as Any)
        }
        return "__default__"
    }

    /// Cast a JSON-decoded eval-log default to the concrete Swift type implied
    /// by `t`. `JSONSerialization` bridges every JSON number to `NSNumber`,
    /// which Swift's `is Bool` / `is Int` checks blur — a JSON `0` answers
    /// `true` to `is Bool`, which would trip the evaluator's strict type guard.
    /// Normalize to a real `Bool` / `Int` / `Double` here.
    private static func coerceDefault(_ def: Any, _ settingType: Int?) -> Any {
        // A genuine JSON boolean (CFBoolean-backed NSNumber).
        if isBool(def) { return (def as! Bool) }
        if let n = def as? NSNumber {
            switch settingType {
            case Evaluator.settingTypeInt: return n.intValue
            case Evaluator.settingTypeDouble: return n.doubleValue
            default:
                // No setting type: preserve integral-vs-fractional shape.
                return n.doubleValue == n.doubleValue.rounded() ? n.intValue : n.doubleValue
            }
        }
        if settingType == Evaluator.settingTypeDouble, let i = def as? Int { return Double(i) }
        if settingType == Evaluator.settingTypeInt, let d = def as? Double { return Int(d) }
        return def
    }

    /// Numeric-tolerant equality (5 == 5.0); booleans must not equate with
    /// numbers.
    private static func valueEqual(_ actual: Any, _ expected: Any) -> Bool {
        // Bool first — NSNumber bridging can blur Bool↔Int.
        if isBool(expected) {
            guard isBool(actual) else { return false }
            return (actual as! Bool) == (expected as! Bool)
        }
        if isBool(actual) { return false }
        if let ed = numeric(expected) {
            guard let ad = numeric(actual) else { return false }
            if ed.isNaN { return ad.isNaN }
            return ad == ed
        }
        if let es = expected as? String, let asx = actual as? String { return es == asx }
        return String(describing: actual) == String(describing: expected)
    }

    private static func isBool(_ v: Any) -> Bool {
        if v is Bool {
            // NSNumber-bridged bool check.
            if let n = v as? NSNumber { return CFGetTypeID(n) == CFBooleanGetTypeID() }
            return true
        }
        return false
    }

    private static func numeric(_ v: Any) -> Double? {
        if isBool(v) { return nil }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    private static func userRepr(_ user: CorpusUser?) -> String {
        guard let user else { return "null" }
        return "id=\(user.identifier) email=\(String(describing: user.email)) "
            + "country=\(String(describing: user.country)) "
            + "custom=\(String(describing: user.custom))"
    }

    private func assertMatrixTuple(_ tuple: MatrixTuple, _ failures: inout [String]) {
        let label = "\(tuple.matrix) \(tuple.key) user=\(Self.userRepr(tuple.user))"
        if tuple.kind == "variation" {
            let result = Evaluator.evaluateWith(
                config: tuple.config, key: tuple.key, defaultValue: NSNull(),
                user: tuple.user?.evalUser)
            let expected = tuple.expected as? String
            if result.variationId != expected {
                failures.append(
                    "\(label): actual=\(String(describing: result.variationId)) "
                        + "expected=\(String(describing: expected))")
            }
            return
        }
        let settingType = Self.settingType(tuple.config, tuple.key)
        let def = Self.defaultFor(tuple.expected, settingType)
        let result = Evaluator.evaluateWith(
            config: tuple.config, key: tuple.key, defaultValue: def, user: tuple.user?.evalUser)
        if !Self.valueEqual(result.value, tuple.expected) {
            failures.append(
                "\(label): actual=\(result.value) expected=\(tuple.expected)")
        }
    }

    private func assertEvalLogValue(_ tuple: EvalLogTuple, _ failures: inout [String]) {
        guard let expected = tuple.expectedValue else { return }
        let settingType = Self.settingType(tuple.config, tuple.key)
        let def: Any =
            tuple.defaultValue == nil
            ? Self.defaultFor(expected, settingType)
            : Self.coerceDefault(tuple.defaultValue!, settingType)
        let label = "\(tuple.scenario) \(tuple.key) user=\(Self.userRepr(tuple.user))"
        let result = Evaluator.evaluateWith(
            config: tuple.config, key: tuple.key, defaultValue: def, user: tuple.user?.evalUser)
        if !Self.valueEqual(result.value, expected) {
            failures.append("\(label): actual=\(result.value) expected=\(expected)")
        }
    }

    private static func comparisonConfig(_ fixture: String) -> [String: Any] {
        WorkspaceRoot.upstreamJson("\(fixture).json")
    }

    private static func firstWhere(
        _ cases: [EvalLogTuple], _ predicate: (EvalLogTuple) -> Bool
    ) -> EvalLogTuple {
        for c in cases where predicate(c) { return c }
        fatalError("No matching case in corpus scenario")
    }

    // =======================================================================
    // US1 / US2 — value + comparator matrices
    // =======================================================================

    func testValueMatrices() {
        let matrices = [
            "testmatrix.csv", "testmatrix_comparators_v6.csv", "testmatrix_semantic.csv",
            "testmatrix_semantic_2.csv", "testmatrix_number.csv", "testmatrix_sensitive.csv",
            "testmatrix_unicode.csv",
        ]
        var failures: [String] = []
        var total = 0
        for matrix in matrices {
            let tuples = Self.loadMatrix(matrix)
            XCTAssertFalse(tuples.isEmpty, "\(matrix) produced no tuples")
            total += tuples.count
            for tuple in tuples { assertMatrixTuple(tuple, &failures) }
        }
        XCTAssertGreaterThan(total, 0, "value matrices produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    // =======================================================================
    // US1 — targeting-rule eval-log scenarios
    // =======================================================================

    func testTargetingRuleScenarios() {
        var failures: [String] = []
        var total = 0
        for scenario in ["1_targeting_rule", "2_targeting_rules", "simple_value"] {
            let tuples = Self.loadEvalLogScenario(scenario)
            total += tuples.count
            for tuple in tuples { assertEvalLogValue(tuple, &failures) }
        }
        XCTAssertGreaterThan(total, 0, "targeting-rule scenarios produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    func testMatchedTargetingRuleIsReported() {
        let cases = Self.loadEvalLogScenario("1_targeting_rule")
        let matching = Self.firstWhere(cases) { ($0.expectedValue as? String) == "Dog" }
        let result = Evaluator.evaluateWith(
            config: matching.config, key: matching.key, defaultValue: "default",
            user: matching.user?.evalUser)
        XCTAssertEqual(result.value as? String, "Dog")
        XCTAssertNotNil(result.matchedTargetingRule)
        XCTAssertNil(result.matchedPercentageOption)
        XCTAssertEqual(result.variationId, "d0cd8f06")
    }

    func testNoUserServesFallbackWithReasonAndNeverThrows() {
        let cases = Self.loadEvalLogScenario("1_targeting_rule")
        let noUser = Self.firstWhere(cases) { $0.user == nil }
        let result = Evaluator.evaluateWith(
            config: noUser.config, key: noUser.key, defaultValue: "default", user: nil)
        XCTAssertEqual(result.value as? String, "Cat")  // fallback
        XCTAssertNil(result.error)  // a value was cleanly resolved
        XCTAssertNotNil(result.evalError)
        XCTAssertTrue(result.evalError?.contains("User Object is missing") ?? false)
        XCTAssertNil(result.matchedTargetingRule)
    }

    // =======================================================================
    // US3 — percentage rollout
    // =======================================================================

    func testPercentageScenarios() {
        var failures: [String] = []
        var total = 0
        for scenario in [
            "options_based_on_user_id", "options_based_on_custom_attr",
            "options_after_targeting_rule", "options_within_targeting_rule",
        ] {
            let tuples = Self.loadEvalLogScenario(scenario)
            total += tuples.count
            for tuple in tuples { assertEvalLogValue(tuple, &failures) }
        }
        XCTAssertGreaterThan(total, 0, "percentage scenarios produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    func testPercentageBucketingIsDeterministic() {
        let cases = Self.loadEvalLogScenario("options_based_on_user_id")
        let withUser = Self.firstWhere(cases) { $0.user != nil }
        let config = withUser.config
        let key = withUser.key
        let user = withUser.user?.evalUser
        let first = Evaluator.evaluateWith(
            config: config, key: key, defaultValue: "default", user: user)
        for _ in 0..<20 {
            let again = Evaluator.evaluateWith(
                config: config, key: key, defaultValue: "default", user: user)
            XCTAssertTrue(
                Self.valueEqual(first.value, again.value),
                "percentage bucketing must be repeat-invariant")
            XCTAssertEqual(first.variationId, again.variationId)
        }
        if let expected = withUser.expectedValue {
            XCTAssertTrue(Self.valueEqual(first.value, expected))
        }
        XCTAssertNotNil(first.matchedPercentageOption)
    }

    // =======================================================================
    // US4 — segments / prerequisites / AND-OR matrices + scenarios
    // =======================================================================

    func testUs4Matrices() {
        let matrices = [
            "testmatrix_and_or.csv", "testmatrix_segments.csv",
            "testmatrix_segments_old.csv", "testmatrix_prerequisite_flag.csv",
        ]
        var failures: [String] = []
        var total = 0
        for matrix in matrices {
            let tuples = Self.loadMatrix(matrix)
            XCTAssertFalse(tuples.isEmpty, "\(matrix) produced no tuples")
            total += tuples.count
            for tuple in tuples { assertMatrixTuple(tuple, &failures) }
        }
        XCTAssertGreaterThan(total, 0, "US4 matrices produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    func testUs4EvalLogScenarios() {
        var failures: [String] = []
        var total = 0
        for scenario in ["segment", "prerequisite_flag", "and_rules"] {
            for tuple in Self.loadEvalLogScenario(scenario) {
                if Self.unvendoredEvalLogKeys.contains(tuple.key) { continue }
                total += 1
                assertEvalLogValue(tuple, &failures)
            }
        }
        XCTAssertGreaterThan(total, 0, "US4 eval-log scenarios produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    func testMultilevelPrerequisiteResolvesThroughReconstructedChain() {
        // Reconstructed from evaluationlog/prerequisite_flag (its config blob
        // was not vendored, #401). Proves the engine recurses A → B → C
        // correctly, compensating for the LOUDLY-excluded
        // `dependentFeatureMultipleLevels` corpus key.
        let config: [String: Any] = [
            "p": ["u": "", "r": 0, "s": "salt"],
            "s": [],
            "f": [
                "mainFeatureWithoutUserCondition": [
                    "t": 0, "v": ["b": true], "i": "main", "r": [],
                ],
                "intermediateFeature": [
                    "t": 0, "v": ["b": false], "i": "inter",
                    "r": [
                        [
                            "c": [
                                [
                                    "p": [
                                        "f": "mainFeatureWithoutUserCondition", "c": 0,
                                        "v": ["b": true],
                                    ]
                                ],
                                [
                                    "p": [
                                        "f": "mainFeatureWithoutUserCondition", "c": 0,
                                        "v": ["b": true],
                                    ]
                                ],
                            ],
                            "s": ["v": ["b": true], "i": "interT"],
                        ]
                    ],
                ],
                "dependentFeatureMultipleLevels": [
                    "t": 1, "v": ["s": "Cat"], "i": "dep",
                    "r": [
                        [
                            "c": [["p": ["f": "intermediateFeature", "c": 0, "v": ["b": true]]]],
                            "s": ["v": ["s": "Dog"], "i": "depDog"],
                        ]
                    ],
                ],
            ],
        ]
        let result = Evaluator.evaluate(
            config: config, key: "dependentFeatureMultipleLevels", defaultValue: "default")
        XCTAssertEqual(result.value as? String, "Dog")
        XCTAssertNotNil(result.matchedTargetingRule)
    }

    // =======================================================================
    // US4 — circular-dependency termination (SC-004)
    // =======================================================================

    func testCircularDepScenariosBoundedFallback() {
        var failures: [String] = []
        let cases = Self.loadEvalLogScenario("circular_dep")
        XCTAssertFalse(cases.isEmpty, "circular_dep produced no tuples")
        for tuple in cases {
            let start = DispatchTime.now().uptimeNanoseconds
            let result = Evaluator.evaluateWith(
                config: tuple.config, key: tuple.key, defaultValue: "default",
                user: tuple.user?.evalUser)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
            if elapsed >= 1.0 {
                failures.append("\(tuple.key) took too long (\(elapsed)s) — cycle not bounded")
            }
            if (result.value as? String) != "default" {
                failures.append(
                    "\(tuple.key) value=\(result.value) (expected fail-closed default)")
            }
            if result.error == nil {
                failures.append("\(tuple.key) resolved with no error code")
            }
        }
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }

    func testDirectTwoFlagCycleTerminates() {
        let config: [String: Any] = [
            "p": ["u": "", "r": 0, "s": "salt"],
            "s": [],
            "f": [
                "flagA": [
                    "t": 1, "v": ["s": "A"], "i": "a",
                    "r": [
                        [
                            "c": [["p": ["f": "flagB", "c": 0, "v": ["b": true]]]],
                            "s": ["v": ["s": "AA"], "i": "aa"],
                        ]
                    ],
                ],
                "flagB": [
                    "t": 1, "v": ["s": "B"], "i": "b",
                    "r": [
                        [
                            "c": [["p": ["f": "flagA", "c": 0, "v": ["b": true]]]],
                            "s": ["v": ["s": "BB"], "i": "bb"],
                        ]
                    ],
                ],
            ],
        ]
        let start = DispatchTime.now().uptimeNanoseconds
        let result = Evaluator.evaluate(config: config, key: "flagA", defaultValue: "default")
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
        XCTAssertLessThan(elapsed, 1.0, "a direct two-flag cycle must terminate bounded")
        XCTAssertEqual(result.value as? String, "default")
        XCTAssertNotNil(result.error)
    }

    // =======================================================================
    // US5 — normalization / conversion / trimming (comparison_*.json drivers)
    // =======================================================================

    func testComparisonAttributeConversion() {
        let config = Self.comparisonConfig("comparison_attribute_conversion")
        // JS number→string conversion (NaN / ±Infinity / exponential) is the
        // crux here — the corpus expects the canonical ECMAScript repr.
        let driver: [(key: String, custom1: Any, expected: String)] = [
            ("numberToStringConversion", 0.12345, "1"),
            ("numberToStringConversionInt", 125, "4"),
            ("numberToStringConversionPositiveExp", -1.23456789e96, "2"),
            ("numberToStringConversionNegativeExp", -1.23456789e-96, "4"),
            ("numberToStringConversionNaN", Double.nan, "3"),
            ("numberToStringConversionPositiveInf", Double.infinity, "4"),
            ("numberToStringConversionNegativeInf", -Double.infinity, "3"),
            ("dateToStringConversion", 1_680_307_199.999, "3"),
            ("dateToStringConversionNaN", Double.nan, "3"),
            ("dateToStringConversionPositiveInf", Double.infinity, "1"),
            ("dateToStringConversionNegativeInf", -Double.infinity, "5"),
            ("stringArrayToStringConversion", ["read", "Write", " eXecute "], "4"),
            ("stringArrayToStringConversionEmpty", [String](), "5"),
            ("stringArrayToStringConversionSpecialChars", ["+<>%\"'\\/\t\r\n"], "3"),
            ("stringArrayToStringConversionUnicode", ["äöüÄÖÜçéèñışğâ¢™✓😀"], "2"),
        ]
        var failures: [String] = []
        for c in driver {
            let user = CorpusUser("12345", nil, nil, ["Custom1": c.custom1])
            let result = Evaluator.evaluateWith(
                config: config, key: c.key, defaultValue: "default", user: user.evalUser)
            if (result.value as? String) != c.expected {
                failures.append(
                    "\(c.key): actual=\(result.value) expected=\(c.expected)")
            }
        }
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }

    /// Native-typed custom attributes must reach the numeric comparator
    /// un-stringified and evaluate identically to their string spelling. This
    /// directly exercises CorpusUser's native-numeric branch, not only the
    /// string→float coercion path that the matrix CSVs and eval-log scenarios
    /// (all-string custom attrs) cover.
    func testNativeNumericCustomAttributeMatchesStringForm() {
        let config: [String: Any] = [
            "p": ["u": "", "r": 0, "s": "salt"],
            "s": [],
            "f": [
                "numericGate": [
                    "t": 1,
                    "a": "Custom1",
                    "v": ["s": "no-match"],
                    "i": "ng",
                    "r": [
                        [
                            // c=15 is NUMBER_GREATER_OR_EQUALS.
                            "c": [["u": ["a": "Custom1", "c": 15, "d": 18.0]]],
                            "s": ["v": ["s": "match"], "i": "m"],
                        ]
                    ],
                ]
            ],
        ]
        let cases: [(label: String, attr: Any, expected: String)] = [
            ("native-int-pass", 21, "match"),
            ("native-float-pass", 18.0, "match"),
            ("native-int-fail", 17, "no-match"),
            ("native-float-fail", 17.999, "no-match"),
            ("string-int-pass", "21", "match"),
            ("string-float-pass", "18.0", "match"),
            ("string-int-fail", "17", "no-match"),
        ]
        var failures: [String] = []
        for c in cases {
            let user = CorpusUser("12345", nil, nil, ["Custom1": c.attr])
            let result = Evaluator.evaluateWith(
                config: config, key: "numericGate", defaultValue: "default", user: user.evalUser)
            if (result.value as? String) != c.expected {
                failures.append("\(c.label): actual=\(result.value) expected=\(c.expected)")
            }
        }
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }

    func testComparisonAttributeTrimming() {
        let config = Self.comparisonConfig("comparison_attribute_trimming")
        let user = CorpusUser(
            " 12345 ", nil, "[\" USA \"]",
            ["Version": " 1.0.0 ", "Number": " 3 ", "Date": " 1705253400 "])
        var failures: [String] = []
        for c in Self.trimmingDriver() {
            let result = Evaluator.evaluateWith(
                config: config, key: c.key, defaultValue: "default", user: user.evalUser)
            if (result.value as? String) != c.expected {
                failures.append("\(c.key): actual=\(result.value) expected=\(c.expected)")
            }
        }
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }

    func testComparisonValueTrimming() {
        let config = Self.comparisonConfig("comparison_value_trimming")
        let user = CorpusUser(
            "12345", nil, "[\"USA\"]",
            ["Version": "1.0.0", "Number": "3", "Date": "1705253400"])
        var failures: [String] = []
        for c in Self.valueTrimmingDriver() {
            let result = Evaluator.evaluateWith(
                config: config, key: c.key, defaultValue: "default", user: user.evalUser)
            if (result.value as? String) != c.expected {
                failures.append("\(c.key): actual=\(result.value) expected=\(c.expected)")
            }
        }
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }

    // =======================================================================
    // US5 — typed-attribute validation outcomes (FR-010) + list truncation
    // =======================================================================

    func testValidationScenarios() {
        var failures: [String] = []
        var total = 0
        for scenario in [
            "semver_validation", "number_validation", "epoch_date_validation", "list_truncation",
        ] {
            let tuples = Self.loadEvalLogScenario(scenario)
            total += tuples.count
            for tuple in tuples { assertEvalLogValue(tuple, &failures) }
        }
        XCTAssertGreaterThan(total, 0, "validation scenarios produced no tuples")
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    // =======================================================================
    // US5 — variationId + matched rule/option detail (FR-011)
    // =======================================================================

    func testVariationIdMatrix() {
        let tuples = Self.loadMatrix("testmatrix_variationId.csv")
        XCTAssertFalse(tuples.isEmpty)
        var failures: [String] = []
        for tuple in tuples { assertMatrixTuple(tuple, &failures) }
        XCTAssertEqual(
            failures, [], "\(failures.count) drift:\n\(failures.joined(separator: "\n"))")
    }

    func testSegmentMatchedFlagReportsValueAndVariationId() {
        let cases = Self.loadEvalLogScenario("segment")
        let match = Self.firstWhere(cases) {
            $0.key == "featureWithSegmentTargeting" && $0.user != nil
        }
        let result = Evaluator.evaluateWith(
            config: match.config, key: match.key, defaultValue: false, user: match.user?.evalUser)
        XCTAssertEqual(result.value as? Bool, true)
        XCTAssertNotNil(result.matchedTargetingRule)
        XCTAssertNotNil(result.variationId)
    }

    // -----------------------------------------------------------------------
    // Trimming driver tables (ported verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    private static func trimmingDriver() -> [(key: String, expected: String)] {
        let noTrim = [
            "isoneof", "isnotoneof", "isoneofhashed", "isnotoneofhashed", "equalshashed",
            "notequalshashed", "arraycontainsanyofhashed", "arraynotcontainsanyofhashed", "equals",
            "notequals", "startwithanyof", "notstartwithanyof", "endswithanyof", "notendswithanyof",
            "arraycontainsanyof", "arraynotcontainsanyof", "startwithanyofhashed",
            "notstartwithanyofhashed", "endswithanyofhashed", "notendswithanyofhashed",
        ]
        var out: [(key: String, expected: String)] = noTrim.map { ($0, "no trim") }
        let trimmed: [(String, String)] = [
            ("semverisoneof", "4 trim"), ("semverisnotoneof", "5 trim"), ("semverless", "6 trim"),
            ("semverlessequals", "7 trim"), ("semvergreater", "8 trim"),
            ("semvergreaterequals", "9 trim"), ("numberequals", "10 trim"),
            ("numbernotequals", "11 trim"), ("numberless", "12 trim"),
            ("numberlessequals", "13 trim"), ("numbergreater", "14 trim"),
            ("numbergreaterequals", "15 trim"), ("datebefore", "18 trim"), ("dateafter", "19 trim"),
        ]
        out.append(contentsOf: trimmed.map { ($0.0, $0.1) })
        out.append(("containsanyof", "no trim"))
        out.append(("notcontainsanyof", "no trim"))
        return out
    }

    private static func valueTrimmingDriver() -> [(key: String, expected: String)] {
        let noTrim = [
            "isoneof", "isnotoneof", "containsanyof", "notcontainsanyof", "isoneofhashed",
            "isnotoneofhashed", "equalshashed", "notequalshashed", "arraycontainsanyofhashed",
            "arraynotcontainsanyofhashed", "equals", "notequals", "startwithanyof",
            "notstartwithanyof", "endswithanyof", "notendswithanyof", "arraycontainsanyof",
            "arraynotcontainsanyof", "startwithanyofhashed", "notstartwithanyofhashed",
            "endswithanyofhashed", "notendswithanyofhashed",
        ]
        var out: [(key: String, expected: String)] = noTrim.map { ($0, "no trim") }
        let trimmed: [(String, String)] = [
            ("semverisoneof", "4 trim"), ("semverisnotoneof", "5 trim"), ("semverless", "6 trim"),
            ("semverlessequals", "7 trim"), ("semvergreater", "8 trim"),
            ("semvergreaterequals", "9 trim"),
        ]
        out.append(contentsOf: trimmed.map { ($0.0, $0.1) })
        return out
    }
}
