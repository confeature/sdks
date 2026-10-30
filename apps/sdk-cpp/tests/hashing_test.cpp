// SPDX-License-Identifier: MIT

#include "internal/hashing.h"

#include <catch2/catch_test_macros.hpp>
#include <cstdint>
#include <string>

using confeature::internal::hashComparisonValue;
using confeature::internal::percentageBucket;
using confeature::internal::sha1Hex;
using confeature::internal::sha256Hex;

TEST_CASE("sha1Hex matches the known vector", "[hashing]") {
  REQUIRE(sha1Hex("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d");
  REQUIRE(sha1Hex("").size() == 40);
}

TEST_CASE("sha256Hex matches the known vector", "[hashing]") {
  REQUIRE(sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST_CASE("percentageBucket = parseInt(sha1(key+attr)[0..7],16) % 100", "[hashing]") {
  // Cross-checked against hash.ts::percentageBucket (key + attrValue, SHA-1
  // unsalted) — the corpus `string75Cat0Dog25Falcon0Horse` flag, user 12345.
  REQUIRE(percentageBucket("string75Cat0Dog25Falcon0Horse", "12345") == 21ULL);
  // Deterministic across repeats (FR-005).
  const auto first = percentageBucket("k", "v");
  for (int i = 0; i < 8; ++i) {
    REQUIRE(percentageBucket("k", "v") == first);
  }
  REQUIRE(first < 100ULL);
}

TEST_CASE("hashComparisonValue concatenates value+configSalt+contextSalt", "[hashing]") {
  // sha256("abc" + "" + "") == sha256("abc").
  REQUIRE(hashComparisonValue("abc", "", "") == sha256Hex("abc"));
  REQUIRE(hashComparisonValue("a", "b", "c") == sha256Hex("abc"));
}
