// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Spec 073 typed-tier parity gate — 13/13 byte-identical to the
/// cross-language typed parity corpus (string / int / double).
///
/// Sibling to ``ParityCorpusTests`` (the 58-tuple boolean tier, which
/// stays byte-unchanged per FR-016). Both classes consume the
/// LocalOnly + MapOverrideDataSource pattern; the typed tier is the
/// fifth precedent for #261 Unreal (US7).
///
/// Constitution invariant (Principle II NON-NEGOTIABLE): 13/13 MUST
/// pass. If a tuple drifts, STOP and investigate the evaluator /
/// override-eval code — never mutate the corpus to make the test
/// green.
final class ParityCorpusTypedTests: XCTestCase {
    private static let paritySdkKey =
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

    private struct Tuple: Decodable {
        let description: String
        let configId: String
        let key: String
        let defaultValue: AnyDecodable
        let user: CorpusUser?
        let expected: AnyDecodable
    }

    private struct CorpusUser: Decodable {
        let identifier: String?
        let email: String?
        let country: String?
        let custom: [String: String]?
    }

    private struct ConfigRecord: Decodable {
        let id: String
        let overridesMap: [String: AnyDecodable]
    }

    func testParityCorpusTypedByteIdentical() throws {
        let tuples = try loadCorpus()
        let configs = try loadConfigs()

        XCTAssertEqual(
            tuples.count, 13,
            "expected 13 corpus tuples, got \(tuples.count) — "
                + "regenerate via `pnpm run export:corpus` in "
                + "packages/test-fixtures-sdk-parity/"
        )

        var failures: [String] = []
        for tuple in tuples {
            guard let cfg = configs[tuple.configId] else {
                XCTFail(
                    "corpus references unknown configId=\(tuple.configId) — "
                        + "regenerate fixtures via `pnpm run export:corpus`"
                )
                continue
            }
            let overrideMap: [String: Any] = cfg.overridesMap.mapValues { $0.value as Any }
            let overrides = FlagOverrides.localOnly(MapOverrideDataSource(overrideMap))
            var options = ConfeatureClientOptions(
                pollingMode: .manualPoll,
                cacheDirectory: CacheDirectorySentinel.memory,
                logger: NoOpLogger(),
                flagOverrides: overrides
            )
            options.requestTimeout = 5
            let client = ConfeatureClient(sdkKey: Self.paritySdkKey, options: options)

            let user = tuple.user.map { Self.toUser($0) }
            let actual = client.snapshot().resolve(
                key: tuple.key, defaultValue: tuple.defaultValue.value, user: user)

            if !Self.equalAny(actual, tuple.expected.value) {
                failures.append(
                    "Typed parity drift on \(tuple.description)\n"
                        + "  expected: \(tuple.expected.value) (\(type(of: tuple.expected.value)))\n"
                        + "  actual:   \(actual) (\(type(of: actual)))"
                )
            }

            client.close()
        }

        if !failures.isEmpty {
            XCTFail(
                "\(failures.count)/\(tuples.count) typed-parity tuples drifted — "
                    + "Constitution Principle II NON-NEGOTIABLE; investigate "
                    + "the evaluator / override-eval code, do NOT mutate the "
                    + "corpus.\n\n"
                    + failures.joined(separator: "\n\n")
            )
        }
    }

    private static func toUser(_ corpus: CorpusUser) -> User {
        User(
            identifier: corpus.identifier ?? "",
            email: corpus.email,
            country: corpus.country,
            custom: corpus.custom ?? [:]
        )
    }

    private static func equalAny(_ lhs: Any, _ rhs: Any) -> Bool {
        switch (lhs, rhs) {
        case (let l as Bool, let r as Bool): return l == r
        case (let l as String, let r as String): return l == r
        case (let l as Int, let r as Int): return l == r
        case (let l as Double, let r as Double): return l == r
        case (let l as Int, let r as Double): return Double(l) == r
        case (let l as Double, let r as Int): return l == Double(r)
        case (is NSNull, is NSNull): return true
        default:
            return String(describing: lhs) == String(describing: rhs)
        }
    }

    private func loadCorpus() throws -> [Tuple] {
        let data = try Data(contentsOf: WorkspaceRoot.parityCorpusTypedPath)
        return try JSONDecoder().decode([Tuple].self, from: data)
    }

    private func loadConfigs() throws -> [String: ConfigRecord] {
        let data = try Data(contentsOf: WorkspaceRoot.parityConfigsTypedPath)
        let records = try JSONDecoder().decode([ConfigRecord].self, from: data)
        return Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })
    }
}
