// SPDX-License-Identifier: MIT

#include "confeature/client.h"

#include <catch2/catch_test_macros.hpp>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>

#include "confeature/flag_overrides.h"

using confeature::ConfeatureClient;
using confeature::FlagOverrides;
using confeature::MapOverrideDataSource;
using nlohmann::json;

TEST_CASE("ConfeatureClient::create returns a usable shared_ptr", "[client]") {
  auto client = ConfeatureClient::create(
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  REQUIRE(client != nullptr);
  REQUIRE_FALSE(client->isClosed());
}

TEST_CASE("ConfeatureClient::builder accepts the full surface", "[client]") {
  std::unordered_map<std::string, json> overrideMap{{"feature.x", true}};
  auto fo = FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(overrideMap));

  auto client = ConfeatureClient::builder("confeature-sdk-1-key-A-key-B")
                    .baseUrl("http://127.0.0.1:1")
                    .httpTimeout(std::chrono::seconds(1))
                    .cacheDirectory(":memory:")
                    .flagOverrides(std::move(fo))
                    .build();
  REQUIRE(client != nullptr);
  REQUIRE(client->getValue<bool>("feature.x", false) == true);
}

TEST_CASE("ConfeatureClient honours overrides via the LocalOnly path", "[client]") {
  std::unordered_map<std::string, json> overrideMap{
      {"flag.bool", true},
      {"flag.int", 42},
      {"flag.string", "hello"},
  };
  auto fo = FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(overrideMap));
  auto client = ConfeatureClient::builder("confeature-sdk-1-key-A-key-B")
                    .cacheDirectory(":memory:")
                    .flagOverrides(std::move(fo))
                    .build();
  REQUIRE(client->getValue<bool>("flag.bool", false) == true);
  REQUIRE(client->getValue<int>("flag.int", 0) == 42);
  REQUIRE(client->getValue<std::string>("flag.string", std::string("default")) == "hello");
  REQUIRE(client->getValue<bool>("flag.missing", false) == false);
}

TEST_CASE("ConfeatureClient::close is idempotent", "[client]") {
  auto client = ConfeatureClient::create("confeature-sdk-1-key-A-key-B");
  REQUIRE(client != nullptr);
  client->close();
  REQUIRE(client->isClosed());
  client->close();
  REQUIRE(client->isClosed());
  // get_value after close → returns the default + WARN log.
  REQUIRE(client->getValue<bool>("missing", false) == false);
}

TEST_CASE("ConfeatureClient::forceRefresh is a no-op under LocalOnly", "[client]") {
  std::unordered_map<std::string, json> overrideMap{{"flag.bool", true}};
  auto fo = FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(overrideMap));
  auto client = ConfeatureClient::builder("confeature-sdk-1-key-A-key-B")
                    .cacheDirectory(":memory:")
                    .flagOverrides(std::move(fo))
                    .build();
  REQUIRE(client->forceRefresh() == true);
  REQUIRE(client->getValue<bool>("flag.bool", false) == true);
}

// #826 — a local override keyed `__proto__` is an ordinary key: ConfigCat
// reserves no setting key, and a JS SDK once dropped exactly this one.
TEST_CASE("ConfeatureClient honours a LocalOnly override keyed __proto__ (#826)",
          "[client][proto-key]") {
  std::unordered_map<std::string, json> overrideMap{{"__proto__", true}};
  auto fo = FlagOverrides::localOnly(std::make_shared<MapOverrideDataSource>(overrideMap));
  auto client = ConfeatureClient::builder("confeature-sdk-1-key-A-key-B")
                    .cacheDirectory(":memory:")
                    .flagOverrides(std::move(fo))
                    .build();
  REQUIRE(client->getValue<bool>("__proto__", false) == true);
}
