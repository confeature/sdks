// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_SNAPSHOT_H_
#define CONFEATURE_SNAPSHOT_H_

// Snapshot — immutable view of the last-known config + override
// data-source. Mirrors ConfigCat-cpp's `Snapshot`. Useful in async
// pipelines that need a stable view of the flag world for the
// duration of a request.
//
// Snapshots are cheap shared-pointer copies of the underlying config
// JSON; mutation of the live ConfeatureClient doesn't affect an
// existing Snapshot.

#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "confeature/evaluation_details.h"
#include "confeature/flag_overrides.h"
#include "confeature/user.h"

namespace confeature {

class Snapshot {
 public:
  Snapshot(std::shared_ptr<const nlohmann::json> config,
           std::shared_ptr<const FlagOverrides> overrides, std::shared_ptr<const User> defaultUser,
           std::int64_t fetchTimeUnixMillis = 0);

  // Resolves `key`. Returns `defaultValue` for any failure path.
  // T must be bool / int / double / std::string for v0.1 (boolean is
  // the only fully-honoured kind; other primitive defaults reach the
  // generic evaluator code path).
  template <typename T>
  T getValue(const std::string& key, const T& defaultValue, const User* user = nullptr) const;

  // Spec 085 / #266 slice 7/12 — typed evaluation-details envelope.
  // Returns an `EvaluationDetails<T>` populated with the resolved
  // value, the captured `fetchTimeUnixMillis`, the user supplied to
  // the call (falling back to the snapshot's default user), and an
  // error code on every failure branch. Never throws.
  template <typename T>
  EvaluationDetails<T> getValueDetails(const std::string& key, const T& defaultValue,
                                       const User* user = nullptr) const;

  // Spec 085 / #266 slice 7/12 — bulk evaluate every key visible to
  // this snapshot. Mirrors ConfigCat-cpp's
  // `ConfigCatClient::getAllValues` return shape, using
  // `nlohmann::json` as the heterogeneous value container (sdk-cpp
  // codebase convention — see `getValueJson`). Returns an empty map
  // when neither the captured config nor the override datasource
  // expose any keys.
  std::unordered_map<std::string, nlohmann::json> getAllValues(const User* user = nullptr) const;

  // Returns the union of cached-config + override keys, sorted
  // ordinally for deterministic output. Mirrors ConfigCat-cpp's
  // `ConfigCatClient::getAllKeys()` return shape
  // (`std::vector<std::string>`). Returns an empty vector when neither
  // the captured config nor any overrides expose keys.
  std::vector<std::string> getAllKeys() const;

  // Spec 085 / #266 — wall-clock millis-since-epoch of the last
  // successful fetch (or cache restore) observed by the client at
  // snapshot construction time. `0` if the client has never observed
  // any config.
  std::int64_t fetchTimeUnixMillis() const { return fetchTimeUnixMillis_; }

  // Internal-only escape hatch: evaluate against the snapshot using a
  // JSON default. Public so ConfeatureClient::getValue can route
  // through this path without re-implementing the override branch
  // logic.
  nlohmann::json getValueJson(const std::string& key, const nlohmann::json& defaultValue,
                              const User* user = nullptr) const;

 private:
  // Spec 085 / #266 — shared helper for getValueDetails<T>. Resolves
  // `key` against the override + cache branches, returning the JSON
  // value, an error code (empty on success), and the variation ID
  // (empty on every fail branch and on override hits).
  struct JsonDetails {
    nlohmann::json value;
    std::string error;          // empty on success
    std::string variationId;    // empty on override hit + fail branches
    bool matchedRule{false};    // a targeting rule decided the value (spec 130)
    bool matchedOption{false};  // a percentage option decided the value
  };
  JsonDetails resolveJsonDetails(const std::string& key, const nlohmann::json& defaultValue,
                                 const User* user) const;

  std::shared_ptr<const nlohmann::json> config_;
  std::shared_ptr<const FlagOverrides> overrides_;
  std::shared_ptr<const User> defaultUser_;
  std::int64_t fetchTimeUnixMillis_{0};
};

}  // namespace confeature

#endif  // CONFEATURE_SNAPSHOT_H_
