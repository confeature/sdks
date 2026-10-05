// SPDX-License-Identifier: MIT

#include "internal/override_eval.h"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

#include "confeature/flag_overrides.h"
#include "confeature/user.h"
#include "internal/evaluator.h"

namespace confeature::internal {

namespace {

// Reports whether two JSON values share a kind for the override-eval
// type-check.
//
// Numeric values are treated as one kind regardless of integer vs
// float JSON encoding — this matches the TS canonical implementation
// where `typeof 42 === typeof 42.5 === "number"`.
bool sameJsonKind(const nlohmann::json& a, const nlohmann::json& b) {
  if (a.is_boolean() && b.is_boolean()) {
    return true;
  }
  if (a.is_string() && b.is_string()) {
    return true;
  }
  if (a.is_number() && b.is_number()) {
    return true;
  }
  if (a.is_array() && b.is_array()) {
    return true;
  }
  if (a.is_object() && b.is_object()) {
    return true;
  }
  if (a.is_null() && b.is_null()) {
    return true;
  }
  return false;
}

}  // namespace

std::pair<bool, std::optional<nlohmann::json>> evaluateSync(const FlagOverrides* overrides,
                                                            const std::string& key,
                                                            const nlohmann::json& defaultValue) {
  // Branch 1.
  if (overrides == nullptr) {
    return {false, std::nullopt};
  }

  // Branch 2.
  if (overrides->behaviour() != OverrideBehaviour::LocalOnly) {
    return {false, std::nullopt};
  }

  // Branch 3.
  const auto& dataSource = overrides->dataSource();
  if (!dataSource) {
    return {false, std::nullopt};
  }
  auto maybeMap = dataSource->getOverridesSync();
  if (!maybeMap.has_value()) {
    return {false, std::nullopt};
  }

  // From here we are committed to the LocalOnly contract — never fall
  // through.
  const auto& map = *maybeMap;

  // Branch 4: key absent.
  auto it = map.find(key);
  if (it == map.end()) {
    return {true, defaultValue};
  }

  // Branch 5: raw value is null.
  const auto& raw = it->second;
  if (raw.is_null()) {
    return {true, defaultValue};
  }

  // Branch 6: TYPE_MISMATCH. A null default bypasses the check
  // (matches the TS `defaultValue !== null` semantics).
  if (!defaultValue.is_null() && !sameJsonKind(raw, defaultValue)) {
    return {true, defaultValue};
  }

  // Branch 7: happy path.
  return {true, raw};
}

std::pair<bool, std::optional<nlohmann::json>> evaluateFullConfigSync(
    const FlagOverrides* overrides, const std::string& key, const nlohmann::json& defaultValue,
    const User* user) {
  if (overrides == nullptr) {
    return {false, std::nullopt};
  }
  if (overrides->behaviour() != OverrideBehaviour::LocalOnly) {
    return {false, std::nullopt};
  }

  const auto& dataSource = overrides->dataSource();
  const auto* configSource = dynamic_cast<const ConfigOverrideDataSource*>(dataSource.get());
  if (configSource == nullptr) {
    return {false, std::nullopt};
  }

  // Pass the FULL config blob (salt `p.s` + segments `s` + rule-bearing `f`),
  // never just `f` (INV-4). The evaluator never throws — any failure resolves
  // to the caller's default.
  const auto result = evaluate(&configSource->config(), key, defaultValue, user);
  return {true, result.value};
}

std::pair<bool, std::optional<nlohmann::json>> evaluateOverride(const FlagOverrides* overrides,
                                                                const std::string& key,
                                                                const nlohmann::json& defaultValue,
                                                                const User* user) {
  // Full-config source → ALWAYS resolve through the evaluator; NEVER fall
  // through to the flat-map path (which would mis-read rule-bearing settings as
  // value-only). Dispatch on the source TYPE, not the resolved value.
  if (overrides != nullptr && overrides->behaviour() == OverrideBehaviour::LocalOnly &&
      dynamic_cast<const ConfigOverrideDataSource*>(overrides->dataSource().get()) != nullptr) {
    return evaluateFullConfigSync(overrides, key, defaultValue, user);
  }
  // Every other source (map / custom) keeps the byte-identical flat-map path.
  return evaluateSync(overrides, key, defaultValue);
}

}  // namespace confeature::internal
