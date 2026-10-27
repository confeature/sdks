// SPDX-License-Identifier: MIT

#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <memory>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>
#include <unordered_map>

#include "confeature/flag_overrides.h"
#include "confeature/snapshot.h"
#include "confeature/user.h"
#include "workspace_root.h"

using confeature::FlagOverrides;
using confeature::MapOverrideDataSource;
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
      user->withCustom(it.key(), it.value().get<std::string>());
    }
  }
  return user;
}

}  // namespace

TEST_CASE("parity corpus — 58 tuples byte-identical across SDKs", "[parity_corpus]") {
  // Cross-language gate: parity-corpus.json + parity-configs.json drive
  // every Confeature SDK. Each SDK reconstructs a Snapshot from the
  // named config and asserts byte-identical evaluation against the
  // expected value. Diverging here breaks Principle II.
  const auto corpus = loadJsonFile(fixturesPath() / "parity-corpus.json");
  const auto configs = loadJsonFile(fixturesPath() / "parity-configs.json");
  REQUIRE(corpus.is_array());
  REQUIRE(corpus.size() == 58);
  REQUIRE(configs.is_array());

  // Build a configId → (config JSON, override map) index.
  std::unordered_map<std::string, json> configById;
  std::unordered_map<std::string, std::unordered_map<std::string, json>> overridesById;
  for (const auto& entry : configs) {
    const auto id = entry.at("id").get<std::string>();
    configById[id] = entry.at("config");
    if (entry.contains("overridesMap") && entry["overridesMap"].is_object()) {
      std::unordered_map<std::string, json> map;
      for (auto it = entry["overridesMap"].begin(); it != entry["overridesMap"].end(); ++it) {
        map.emplace(it.key(), it.value());
      }
      overridesById[id] = std::move(map);
    }
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

    // Always wire up overrides so the parity test exercises the same
    // override-eval path the rest of the federation uses. The corpus
    // tuples that don't rely on overrides still pass — the override
    // map echoes the cached value, so Branch 7 returns the same
    // payload either way.
    auto overridesMap = overridesById[configId];
    auto fo =
        FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(std::move(overridesMap)));

    auto configPtr = std::make_shared<const json>(cfgJson);
    auto foPtr = std::make_shared<const FlagOverrides>(std::move(fo));
    Snapshot snapshot(configPtr, foPtr, nullptr);

    const auto user = buildUser(userJson);
    const auto actual = snapshot.getValueJson(key, defaultJson, user.get());
    REQUIRE(actual == expected);
    ++passed;
  }
  REQUIRE(passed == 58);
}

// ── #258 typed-corpus tier ───────────────────────────────────────────
//
// Sibling driver to the boolean parity tier. Loads the 13-tuple typed
// corpus + the typed configs and exercises the four-type evaluator
// widening (string / int / double) across the typed SettingType
// matrix plus 3 TYPE_MISMATCH cases. The boolean tier above is left
// byte-unchanged (US4 / FR-009).

TEST_CASE("parity corpus typed — 13 tuples byte-identical across SDKs", "[parity_corpus_typed]") {
  const auto corpus = loadJsonFile(fixturesPath() / "parity-corpus-typed.json");
  const auto configs = loadJsonFile(fixturesPath() / "parity-configs-typed.json");
  REQUIRE(corpus.is_array());
  REQUIRE(corpus.size() == 13);
  REQUIRE(configs.is_array());

  // Build a configId → (config JSON, override map) index.
  std::unordered_map<std::string, json> configById;
  std::unordered_map<std::string, std::unordered_map<std::string, json>> overridesById;
  for (const auto& entry : configs) {
    const auto id = entry.at("id").get<std::string>();
    configById[id] = entry.at("config");
    if (entry.contains("overridesMap") && entry["overridesMap"].is_object()) {
      std::unordered_map<std::string, json> map;
      for (auto it = entry["overridesMap"].begin(); it != entry["overridesMap"].end(); ++it) {
        map.emplace(it.key(), it.value());
      }
      overridesById[id] = std::move(map);
    }
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

    auto overridesMap = overridesById[configId];
    auto fo =
        FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(std::move(overridesMap)));

    auto configPtr = std::make_shared<const json>(cfgJson);
    auto foPtr = std::make_shared<const FlagOverrides>(std::move(fo));
    Snapshot snapshot(configPtr, foPtr, nullptr);

    const auto user = buildUser(userJson);

    // The JSON-shape driver covers the Snapshot::getValueJson surface
    // exhaustively (same as the boolean tier above).
    const auto actualJson = snapshot.getValueJson(key, defaultJson, user.get());
    REQUIRE(actualJson == expected);

    // Additionally dispatch the typed-template surface
    // (Snapshot::getValue<T>) — this is what customer code calls.
    // The dispatch is keyed off the expected JSON kind so the four
    // explicit template instantiations on snapshot.cpp / client.cpp
    // (bool / int / double / std::string) all see exercise from the
    // typed corpus.
    if (expected.is_boolean()) {
      const auto v = snapshot.getValue<bool>(key, defaultJson.get<bool>(), user.get());
      REQUIRE(v == expected.get<bool>());
    } else if (expected.is_string()) {
      const auto def = defaultJson.is_string() ? defaultJson.get<std::string>() : std::string();
      const auto v = snapshot.getValue<std::string>(key, def, user.get());
      REQUIRE(v == expected.get<std::string>());
    } else if (expected.is_number_integer()) {
      // Int dispatch: defaultJson may be float-encoded (e.g. corpus
      // tuple 8: defaultValue=1, expected=0 against a t=3 setting).
      // Pass the underlying double cast to int — the override-eval /
      // evaluator decision tree handles the type mismatch.
      const int def = defaultJson.is_number() ? static_cast<int>(defaultJson.get<double>()) : 0;
      // Special-case TYPE_MISMATCH tuple where the default is a string
      // — getValue<int> would otherwise force-cast to 0, which the
      // expected value matches by coincidence. Skip the typed dispatch
      // for that tuple; the JSON-shape REQUIRE above already covers it.
      if (defaultJson.is_number()) {
        const auto v = snapshot.getValue<int>(key, def, user.get());
        REQUIRE(v == expected.get<int>());
      }
    } else if (expected.is_number_float()) {
      const double def = defaultJson.is_number() ? defaultJson.get<double>() : 0.0;
      if (defaultJson.is_number()) {
        const auto v = snapshot.getValue<double>(key, def, user.get());
        REQUIRE(v == expected.get<double>());
      }
    }

    ++passed;
  }
  REQUIRE(passed == 13);
}
