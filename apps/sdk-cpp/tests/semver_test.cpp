// SPDX-License-Identifier: MIT

#include "internal/semver.h"

#include <catch2/catch_test_macros.hpp>
#include <string>

#include "require_value.h"

using confeature::internal::SemVer;

namespace {

int cmp(const std::string& a, const std::string& b) {
  const auto va = confeature::tests::requireValue(SemVer::parse(a), a.c_str());
  const auto vb = confeature::tests::requireValue(SemVer::parse(b), b.c_str());
  const int c = va.compare(vb);
  if (c == 0) {
    return 0;
  }
  return c < 0 ? -1 : 1;
}

}  // namespace

TEST_CASE("semver parses strict grammar + optional v prefix", "[semver]") {
  REQUIRE(SemVer::parse("1.2.3").has_value());
  REQUIRE(SemVer::parse("v1.2.3").has_value());
  REQUIRE(SemVer::parse(" 1.0.0 ").has_value());  // parse on trim
  REQUIRE(SemVer::parse("1.0.0-alpha.1+build.5").has_value());
  REQUIRE_FALSE(SemVer::parse("1.2").has_value());
  REQUIRE_FALSE(SemVer::parse("1.2.3.4").has_value());
  REQUIRE_FALSE(SemVer::parse("not-a-version").has_value());
  REQUIRE_FALSE(SemVer::parse("01.2.3").has_value());  // leading zero
}

TEST_CASE("semver precedence — core fields", "[semver]") {
  REQUIRE(cmp("1.0.0", "2.0.0") == -1);
  REQUIRE(cmp("2.0.0", "2.1.0") == -1);
  REQUIRE(cmp("2.1.0", "2.1.1") == -1);
  REQUIRE(cmp("1.2.3", "1.2.3") == 0);
}

TEST_CASE("semver precedence — pre-release ranks below release", "[semver]") {
  // A version WITHOUT a pre-release is higher-precedence than one WITH.
  REQUIRE(cmp("1.0.0-alpha", "1.0.0") == -1);
  REQUIRE(cmp("1.0.0", "1.0.0-alpha") == 1);
}

TEST_CASE("semver precedence — pre-release field-by-field (SemVer 11.4)", "[semver]") {
  REQUIRE(cmp("1.0.0-alpha", "1.0.0-alpha.1") == -1);
  REQUIRE(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta") == -1);
  REQUIRE(cmp("1.0.0-alpha.beta", "1.0.0-beta") == -1);
  REQUIRE(cmp("1.0.0-beta", "1.0.0-beta.2") == -1);
  REQUIRE(cmp("1.0.0-beta.2", "1.0.0-beta.11") == -1);  // numeric, not lexical
  REQUIRE(cmp("1.0.0-beta.11", "1.0.0-rc.1") == -1);
}

TEST_CASE("semver — build metadata is ignored for precedence", "[semver]") {
  REQUIRE(cmp("1.0.0+build.1", "1.0.0+build.2") == 0);
}
