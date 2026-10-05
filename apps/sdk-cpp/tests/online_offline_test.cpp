// SPDX-License-Identifier: MIT
//
// Spec 096 / #267 — slice 7/14 — sdk-cpp online/offline triplet.
//
// Mirrors the upstream `configcat::ConfigCatClient::setOnline()` /
// `setOffline()` / `isOffline()` surface, including the LocalOnly +
// closed-client edge cases. Conformance lives in
// `api_surface_conformance_test.cpp`; this file exercises behaviour.

#include <catch2/catch_test_macros.hpp>
#include <memory>
#include <string>
#include <unordered_map>

#include "confeature/confeature.h"

using nlohmann::json;
using confeature::ConfeatureClient;
using confeature::FlagOverrides;
using confeature::MapOverrideDataSource;

namespace {

constexpr const char* kSdkKey =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

std::shared_ptr<ConfeatureClient> buildManualClient() {
  return ConfeatureClient::builder(kSdkKey)
      .baseUrl("http://127.0.0.1:1")
      .cacheDirectory(":memory:")
      .build();
}

std::shared_ptr<ConfeatureClient> buildLocalOnlyClient() {
  std::unordered_map<std::string, json> overrideMap{{"feature.x", true}};
  auto fo = FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(overrideMap));
  return ConfeatureClient::builder(kSdkKey)
      .cacheDirectory(":memory:")
      .flagOverrides(std::move(fo))
      .build();
}

}  // namespace

TEST_CASE("ConfeatureClient is online by default", "[client][online-offline]") {
  auto client = buildManualClient();
  REQUIRE_FALSE(client->isOffline());
}

TEST_CASE("ConfeatureClient::setOffline flips the flag", "[client][online-offline]") {
  auto client = buildManualClient();
  client->setOffline();
  REQUIRE(client->isOffline());
}

TEST_CASE("ConfeatureClient::setOnline resets the flag", "[client][online-offline]") {
  auto client = buildManualClient();
  client->setOffline();
  REQUIRE(client->isOffline());
  client->setOnline();
  REQUIRE_FALSE(client->isOffline());
}

TEST_CASE("ConfeatureClient online/offline setters are idempotent", "[client][online-offline]") {
  auto client = buildManualClient();
  client->setOffline();
  client->setOffline();
  client->setOffline();
  REQUIRE(client->isOffline());
  client->setOnline();
  client->setOnline();
  client->setOnline();
  REQUIRE_FALSE(client->isOffline());
}

TEST_CASE("ConfeatureClient::forceRefresh returns false while offline",
          "[client][online-offline]") {
  auto client = buildManualClient();
  client->setOffline();
  REQUIRE_FALSE(client->forceRefresh());
}

TEST_CASE("LocalOnly client always reports offline=true", "[client][online-offline][local-only]") {
  auto client = buildLocalOnlyClient();
  REQUIRE(client->isOffline());
}

TEST_CASE("LocalOnly setOnline is a no-op", "[client][online-offline][local-only]") {
  auto client = buildLocalOnlyClient();
  client->setOnline();
  // Still offline because LocalOnly always is.
  REQUIRE(client->isOffline());
}

TEST_CASE("LocalOnly setOffline is a silent no-op", "[client][online-offline][local-only]") {
  auto client = buildLocalOnlyClient();
  client->setOffline();
  REQUIRE(client->isOffline());
}

TEST_CASE("Closed client reports offline=true", "[client][online-offline][closed]") {
  auto client = buildManualClient();
  client->close();
  REQUIRE(client->isOffline());
}

TEST_CASE("Closed client setters are no-op (no crash)", "[client][online-offline][closed]") {
  auto client = buildManualClient();
  client->close();
  // Both setters must be safe to call after close.
  client->setOnline();
  client->setOffline();
  REQUIRE(client->isOffline());
}

TEST_CASE("LocalOnly getValue still resolves while offline by definition",
          "[client][online-offline][local-only]") {
  auto client = buildLocalOnlyClient();
  REQUIRE(client->isOffline());
  REQUIRE(client->getValue<bool>("feature.x", false) == true);
}
