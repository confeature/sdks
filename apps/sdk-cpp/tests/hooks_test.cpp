// SPDX-License-Identifier: MIT

// Spec 111 / #268 slice 7 — C++ hooks/events bus behavioural tests.
//
// Mirrors `configcat::Hooks` 1:1 at the public API surface — four
// hook points (clientReady, configChanged, flagEvaluated, error).
// Conformance lives in `api_surface_conformance_test.cpp`; this
// file exercises behaviour.

#include <catch2/catch_test_macros.hpp>
#include <memory>
#include <string>
#include <unordered_map>

#include "confeature/client.h"
#include "confeature/flag_overrides.h"
#include "confeature/hooks.h"

namespace {

constexpr const char* kSdkKey =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

std::shared_ptr<confeature::ConfeatureClient> makeLocalOnlyClient() {
  std::unordered_map<std::string, nlohmann::json> overrides_map;
  overrides_map["feature.dark-mode"] = true;
  auto overrides = confeature::FlagOverrides::localOnly(
      std::make_shared<confeature::MapOverrideDataSource>(std::move(overrides_map)));
  return confeature::ConfeatureClient::builder(kSdkKey)
      .flagOverrides(std::move(overrides))
      .pollingMode(confeature::PollingMode::manualPoll())
      .build();
}

}  // namespace

TEST_CASE("Hooks: getHooks returns the same shared instance across calls",
          "[hooks]") {
  auto client = makeLocalOnlyClient();
  REQUIRE(client != nullptr);
  auto a = client->getHooks();
  auto b = client->getHooks();
  REQUIRE(a != nullptr);
  REQUIRE(a.get() == b.get());
}

TEST_CASE("Hooks: invokeOnClientReady fires every registered listener", "[hooks]") {
  confeature::Hooks hooks;
  int fires = 0;
  hooks.addOnClientReady([&fires]() { ++fires; });
  hooks.invokeOnClientReady();
  REQUIRE(fires == 1);
}

TEST_CASE("Hooks: invokeOnConfigChanged passes the settings map", "[hooks]") {
  confeature::Hooks hooks;
  std::unordered_map<std::string, nlohmann::json> captured;
  hooks.addOnConfigChanged(
      [&captured](const std::unordered_map<std::string, nlohmann::json>& s) {
        captured = s;
      });
  std::unordered_map<std::string, nlohmann::json> input;
  input["feature.x"] = nlohmann::json{{"v", true}};
  hooks.invokeOnConfigChanged(input);
  REQUIRE(captured.size() == 1);
  REQUIRE(captured["feature.x"]["v"] == true);
}

TEST_CASE("Hooks: invokeOnFlagEvaluated passes the payload", "[hooks]") {
  confeature::Hooks hooks;
  std::string captured_key;
  hooks.addOnFlagEvaluated(
      [&captured_key](const confeature::FlagEvaluatedPayload& payload) {
        captured_key = payload.key;
      });
  confeature::FlagEvaluatedPayload payload;
  payload.key = "feature.dark-mode";
  hooks.invokeOnFlagEvaluated(payload);
  REQUIRE(captured_key == "feature.dark-mode");
}

TEST_CASE("Hooks: invokeOnError passes the message", "[hooks]") {
  confeature::Hooks hooks;
  std::string captured;
  hooks.addOnError([&captured](const std::string& msg) { captured = msg; });
  hooks.invokeOnError("Config fetch failed.");
  REQUIRE(captured == "Config fetch failed.");
}

TEST_CASE("Hooks: throwing listener does not break siblings", "[hooks]") {
  confeature::Hooks hooks;
  int downstream = 0;
  hooks.addOnError([](const std::string&) { throw std::runtime_error("boom"); });
  hooks.addOnError([&downstream](const std::string&) { ++downstream; });
  hooks.invokeOnError("test");
  REQUIRE(downstream == 1);
}

TEST_CASE("Client.getValueDetails fires flagEvaluated", "[hooks]") {
  auto client = makeLocalOnlyClient();
  REQUIRE(client != nullptr);
  int fires = 0;
  client->getHooks()->addOnFlagEvaluated(
      [&fires](const confeature::FlagEvaluatedPayload&) { ++fires; });
  client->getValueDetails<bool>("feature.dark-mode", false);
  client->getValueDetails<bool>("feature.unknown", false);
  REQUIRE(fires == 2);
}
