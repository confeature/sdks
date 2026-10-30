// SPDX-License-Identifier: MIT

// Targeting-rule parity (spec 135 / #437, epic #382, US3) — the
// `CORPUS_RULES` corpus injected through the full-config offline override.
//
// Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which feed
// a value-only `overridesMap` via `MapOverrideDataSource`), the rule corpus
// carries the whole `{p, f, s}` config and is injected via
// `createFlagOverridesFromConfig` + `OverrideBehaviour::LocalOnly`. The SDK
// then resolves targeting rules / segments / % options offline through the
// real C++ evaluator, exactly as it would against a CDN-served config — no
// network round-trip.
//
// Runner contract (mirrors apps/sdk-python/tests/parity/test_parity_rules.py
// and apps/sdk-dart/test/parity_rules_test.dart): every tuple branches on the
// config's `injectionMode`:
//   - "full-config" → capability-probe `createFlagOverridesFromConfig`.
//     If sdk-cpp exposes it, build the override and assert the PUBLIC
//     `Snapshot::getValueJson` (the engine behind `getValue<T>`) returns
//     `tuple.expected`. If it does NOT, SKIP with a reason — NEVER fall back
//     to the flat-map path (SC-004: no "full-config" tuple is ever resolved on
//     the map path, and a skip is reported with its reason).
//
// sdk-cpp HAS adopted the full-config path, so every loaded rule tuple runs +
// passes.
//
// AC4: if a tuple fails because of a REAL C++ evaluator targeting-rule gap
// (not override wiring), STOP and file a discrete #382 follow-up — never a
// corpus or test workaround.

#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <fstream>
#include <limits>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "confeature/evaluation_details.h"
#include "confeature/flag_overrides.h"
#include "confeature/snapshot.h"
#include "confeature/user.h"
#include "require_value.h"
#include "workspace_root.h"

using confeature::ConfigOverrideDataSource;
using confeature::createFlagOverridesFromConfig;
using confeature::FlagOverrides;
using confeature::OverrideBehaviour;
using confeature::Snapshot;
using confeature::User;
using confeature::tests::fixturesPath;
using nlohmann::json;

namespace {

json loadJsonFile(const std::filesystem::path& path) {
  std::ifstream stream(path);
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  return json::parse(buf.str());
}

// Builds a User from a parity-corpus user object (or nullptr if null).
std::unique_ptr<User> buildUser(const json& userJson) {
  if (userJson.is_null()) {
    return nullptr;
  }
  auto user = std::make_unique<User>(userJson.value("identifier", ""));
  if (userJson.contains("email")) {
    user->withEmail(userJson["email"].get<std::string>());
  }
  if (userJson.contains("country")) {
    user->withCountry(userJson["country"].get<std::string>());
  }
  if (userJson.contains("custom") && userJson["custom"].is_object()) {
    for (auto it = userJson["custom"].begin(); it != userJson["custom"].end(); ++it) {
      const auto& v = it.value();
      // Typed-attribute corpus encoding (contract): value by NATURAL JSON
      // type. string → string; number → double; array → vector<string>;
      // a `{"$date": <epoch-seconds>}` object (or a bare numeric epoch) →
      // date_time_t (time_point from epoch SECONDS); a `{"$num": "NaN" |
      // "Infinity" | "-Infinity"}` object → the corresponding non-finite
      // double (#479 — `JSON.stringify` collapses these to a lossy `null`, so
      // the corpus tags them explicitly, mirroring `{"$date"}`). The evaluator
      // then canonicalises each non-string attr ConfigCat-exactly.
      if (v.is_string()) {
        user->withCustom(it.key(), v.get<std::string>());
      } else if (v.is_object() && v.contains("$date")) {
        const double seconds = v.at("$date").get<double>();
        const auto sinceEpoch = std::chrono::duration_cast<User::date_time_t::duration>(
            std::chrono::duration<double>(seconds));
        user->withCustom(it.key(), User::date_time_t(sinceEpoch));
      } else if (v.is_object() && v.contains("$num")) {
        const auto tag = v.at("$num").get<std::string>();
        static const std::unordered_map<std::string, double> kNonFinite = {
            {"NaN", std::numeric_limits<double>::quiet_NaN()},
            {"Infinity", std::numeric_limits<double>::infinity()},
            {"-Infinity", -std::numeric_limits<double>::infinity()},
        };
        const auto numIt = kNonFinite.find(tag);
        INFO("unknown $num tag: " << tag);
        REQUIRE(numIt != kNonFinite.end());
        user->withCustom(it.key(), numIt->second);
      } else if (v.is_number()) {
        user->withCustom(it.key(), v.get<double>());
      } else if (v.is_array()) {
        user->withCustom(it.key(), v.get<std::vector<std::string>>());
      } else if (v.is_boolean()) {
        // Upstream treats a bool attr as its JS string form ("true"/"false").
        user->withCustom(it.key(), std::string(v.get<bool>() ? "true" : "false"));
      } else {
        user->withCustom(it.key(), v.dump());
      }
    }
  }
  return user;
}

// Corpus-parity value comparison. JSON numbers are compared NUMERICALLY so an
// int-encoded expected (`0`, `1`) matches a Double-setting result the evaluator
// returns as a float, and float precision is preserved at `double` width for
// the high-precision decimal tuples (`-2147483647.2147484`,
// `0.12345678912345678`). Every non-number kind keeps the strict
// `nlohmann::json::operator==` (never weakened).
bool valuesEqual(const json& actual, const json& expected) {
  if (actual.is_number() && expected.is_number()) {
    return actual.get<double>() == expected.get<double>();
  }
  return actual == expected;
}

}  // namespace

