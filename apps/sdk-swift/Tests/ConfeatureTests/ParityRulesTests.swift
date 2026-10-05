// SPDX-License-Identifier: MIT

import Foundation
import XCTest

@testable import Confeature

/// Targeting-rule parity gate (spec 135 / #435, epic #382, US3) — the
/// `CORPUS_RULES` corpus injected through the full-config offline
/// override.
///
/// Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora
/// (which feed a value-only `overridesMap` via
/// ``MapOverrideDataSource``), the rule corpus carries the whole
/// `{p, f, s}` config and is injected via
/// ``FlagOverrides/fromConfig(_:behaviour:)`` +
/// ``OverrideBehaviour/localOnly``. The SDK then resolves targeting
/// rules / segments / % options offline through the real Confeature
/// evaluator, exactly as it would against a CDN-served config — no
/// network round-trip.
///
/// Runner contract (mirrors `apps/sdk-dart/test/parity_rules_test.dart`,
/// `apps/sdk-python/.../test_parity_rules.py`): every tuple branches on
/// the config's `injectionMode`:
///   - `"full-config"` → capability-probe
///     ``FlagOverrides/fromConfig(_:behaviour:)``. If this SDK exposes
///     it, build the override and assert the PUBLIC
///     `client.getValue(forKey:defaultValue:user:)` returns
///     `tuple.expected`. If it did NOT, SKIP with a reason — NEVER fall
///     back to the flat-map path (SC-004: no `"full-config"` tuple is
///     ever resolved on the map path, and a skip is reported with its
///     reason).
///
/// sdk-swift HAS adopted the full-config path, so every loaded rule
/// tuple runs and passes; there are no skips for this family.
///
/// AC4: if a tuple fails because of a REAL Swift evaluator
/// targeting-rule gap (not override wiring), STOP and file a discrete
/// #382 follow-up — never a corpus or test workaround.
final class ParityRulesTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    /// Capability probe: does this SDK expose the in-memory full-config
    /// override factory? The full-config path is gated on this — never
    /// silently resolved on the flat-map path (SC-004 / AC4).
    ///
    /// In Swift this resolves at COMPILE time: this file only compiles
    /// if ``FlagOverrides/fromConfig(_:behaviour:)`` and
    /// ``ConfigOverrideDataSource`` are part of the public `Confeature`
    /// surface. So the probe is statically `true` — but the SC-004 skip
    /// branch below is kept intact so the runner contract mirrors the
    /// sibling SDKs byte-for-byte; were the factory ever dropped, this
    /// file would fail to compile (an even louder signal than a runtime
    /// skip).
    private static let hasFullConfigOverrides = true

    private struct Tuple {
        let description: String
        let configId: String
        let key: String
        let defaultValue: Any
        let user: User?
        let expected: Any
        /// Optional expected `variationId` (spec 152 / #475, US2). Present
        /// on the 14 variationId tuples; `nil` otherwise (value-only).
        let expectedVariationId: String?
    }

    func testTargetingRuleParityByteIdentical() throws {
        let tuples = try loadCorpus()
        let configs = try loadConfigs()

        // Growth-tolerant non-empty floor. `CORPUS_RULES` is append-only
        // (the 8 foundational #383 tuples are never removed) and grows with
        // every comparator spec, so we assert only that the fixture actually
        // loaded — not a hardcoded total that re-trips on every growth.
        // Per-tuple correctness is covered by the assertions below, and
        // JSON↔TS sync is owned by the central `check:exports` gate, so this
        // guard is purely a non-empty smoke and never needs a per-spec bump.
        XCTAssertGreaterThanOrEqual(
            tuples.count, 8,
            "rule corpus is non-empty (append-only floor: at least the 8 "
                + "foundational rule tuples), got \(tuples.count) — looks "
                + "empty/truncated; regenerate via `pnpm run export:corpus` "
                + "in packages/test-fixtures-sdk-parity/"
        )

        XCTAssertTrue(
            Self.hasFullConfigOverrides,
            "FlagOverrides.fromConfig(_:behaviour:) must be exposed; "
                + "sdk-swift has adopted the in-memory full-config "
                + "override path (#435)."
        )

        var failures: [String] = []
        var variationIdsAsserted = 0
        for tuple in tuples {
            guard let record = configs[tuple.configId] else {
                XCTFail(
                    "rule corpus references unknown configId="
                        + "\(tuple.configId) — regenerate fixtures via "
                        + "`pnpm run export:corpus`"
                )
                continue
            }

            // The rule corpus is full-config only; a flat-map tuple here
            // would be a corpus regression, never a silent flat-map
            // fallback (SC-004).
            XCTAssertEqual(
                record.injectionMode, "full-config",
                "rule corpus tuple \"\(tuple.description)\" has unexpected "
                    + "injectionMode=\(record.injectionMode); expected "
                    + "\"full-config\"."
            )

            // SC-004: NEVER fall back to the flat-map path — skip with a
            // reason rather than false-greening on the map path.
            // Statically `true` in Swift (see `hasFullConfigOverrides`);
            // the branch is retained for runner-contract parity with the
            // sibling SDKs.
            if !Self.hasFullConfigOverrides {
                // Unreachable; kept for contract parity.
                continue
            }

            let overrides = FlagOverrides.fromConfig(record.config, behaviour: .localOnly)
            var options = ConfeatureClientOptions(
                pollingMode: .manualPoll,
                cacheDirectory: CacheDirectorySentinel.memory,
                logger: NoOpLogger(),
                flagOverrides: overrides
            )
            options.requestTimeout = 5
            let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)

            // Assert through the PUBLIC sync snapshot getValue (the rule
            // path is resolved synchronously offline from the full
            // config).
            let snapshot = client.snapshot()
            let actual = snapshot.resolve(
                key: tuple.key, defaultValue: tuple.defaultValue, user: tuple.user)

            if !Self.equalAny(actual, tuple.expected) {
                failures.append(
                    "Targeting-rule parity drift on \(tuple.description)\n"
                        + "  expected: \(tuple.expected) (\(type(of: tuple.expected)))\n"
                        + "  actual:   \(actual) (\(type(of: actual)))"
                )
            }

            // variationId assertion (spec 152 / #475, US2): for the 14
            // tuples carrying `expectedVariationId`, also assert the
            // PUBLIC `getValueDetails(...).variationId`. Dispatched on the
            // setting's `t` tag so the typed default matches the setting
            // type (a `decimal`/Double setting needs a Double default, a
            // `whole`/Int setting needs an Int default — otherwise the
            // evaluator's type guard would TYPE_MISMATCH and drop the
            // variationId).
            if let expectedVid = tuple.expectedVariationId {
                variationIdsAsserted += 1
                let settingType = Self.settingType(
                    in: record.config, key: tuple.key)
                let actualVid = Self.resolveVariationId(
                    snapshot: snapshot, key: tuple.key, user: tuple.user,
                    settingType: settingType)
                if actualVid != expectedVid {
                    failures.append(
                        "variationId drift on \(tuple.description)\n"
                            + "  expected variationId: \(expectedVid)\n"
                            + "  actual variationId:   "
                            + "\(actualVid ?? "<nil>")"
                    )
                }
            }

            client.close()
        }

        // Growth-tolerant floor: the 14 spec-152 variationId tuples must
        // each have been asserted (never silently skipped). The corpus is
        // append-only, so assert at least 14 carried + verified a
        // `getValueDetails().variationId`.
        XCTAssertGreaterThanOrEqual(
            variationIdsAsserted, 14,
            "expected at least the 14 spec-152 variationId tuples to be "
                + "asserted via getValueDetails().variationId, got "
                + "\(variationIdsAsserted) — looks like the optional "
                + "`expectedVariationId` field stopped deserializing."
        )

        if !failures.isEmpty {
            XCTFail(
                "\(failures.count)/\(tuples.count) targeting-rule parity tuples "
                    + "drifted — Constitution Principle II NON-NEGOTIABLE; "
                    + "investigate the evaluator / override router, do NOT mutate "
                    + "the corpus. If this is a real Swift targeting-rule engine "
                    + "gap (not an override-wiring bug), STOP and file a discrete "
                    + "#382 follow-up — never a corpus or test workaround (AC4).\n\n"
                    + failures.joined(separator: "\n\n")
            )
        }
    }

    // MARK: - Fixture loading

    private struct ConfigRecord {
        let id: String
        let injectionMode: String
        let config: [String: Any]
    }

    private func loadCorpus() throws -> [Tuple] {
        let data = try Data(contentsOf: WorkspaceRoot.parityCorpusRulesPath)
        guard
            let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            XCTFail("parity-corpus-rules.json is not a JSON array of objects")
            return []
        }
        return arr.map { obj in
            Tuple(
                description: obj["description"] as? String ?? "",
                configId: obj["configId"] as? String ?? "",
                key: obj["key"] as? String ?? "",
                defaultValue: obj["defaultValue"] ?? NSNull(),
                user: Self.toUser(obj["user"]),
                expected: obj["expected"] ?? NSNull(),
                expectedVariationId: obj["expectedVariationId"] as? String
            )
        }
    }

    private func loadConfigs() throws -> [String: ConfigRecord] {
        let data = try Data(contentsOf: WorkspaceRoot.parityConfigsRulesPath)
        guard
            let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            XCTFail("parity-configs-rules.json is not a JSON array of objects")
            return [:]
        }
        var out: [String: ConfigRecord] = [:]
        for obj in arr {
            guard let id = obj["id"] as? String else { continue }
            out[id] = ConfigRecord(
                id: id,
                injectionMode: obj["injectionMode"] as? String ?? "",
                config: obj["config"] as? [String: Any] ?? [:]
            )
        }
        return out
    }

    /// Deserialize a corpus `user` object, decoding the spec-151 typed
    /// custom-attribute encoding into native Swift values (FR-006):
    ///
    ///   - `String`           → `String` (verbatim)
    ///   - JSON number        → `Double` (an `NSNumber`/`Int`/`Double`)
    ///   - JSON bool          → `Bool`
    ///   - `[String]` / array → `[String]`
    ///   - `{"$date": n}`     → `Date(timeIntervalSince1970: n)` (seconds,
    ///                          fractional preserved)
    ///   - `{"$num": s}`      → the non-finite `Double` `Double.nan` /
    ///                          `Double.infinity` / `-Double.infinity` for
    ///                          `"NaN"` / `"Infinity"` / `"-Infinity"`. The
    ///                          `$num` tag carries NaN/±Inf because
    ///                          `JSON.stringify` collapses them to lossy
    ///                          `null` (#479); the native non-finite Double
    ///                          renders back to "NaN" / "Infinity" /
    ///                          "-Infinity" through the evaluator's
    ///                          `userAttributeValueToString`.
    ///   - `null` / absent    → attribute dropped (genuinely absent in the
    ///                          wire encoding)
    private static func toUser(_ raw: Any?) -> User? {
        guard let dict = raw as? [String: Any] else { return nil }
        var custom: [String: Any] = [:]
        if let c = dict["custom"] as? [String: Any] {
            for (k, v) in c {
                if let decoded = decodeCustomValue(v) { custom[k] = decoded }
            }
        }
        return User(
            identifier: dict["identifier"] as? String ?? "",
            email: dict["email"] as? String,
            country: dict["country"] as? String,
            custom: custom
        )
    }

    /// Decode a single typed custom-attribute value from its corpus JSON
    /// form. Returns `nil` for a `null`/absent attribute so the caller
    /// drops it.
    private static func decodeCustomValue(_ v: Any) -> Any? {
        // `null` / absent — drop the attribute.
        if v is NSNull { return nil }
        // Tagged date: `{"$date": <epoch-seconds>}` → `Date`.
        if let obj = v as? [String: Any], let secs = (obj["$date"] as? NSNumber)?.doubleValue {
            return Date(timeIntervalSince1970: secs)
        }
        // Tagged non-finite number: `{"$num": "NaN"|"Infinity"|"-Infinity"}`
        // → the native non-finite `Double` (#479). Set as a native Double so
        // it routes through the evaluator's numeric stringification (and
        // never through an ObjC `NSNumber` Equatable path). `JSON.stringify`
        // collapses NaN/±Inf to lossy `null`, so the corpus carries them via
        // this `$num` tag instead.
        if let obj = v as? [String: Any], let s = obj["$num"] as? String {
            switch s {
            case "NaN": return Double.nan
            case "Infinity": return Double.infinity
            case "-Infinity": return -Double.infinity
            default: return nil
            }
        }
        // String array (incl. the empty array).
        if let arr = v as? [Any] {
            if let strs = arr as? [String] { return strs }
            if arr.isEmpty { return [String]() }
            return arr.compactMap { $0 as? String }
        }
        if let s = v as? String { return s }
        // JSON number / bool arrive as `NSNumber`; distinguish the bool.
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
            return n.doubleValue
        }
        if let b = v as? Bool { return b }
        return v
    }

    /// Reads the setting's `t` discriminator from the full config so the
    /// variationId probe can pick a typed default that matches the
    /// setting type (Bool=0, String=1, Int=2, Double=3).
    private static func settingType(in config: [String: Any], key: String) -> Int? {
        guard
            let settings = config["f"] as? [String: Any],
            let setting = settings[key] as? [String: Any]
        else { return nil }
        if let t = setting["t"] as? Int { return t }
        if let t = setting["t"] as? NSNumber { return t.intValue }
        return nil
    }

    /// Calls the PUBLIC `getValueDetails(...)` with a typed default
    /// matching the setting type and returns the resolved
    /// `details.variationId`. Mirrors the upstream ConfigCat-iOS
    /// `getValueDetails(for:defaultValue:user:)` details API: the
    /// envelope carries `variationId`.
    private static func resolveVariationId(
        snapshot: Snapshot, key: String, user: User?, settingType: Int?
    ) -> String? {
        switch settingType {
        case 0:
            return snapshot.getValueDetails(
                forKey: key, defaultValue: false, user: user
            ).variationId
        case 1:
            return snapshot.getValueDetails(
                forKey: key, defaultValue: "", user: user
            ).variationId
        case 2:
            return snapshot.getValueDetails(
                forKey: key, defaultValue: 0, user: user
            ).variationId
        case 3:
            return snapshot.getValueDetails(
                forKey: key, defaultValue: 0.0, user: user
            ).variationId
        default:
            // Unknown setting type — fall back to an `Any` default so the
            // evaluator's type guard is bypassed and the variationId is
            // still surfaced.
            let details: TypedEvaluationDetails<Any> = snapshot.getValueDetails(
                forKey: key, defaultValue: NSNull(), user: user)
            return details.variationId
        }
    }

    /// Value equality with NUMERIC comparison for numbers (spec 152 /
    /// #475, US2): the decimal tuples (`0`, `-2147483647.2147484`,
    /// `0.12345678912345678`, percentage option `1`) compare by `Double`
    /// value, never strict typed/string equality — an Int-vs-Double or a
    /// precision-sensitive decimal still matches numerically. Non-number
    /// comparisons (Bool / String / null) keep their strict equality.
    private static func equalAny(_ lhs: Any, _ rhs: Any) -> Bool {
        switch (lhs, rhs) {
        case (let l as Bool, let r as Bool): return l == r
        case (let l as String, let r as String): return l == r
        case (is NSNull, is NSNull): return true
        default:
            if let l = numericValue(lhs), let r = numericValue(rhs) {
                return l == r
            }
            return String(describing: lhs) == String(describing: rhs)
        }
    }

    /// Folds any numeric value (`Int`, `Double`, `NSNumber`) into a
    /// `Double` for numeric comparison. Returns `nil` for non-numbers and
    /// for `Bool` (so a `Bool` never compares as a number).
    private static func numericValue(_ value: Any) -> Double? {
        // NSNumber must be probed BEFORE the `is Bool` check: a bridged
        // `NSNumber(0)` answers `true` to `is Bool` in Swift, so an
        // integral `0`/`1` would be wrongly rejected. CFBooleanGetTypeID
        // is the only reliable bool discriminator on a bridged NSNumber.
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            return n.doubleValue
        }
        if value is Bool { return nil }
        switch value {
        case let v as Int: return Double(v)
        case let v as Double: return v
        default: return nil
        }
    }
}
