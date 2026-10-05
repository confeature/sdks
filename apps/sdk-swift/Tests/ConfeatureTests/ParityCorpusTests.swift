// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Spec 046 US1 parity gate — 58/58 byte-identical to ConfigCat.
///
/// Loads the TS-generated parity corpus and the canonical configs
/// from `packages/test-fixtures-sdk-parity/fixtures/`, builds one
/// ``ConfeatureClient`` per tuple with a `LocalOnly` override
/// bundle holding the tuple's config-specific map, and asserts that
/// the resolved value equals the recorded `expected` byte-for-byte.
///
/// Constitution invariant (Principle II NON-NEGOTIABLE): 58/58 MUST
/// pass. If a tuple drifts, STOP and investigate the override-eval /
/// evaluator code — never mutate the corpus to make the test green.
final class ParityCorpusTests: XCTestCase {
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

    func testParityCorpusByteIdentical() throws {
        let tuples = try loadCorpus()
        let configs = try loadConfigs()

        XCTAssertEqual(
            tuples.count, 58,
            "expected 58 corpus tuples, got \(tuples.count) — "
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
                    "Parity drift on \(tuple.description)\n"
                        + "  expected: \(tuple.expected.value) (\(type(of: tuple.expected.value)))\n"
                        + "  actual:   \(actual) (\(type(of: actual)))"
                )
            }

            client.close()
        }

        if !failures.isEmpty {
            XCTFail(
                "\(failures.count)/\(tuples.count) parity tuples drifted — "
                    + "Constitution Principle II NON-NEGOTIABLE; investigate the "
                    + "evaluator / override-eval code, do NOT mutate the corpus.\n\n"
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
        let data = try Data(contentsOf: WorkspaceRoot.parityCorpusPath)
        return try JSONDecoder().decode([Tuple].self, from: data)
    }

    private func loadConfigs() throws -> [String: ConfigRecord] {
        let data = try Data(contentsOf: WorkspaceRoot.parityConfigsPath)
        let records = try JSONDecoder().decode([ConfigRecord].self, from: data)
        return Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })
    }
}

/// JSON-decoding shim that captures heterogeneous values as `Any`.
/// JSONDecoder's `decode<T: Decodable>` requires a concrete `T`, so
/// we round-trip through a custom decoder that walks the JSON tree
/// once and stores the resulting Swift value.
struct AnyDecodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.value = NSNull()
        } else if let v = try? container.decode(Bool.self) {
            self.value = v
        } else if let v = try? container.decode(Int.self) {
            self.value = v
        } else if let v = try? container.decode(Double.self) {
            self.value = v
        } else if let v = try? container.decode(String.self) {
            self.value = v
        } else if let v = try? container.decode([AnyDecodable].self) {
            self.value = v.map { $0.value }
        } else if let v = try? container.decode([String: AnyDecodable].self) {
            self.value = v.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "AnyDecodable: unsupported JSON value")
        }
    }
}
