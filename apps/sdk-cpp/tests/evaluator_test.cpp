// SPDX-License-Identifier: MIT

#include "internal/evaluator.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

using confeature::internal::evaluate;
using nlohmann::json;

namespace {

json sampleConfig() {
  return json::parse(R"({
    "f": {
      "feature.on":     {"t": 0, "v": {"b": true}},
      "feature.off":    {"t": 0, "v": {"b": false}, "i": "v-off"},
      "feature.string": {"t": 1, "v": {"s": "hello"}, "i": "v-string"},
      "feature.int":    {"t": 2, "v": {"i": 5}, "i": "v-int"},
      "feature.double": {"t": 3, "v": {"d": 0.25}, "i": "v-double"},
      "feature.unknown": {"t": 99, "v": {"b": true}}
    }
  })");
}

}  // namespace

TEST_CASE("evaluate resolves a true boolean", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.on", json(false));
  REQUIRE(r.value == json(true));
  REQUIRE(r.error.empty());
}

TEST_CASE("evaluate captures the variation id", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.off", json(true));
  REQUIRE(r.value == json(false));
  REQUIRE(r.error.empty());
  REQUIRE(r.variationId == "v-off");
}

TEST_CASE("evaluate returns default for missing key", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.absent", json(true));
  REQUIRE(r.value == json(true));
  REQUIRE(r.error == "KEY_NOT_FOUND");
}

TEST_CASE("evaluate flags unsupported types for a truly unknown discriminator", "[evaluator]") {
  // FR-010 reshape (spec 071): UNSUPPORTED_TYPE is now reserved for a
  // TRULY unknown SettingType discriminator. t = 1 / 2 / 3 resolve via
  // the typed branches below.
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.unknown", json(false));
  REQUIRE(r.value == json(false));
  REQUIRE(r.error == "UNSUPPORTED_TYPE");
}

TEST_CASE("evaluate flags type mismatch on the default", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.on", json(42));
  REQUIRE(r.value == json(42));
  REQUIRE(r.error == "TYPE_MISMATCH");
}

TEST_CASE("evaluate handles a null config", "[evaluator]") {
  const auto r = evaluate(nullptr, "x", json(false));
  REQUIRE(r.value == json(false));
  REQUIRE(r.error == "NO_CONFIG");
}

TEST_CASE("evaluate handles a malformed config", "[evaluator]") {
  auto bad = json::object();
  const auto r = evaluate(&bad, "x", json(false));
  REQUIRE(r.error == "MALFORMED_CONFIG");
}

// ── #258 typed-path assertions ────────────────────────────────────────

TEST_CASE("evaluate resolves a string setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.string", json("fallback"));
  REQUIRE(r.value == json("hello"));
  REQUIRE(r.error.empty());
  REQUIRE(r.variationId == "v-string");
}

TEST_CASE("evaluate resolves an int setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.int", json(-1));
  REQUIRE(r.value == json(5));
  REQUIRE(r.error.empty());
  REQUIRE(r.variationId == "v-int");
}

TEST_CASE("evaluate resolves a double setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.double", json(1.0));
  REQUIRE(r.value == json(0.25));
  REQUIRE(r.error.empty());
  REQUIRE(r.variationId == "v-double");
}

TEST_CASE("evaluate accepts an integer default against a double setting", "[evaluator]") {
  // Corpus tuples 7-10 pass integer-encoded defaults against `t = 3`
  // settings (e.g. defaultValue: 1, expected: 0.25). is_number() must
  // accept both encodings on the double arm.
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.double", json(1));
  REQUIRE(r.value == json(0.25));
  REQUIRE(r.error.empty());
}

TEST_CASE("evaluate flags type mismatch — string default against int setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.int", json("not-a-number"));
  REQUIRE(r.value == json("not-a-number"));
  REQUIRE(r.error == "TYPE_MISMATCH");
}

TEST_CASE("evaluate flags type mismatch — int default against string setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.string", json(0));
  REQUIRE(r.value == json(0));
  REQUIRE(r.error == "TYPE_MISMATCH");
}

TEST_CASE("evaluate flags type mismatch — string default against double setting", "[evaluator]") {
  auto cfg = sampleConfig();
  const auto r = evaluate(&cfg, "feature.double", json("not-a-number"));
  REQUIRE(r.value == json("not-a-number"));
  REQUIRE(r.error == "TYPE_MISMATCH");
}

TEST_CASE("evaluate flags malformed string setting — missing slot", "[evaluator]") {
  auto cfg = json::parse(R"({
    "f": {
      "feature.bad": {"t": 1, "v": {"b": true}}
    }
  })");
  const auto r = evaluate(&cfg, "feature.bad", json("fallback"));
  REQUIRE(r.value == json("fallback"));
  REQUIRE(r.error == "MALFORMED_VALUE");
}

TEST_CASE("evaluate flags malformed int setting — non-integer slot", "[evaluator]") {
  // JSON's number type doesn't distinguish int from float by default,
  // but nlohmann::json's is_number_integer() does — a 1.5 in the i slot
  // surfaces as MALFORMED_VALUE.
  auto cfg = json::parse(R"({
    "f": {
      "feature.bad": {"t": 2, "v": {"i": 1.5}}
    }
  })");
  const auto r = evaluate(&cfg, "feature.bad", json(0));
  REQUIRE(r.value == json(0));
  REQUIRE(r.error == "MALFORMED_VALUE");
}

TEST_CASE("evaluate flags malformed double setting — missing slot", "[evaluator]") {
  auto cfg = json::parse(R"({
    "f": {
      "feature.bad": {"t": 3, "v": {"s": "no-double-here"}}
    }
  })");
  const auto r = evaluate(&cfg, "feature.bad", json(0.0));
  REQUIRE(r.value == json(0.0));
  REQUIRE(r.error == "MALFORMED_VALUE");
}
