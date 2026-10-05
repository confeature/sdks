// SPDX-License-Identifier: MIT

#include "internal/sdk_key.h"

#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>

#include "workspace_root.h"

using confeature::internal::base64UrlEncode;
using confeature::internal::cacheKeyTail;
using confeature::internal::deriveCacheKey;
using confeature::internal::isValidConfeatureKeyFormat;
using confeature::internal::redactSdkKey;
using confeature::tests::fixturesPath;
using nlohmann::json;

namespace {

// The ONE accept/reject list every Confeature SDK validator is tested
// against (#802, FR-006b) — never a per-SDK list.
json loadSdkKeyShapes() {
  std::ifstream stream(fixturesPath() / "sdk-key-shapes.json");
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  return json::parse(buf.str());
}

}  // namespace

TEST_CASE("deriveCacheKey matches the canonical fixture", "[sdk_key]") {
  const std::string key =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  REQUIRE(deriveCacheKey(key) == "confeature:cache:v1:bIg57I9_4ya_LRRpZZ8qZdn_gXPqQ1aY");
}

TEST_CASE("deriveCacheKey handles the empty string", "[sdk_key]") {
  REQUIRE(deriveCacheKey("") == "confeature:cache:v1:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NM");
}

TEST_CASE("redactSdkKey hides the secret payload", "[sdk_key]") {
  const std::string key =
      "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const auto redacted = redactSdkKey(key);
  REQUIRE(redacted.find("[redacted]") != std::string::npos);
  // The masked middle section must NOT contain the secret payload.
  REQUIRE(redacted.find(key.substr(20, 20)) == std::string::npos);
}

TEST_CASE("redactSdkKey short keys return the marker", "[sdk_key]") {
  REQUIRE(redactSdkKey("") == "[redacted]");
  REQUIRE(redactSdkKey("short") == "[redacted]");
}

TEST_CASE("redactSdkKey shows no more of a ConfigCat-shaped key than of a legacy one",
          "[sdk_key]") {
  // 61 chars -> 6 visible at each end; the legacy 83-char key shows 8.
  const std::string key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";
  const auto redacted = redactSdkKey(key);
  REQUIRE(redacted == "config\xE2\x80\xA6[redacted]\xE2\x80\xA6tRea02");
  REQUIRE(redacted.find("FAKEfixtureKeyNotRea01") == std::string::npos);
  REQUIRE(redacted.find("FAKEfixtureKeyNotRea02") == std::string::npos);
}

TEST_CASE("isValidConfeatureKeyFormat accepts every valid shape in sdk-key-shapes.json",
          "[sdk_key]") {
  const auto shapes = loadSdkKeyShapes();
  REQUIRE_FALSE(shapes.at("valid").empty());
  for (const auto& row : shapes.at("valid")) {
    INFO("case: " << row.at("name").get<std::string>());
    REQUIRE(isValidConfeatureKeyFormat(row.at("key").get<std::string>()));
  }
}

TEST_CASE("isValidConfeatureKeyFormat rejects every invalid shape in sdk-key-shapes.json",
          "[sdk_key]") {
  const auto shapes = loadSdkKeyShapes();
  REQUIRE_FALSE(shapes.at("invalid").empty());
  for (const auto& row : shapes.at("invalid")) {
    INFO("case: " << row.at("name").get<std::string>());
    REQUIRE_FALSE(isValidConfeatureKeyFormat(row.at("key").get<std::string>()));
  }
}

TEST_CASE("cacheKeyTail strips the envelope prefix", "[sdk_key]") {
  REQUIRE(cacheKeyTail("confeature:cache:v1:abc") == "abc");
  REQUIRE(cacheKeyTail("no-colon") == "no-colon");
}

TEST_CASE("base64UrlEncode handles common lengths", "[sdk_key]") {
  // RFC 4648 §10 vectors — translated to the URL-safe alphabet without
  // padding. base64UrlEncode is the only base64 surface in the SDK, so
  // these vectors gate the encoder.
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>(""), 0).empty());
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("f"), 1) == "Zg");
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("fo"), 2) == "Zm8");
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("foo"), 3) == "Zm9v");
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("foob"), 4) == "Zm9vYg");
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("fooba"), 5) == "Zm9vYmE");
  REQUIRE(base64UrlEncode(reinterpret_cast<const unsigned char*>("foobar"), 6) == "Zm9vYmFy");
}