TEST_CASE("parity rules corpus is non-empty via full-config override", "[parity_rules]") {
  const auto corpus = loadJsonFile(fixturesPath() / "parity-corpus-rules.json");
  const auto configs = loadJsonFile(fixturesPath() / "parity-configs-rules.json");
  REQUIRE(corpus.is_array());
  // Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
  // foundational #383 tuples are never removed) and grows with every comparator
  // spec, so we assert only that the fixture actually loaded — not a hardcoded
  // total that re-trips on every growth. Per-tuple correctness is covered by the
  // per-tuple REQUIRE below (+ `passed == corpus.size()`), and JSON↔TS sync is
  // owned by the central `check:exports` gate, so this guard is purely a
  // non-empty smoke and never needs a per-spec bump. If it fails, the fixture
  // looks empty/truncated — regenerate via `pnpm run export:corpus` in
  // packages/test-fixtures-sdk-parity/.
  REQUIRE(corpus.size() >= 8);
  REQUIRE(configs.is_array());

  // Build a configId → (full config JSON, injectionMode) index.
  std::unordered_map<std::string, json> configById;
  std::unordered_map<std::string, std::string> injectionModeById;
  for (const auto& entry : configs) {
    const auto id = entry.at("id").get<std::string>();
    configById[id] = entry.at("config");
    injectionModeById[id] = entry.value("injectionMode", std::string());
  }

  std::size_t passed = 0;
  for (const auto& tuple : corpus) {
    const auto configId = tuple.at("configId").get<std::string>();
    const auto key = tuple.at("key").get<std::string>();
    const auto& defaultJson = tuple.at("defaultValue");
    const auto& expected = tuple.at("expected");
    const auto& userJson = tuple.at("user");

    INFO("description=" << tuple.value("description", "") << " key=" << key
                        << " configId=" << configId);

    auto cfgIt = configById.find(configId);
    REQUIRE(cfgIt != configById.end());
    const auto& cfgJson = cfgIt->second;

    // SC-004: the rule corpus is full-config only. A flat-map tuple here would
    // be a corpus regression — never a silent flat-map fallback.
    REQUIRE(injectionModeById[configId] == "full-config");

    // Capability probe: sdk-cpp exposes `createFlagOverridesFromConfig`, so the
    // full-config path is taken (never the flat-map path). The probe is a
    // compile-time fact here — this file only compiles when the factory + the
    // `ConfigOverrideDataSource` type are part of the public surface — but the
    // SKIP branch in the sibling runners maps to "this file fails to compile"
    // here, an even louder signal than a runtime skip.
    auto fo = createFlagOverridesFromConfig(cfgJson, OverrideBehaviour::LocalOnly);

    auto configPtr = std::make_shared<const json>(cfgJson);
    auto foPtr = std::make_shared<const FlagOverrides>(std::move(fo));
    Snapshot snapshot(configPtr, foPtr, nullptr);

    const auto user = buildUser(userJson);
    const auto actual = snapshot.getValueJson(key, defaultJson, user.get());
    // Principle II NON-NEGOTIABLE — investigate the evaluator / override
    // router, do NOT mutate the corpus. A real C++ targeting-rule engine gap
    // (not an override-wiring bug) is a discrete #382 follow-up, never a corpus
    // or test workaround (AC4). Numbers compare numerically (int-vs-float,
    // double precision); every other kind keeps strict equality.
    REQUIRE(valuesEqual(actual, expected));

    // Spec 152 / #475 US2 — when a tuple carries `expectedVariationId`, assert
    // the PUBLIC `Snapshot::getValueDetails<T>().variationId` (the configcat-cpp
    // details surface) in ADDITION to the value. The variationId MUST propagate
    // through the full-config override path (the #395 gap class). T is dispatched
    // from the resolved value's JSON kind so the typed details envelope matches
    // the setting type.
    if (tuple.contains("expectedVariationId")) {
      const auto expectedVid = tuple.at("expectedVariationId").get<std::string>();
      // Dispatch T on the SETTING TYPE (`f[key].t`), not the value kind: a
      // Double setting (`t==3`) can carry an int-encoded expected (`0` / `1`)
      // that would otherwise be mis-routed to the int envelope. The setting type
      // is the authoritative discriminator.
      const int settingType = cfgJson.at("f").at(key).at("t").get<int>();
      std::optional<std::string> actualVid;
      switch (settingType) {
        case 0:  // Bool
          actualVid =
              snapshot.getValueDetails<bool>(key, defaultJson.get<bool>(), user.get()).variationId;
          break;
        case 1:  // String
          actualVid =
              snapshot.getValueDetails<std::string>(key, defaultJson.get<std::string>(), user.get())
                  .variationId;
          break;
        case 2:  // Int
          actualVid =
              snapshot.getValueDetails<int>(key, defaultJson.get<int>(), user.get()).variationId;
          break;
        default:  // Double (t==3) — decimal tuples; the evaluator returns a double.
          actualVid = snapshot.getValueDetails<double>(key, defaultJson.get<double>(), user.get())
                          .variationId;
          break;
      }
      INFO("variationId mismatch: expected=" << expectedVid
                                             << " actual=" << actualVid.value_or("<nullopt>"));
      REQUIRE(actualVid.has_value());
      REQUIRE(actualVid == expectedVid);
    }
    ++passed;
  }
  // Growth-tolerant: every LOADED tuple must have passed (stronger than a fixed
  // number, and never needs a per-spec bump as the corpus grows).
  REQUIRE(passed == corpus.size());
}

// Sanity: the full-config override source carries the WHOLE `{p, f, s}` blob
// (INV-4 — salt `p.s` + segments `s`, not just `f`), and exposes the flat base
// values for key enumeration without ever routing rule resolution through them.
TEST_CASE("ConfigOverrideDataSource retains the full config", "[parity_rules]") {
  const auto configs = loadJsonFile(fixturesPath() / "parity-configs-rules.json");
  REQUIRE(configs.is_array());
  REQUIRE(!configs.empty());
  const auto& cfgJson = configs.at(0).at("config");

  ConfigOverrideDataSource source(cfgJson);
  // Full `{p, f, s}` retained verbatim.
  REQUIRE(source.config() == cfgJson);
  REQUIRE(source.config().contains("p"));
  REQUIRE(source.config().contains("s"));

  // getOverridesSync exposes the rule-bearing settings map (`f`) so
  // getAllKeys / getAllValues can enumerate the override's flag keys.
  const auto overrides =
      confeature::tests::requireValue(source.getOverridesSync(), "the override map");
  for (auto it = cfgJson.at("f").begin(); it != cfgJson.at("f").end(); ++it) {
    REQUIRE(overrides.count(it.key()) == 1);
  }
}
