// SPDX-License-Identifier: MIT

#include "internal/override_eval.h"

#include <catch2/catch_test_macros.hpp>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>

#include "confeature/flag_overrides.h"

using confeature::FlagOverrides;
using confeature::MapOverrideDataSource;
using confeature::OverrideBehaviour;
using confeature::OverrideDataSource;
using confeature::internal::evaluateSync;
using nlohmann::json;

namespace {

FlagOverrides makeLocalOnly(std::unordered_map<std::string, json> map) {
  return FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(std::move(map)));
}

class NullSyncDataSource : public OverrideDataSource {
 public:
  std::optional<std::unordered_map<std::string, json>> getOverridesSync() const override {
    return std::nullopt;
  }
};

}  // namespace

TEST_CASE("Branch 1: nullptr overrides fall through", "[override_eval]") {
  const auto [ok, value] = evaluateSync(nullptr, "k", json(false));
  REQUIRE_FALSE(ok);
  REQUIRE_FALSE(value.has_value());
}

TEST_CASE("Branch 2: non-LocalOnly behaviour falls through", "[override_eval]") {
  FlagOverrides fo(std::make_shared<MapOverrideDataSource>(std::unordered_map<std::string, json>{}),
                   OverrideBehaviour::LocalOverRemote);
  const auto [ok, value] = evaluateSync(&fo, "k", json(false));
  REQUIRE_FALSE(ok);
  REQUIRE_FALSE(value.has_value());
}

TEST_CASE("Branch 3: no synchronous data falls through", "[override_eval]") {
  FlagOverrides fo(std::make_shared<NullSyncDataSource>(), OverrideBehaviour::LocalOnly);
  const auto [ok, value] = evaluateSync(&fo, "k", json(false));
  REQUIRE_FALSE(ok);
  REQUIRE_FALSE(value.has_value());
}

TEST_CASE("Branch 4: absent key returns the default", "[override_eval]") {
  auto fo = makeLocalOnly({});
  const auto [ok, value] = evaluateSync(&fo, "missing", json(false));
  REQUIRE(ok);
  REQUIRE(value.has_value());
  REQUIRE(value == json(false));
}

TEST_CASE("Branch 5: null override returns the default", "[override_eval]") {
  auto fo = makeLocalOnly({{"k", json(nullptr)}});
  const auto [ok, value] = evaluateSync(&fo, "k", json(true));
  REQUIRE(ok);
  REQUIRE(value == json(true));
}

TEST_CASE("Branch 6: type mismatch returns the default", "[override_eval]") {
  auto fo = makeLocalOnly({{"k", json("string-value")}});
  const auto [ok, value] = evaluateSync(&fo, "k", json(true));
  REQUIRE(ok);
  REQUIRE(value == json(true));
}

TEST_CASE("Branch 6: null default bypasses the type check", "[override_eval]") {
  auto fo = makeLocalOnly({{"k", json("string-value")}});
  const auto [ok, value] = evaluateSync(&fo, "k", json(nullptr));
  REQUIRE(ok);
  REQUIRE(value == json("string-value"));
}

TEST_CASE("Branch 7: happy path returns the override", "[override_eval]") {
  auto fo = makeLocalOnly({{"k", json(true)}});
  const auto [ok, value] = evaluateSync(&fo, "k", json(false));
  REQUIRE(ok);
  REQUIRE(value == json(true));
}
