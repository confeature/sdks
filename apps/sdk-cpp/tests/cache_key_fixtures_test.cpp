// SPDX-License-Identifier: MIT

#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>

#include "internal/sdk_key.h"
#include "workspace_root.h"

using confeature::internal::deriveCacheKey;
using confeature::tests::fixturesPath;
using nlohmann::json;

TEST_CASE("cache-key fixtures pass byte-identical across SDKs", "[cache_key_fixtures]") {
  // Cross-language gate: cache-key-fixtures.json is the single source
  // of truth shared by every Confeature SDK. Any drift in the
  // SHA-256 + base64url + truncate-to-32 pipeline breaks Principle II.
  const auto path = fixturesPath() / "cache-key-fixtures.json";
  std::ifstream stream(path);
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  auto fixtures = json::parse(buf.str());
  REQUIRE(fixtures.is_array());
  REQUIRE_FALSE(fixtures.empty());

  for (const auto& tuple : fixtures) {
    const auto sdkKey = tuple.at("sdkKey").get<std::string>();
    const auto expected = tuple.at("expectedCacheKey").get<std::string>();
    INFO("sdkKey size=" << sdkKey.size() << " expected=" << expected);
    REQUIRE(deriveCacheKey(sdkKey) == expected);
  }
}
