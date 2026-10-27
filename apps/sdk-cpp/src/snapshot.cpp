// SPDX-License-Identifier: MIT

#include "confeature/snapshot.h"

#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "confeature/evaluation_details.h"
#include "internal/evaluator.h"
#include "internal/override_eval.h"

namespace confeature {

Snapshot::Snapshot(std::shared_ptr<const nlohmann::json> config,
                   std::shared_ptr<const FlagOverrides> overrides,
                   std::shared_ptr<const User> defaultUser, std::int64_t fetchTimeUnixMillis)
    : config_(std::move(config)),
      overrides_(std::move(overrides)),
      defaultUser_(std::move(defaultUser)),
      fetchTimeUnixMillis_(fetchTimeUnixMillis) {}

nlohmann::json Snapshot::getValueJson(const std::string& key, const nlohmann::json& defaultValue,
                                      const User* user) const {
  const auto* const resolvedUser = user != nullptr ? user : defaultUser_.get();
  // Override branch first. The router dispatches on the source TYPE: a
  // `MapOverrideDataSource` keeps the byte-identical flat-map path
  // (`evaluateSync`), while a `ConfigOverrideDataSource` routes the FULL
  // `{p, f, s}` config through the real evaluator offline (spec 135 / #437).
  if (overrides_) {
    const auto [handled, value] =
        internal::evaluateOverride(overrides_.get(), key, defaultValue, resolvedUser);
    if (handled) {
      return value.value_or(defaultValue);
    }
  }
  // Cache branch.
  const auto* cfg = config_ ? config_.get() : nullptr;
  const auto r = internal::evaluate(cfg, key, defaultValue, resolvedUser);
  return r.value;
}

Snapshot::JsonDetails Snapshot::resolveJsonDetails(const std::string& key,
                                                   const nlohmann::json& defaultValue,
                                                   const User* user) const {
  // Override branch first. Re-resolves the LocalOnly map post-evaluateSync
  // so we can distinguish "branch 7 happy path" from
  // "branch 4 KEY_NOT_FOUND" / "branch 5 NULL_VALUE" /
  // "branch 6 TYPE_MISMATCH" — the override-eval API returns
  // {handled, optional<value>} without an error code, but spec 085 +
  // FR-007/FR-008 require an error code on every fail branch.
  if (overrides_) {
    // Full-config override source (spec 135 / #437): resolve through the real
    // evaluator so targeting rules / segments / % options apply offline — and,
    // critically, so the variationId the evaluator computes propagates into the
    // details envelope (the #395 gap class). The flat-map `evaluateSync` path
    // below intentionally carries no variationId (upstream parity for the
    // value-only LocalOnly map), but the rule-bearing config path MUST.
    if (overrides_->behaviour() == OverrideBehaviour::LocalOnly) {
      const auto& src = overrides_->dataSource();
      const auto* configSource = dynamic_cast<const ConfigOverrideDataSource*>(src.get());
      if (configSource != nullptr) {
        const auto* evalUser = user != nullptr ? user : defaultUser_.get();
        const auto r = internal::evaluate(&configSource->config(), key, defaultValue, evalUser);
        return JsonDetails{r.value, r.error, r.variationId, r.hasMatchedRule, r.hasMatchedOption};
      }
    }
    const auto [handled, value] = internal::evaluateSync(overrides_.get(), key, defaultValue);
    if (handled) {
      // Re-walk the LocalOnly map to recover the branch taken.
      const auto& ds = overrides_->dataSource();
      if (ds) {
        const auto maybeMap = ds->getOverridesSync();
        if (maybeMap.has_value()) {
          const auto it = maybeMap->find(key);
          if (it == maybeMap->end()) {
            return JsonDetails{defaultValue, "KEY_NOT_FOUND", std::string()};
          }
          if (it->second.is_null()) {
            return JsonDetails{defaultValue, "MALFORMED_VALUE", std::string()};
          }
          // Branch 6 TYPE_MISMATCH: the resolved value equals the
          // default because override-eval rejected the type mismatch.
          // We detect the rejection by checking whether the JSON-kind
          // of the raw override differs from the default's kind.
          auto sameKind = [](const nlohmann::json& a, const nlohmann::json& b) {
            return (a.is_boolean() && b.is_boolean()) || (a.is_string() && b.is_string()) ||
                   (a.is_number() && b.is_number()) || (a.is_array() && b.is_array()) ||
                   (a.is_object() && b.is_object()) || (a.is_null() && b.is_null());
          };
          if (!defaultValue.is_null() && !sameKind(it->second, defaultValue)) {
            return JsonDetails{defaultValue, "TYPE_MISMATCH", std::string()};
          }
          // Branch 7 — happy path. Variation ID is not exposed by the
          // LocalOnly override surface (matches upstream).
          return JsonDetails{value.value_or(defaultValue), std::string(), std::string()};
        }
      }
      // Fallback — override returned a value but datasource was absent.
      return JsonDetails{value.value_or(defaultValue), std::string(), std::string()};
    }
  }
  // Cache branch — the evaluator already returns the error code.
  const auto* cfg = config_ ? config_.get() : nullptr;
  const auto* const resolvedUser = user != nullptr ? user : defaultUser_.get();
  const auto r = internal::evaluate(cfg, key, defaultValue, resolvedUser);
  return JsonDetails{r.value, r.error, r.variationId, r.hasMatchedRule, r.hasMatchedOption};
}

template <typename T>
T Snapshot::getValue(const std::string& key, const T& defaultValue, const User* user) const {
  const nlohmann::json defaultJson = defaultValue;
  const auto resolved = getValueJson(key, defaultJson, user);
  try {
    return resolved.get<T>();
  } catch (const nlohmann::json::exception&) {
    return defaultValue;
  }
}

template <typename T>
EvaluationDetails<T> Snapshot::getValueDetails(const std::string& key, const T& defaultValue,
                                               const User* user) const {
  EvaluationDetails<T> details;
  details.key = key;
  details.fetchTimeUnixMillis = fetchTimeUnixMillis_;
  if (user != nullptr) {
    details.user = *user;
  } else if (defaultUser_) {
    details.user = *defaultUser_;
  }

  const nlohmann::json defaultJson = defaultValue;
  const auto resolved = resolveJsonDetails(key, defaultJson, user);
  if (!resolved.error.empty()) {
    details.value = defaultValue;
    details.isDefaultValue = true;
    details.error = resolved.error;
    return details;
  }
  // Success — extract T. If the JSON cast fails (shouldn't reach here
  // for a correctly-typed override / evaluator result, but defence in
  // depth) fall back to defaultValue + TYPE_MISMATCH.
  try {
    details.value = resolved.value.get<T>();
    details.isDefaultValue = false;
    if (!resolved.variationId.empty()) {
      details.variationId = resolved.variationId;
    }
    // Spec 130 — populate the matched-rule / matched-option placeholders.
    if (resolved.matchedRule) {
      details.matchedTargetingRule = TargetingRule{};
    }
    if (resolved.matchedOption) {
      details.matchedPercentageOption = PercentageOption{};
    }
  } catch (const nlohmann::json::exception&) {
    details.value = defaultValue;
    details.isDefaultValue = true;
    details.error = std::string("TYPE_MISMATCH");
  }
  return details;
}

std::unordered_map<std::string, nlohmann::json> Snapshot::getAllValues(const User* /*user*/) const {
  // Bulk evaluator — walks the override + cache branches directly
  // rather than routing each key through `getValueJson`, which is
  // typed-default driven and would TYPE_MISMATCH against a `null`
  // sentinel.
  //
  // Override branch (LocalOnly only — mirrors getValueJson): the raw
  // map value lands as-is.
  //
  // Cache branch: read each setting's `t` discriminator + matching
  // value slot (`v.b` / `v.s` / `v.i` / `v.d`). Settings with a
  // malformed slot are skipped (matches upstream exclusion).
  std::unordered_map<std::string, nlohmann::json> out;

  std::optional<std::unordered_map<std::string, nlohmann::json>> overrideMap;
  const bool overrideLocalOnly =
      overrides_ && overrides_->behaviour() == OverrideBehaviour::LocalOnly;
  if (overrideLocalOnly && overrides_->dataSource()) {
    overrideMap = overrides_->dataSource()->getOverridesSync();
  }

  if (overrideLocalOnly) {
    // Branch A — LocalOnly: never fall through to the cache.
    if (overrideMap.has_value()) {
      for (const auto& [k, v] : *overrideMap) {
        if (v.is_null()) {
          continue;
        }
        out.emplace(k, v);
      }
    }
    return out;
  }

  // Branch B — no overrides (or non-LocalOnly): walk the cached
  // config's `f` object.
  if (config_ && config_->is_object()) {
    const auto fIt = config_->find("f");
    if (fIt != config_->end() && fIt->is_object()) {
      for (auto it = fIt->begin(); it != fIt->end(); ++it) {
        const auto& setting = it.value();
        if (!setting.is_object()) {
          continue;
        }
        const auto tIt = setting.find("t");
        if (tIt == setting.end() || !tIt->is_number_integer()) {
          continue;
        }
        const auto vIt = setting.find("v");
        if (vIt == setting.end() || !vIt->is_object()) {
          continue;
        }
        const int t = tIt->get<int>();
        switch (t) {
          case internal::kSettingTypeBool: {
            const auto b = vIt->find("b");
            if (b != vIt->end() && b->is_boolean()) {
              out.emplace(it.key(), b->get<bool>());
            }
            break;
          }
          case internal::kSettingTypeString: {
            const auto s = vIt->find("s");
            if (s != vIt->end() && s->is_string()) {
              out.emplace(it.key(), s->get<std::string>());
            }
            break;
          }
          case internal::kSettingTypeInt: {
            const auto i = vIt->find("i");
            if (i != vIt->end() && i->is_number_integer()) {
              out.emplace(it.key(), i->get<std::int64_t>());
            }
            break;
          }
          case internal::kSettingTypeDouble: {
            const auto d = vIt->find("d");
            if (d != vIt->end() && d->is_number()) {
              out.emplace(it.key(), d->get<double>());
            }
            break;
          }
          default:
            // Unknown SettingType — skip (matches upstream).
            break;
        }
      }
    }
  }
  return out;
}

std::vector<std::string> Snapshot::getAllKeys() const {
  // Walks the captured config's `f` object + the override map (if any).
  // The two sources are unioned into a sorted set for deterministic
  // output (mirrors the JVM ports' TreeSet-backed enumeration).
  std::set<std::string> keys;
  if (config_ && config_->is_object()) {
    const auto f = config_->find("f");
    if (f != config_->end() && f->is_object()) {
      for (auto it = f->begin(); it != f->end(); ++it) {
        keys.insert(it.key());
      }
    }
  }
  if (overrides_ && overrides_->dataSource()) {
    const auto overrideMap = overrides_->dataSource()->getOverridesSync();
    if (overrideMap.has_value()) {
      for (const auto& [k, _] : *overrideMap) {
        keys.insert(k);
      }
    }
  }
  return std::vector<std::string>(keys.begin(), keys.end());
}

// Explicit template instantiations for the v0.1 primitive surface. New
// kinds (e.g. `std::vector<…>`) require an addition here plus a
// parity-corpus tuple before the implementation lands.
template bool Snapshot::getValue<bool>(const std::string&, const bool&, const User*) const;
template int Snapshot::getValue<int>(const std::string&, const int&, const User*) const;
template double Snapshot::getValue<double>(const std::string&, const double&, const User*) const;
template std::string Snapshot::getValue<std::string>(const std::string&, const std::string&,
                                                     const User*) const;

// Spec 085 / #266 — typed `getValueDetails<T>` instantiations.
template EvaluationDetails<bool> Snapshot::getValueDetails<bool>(const std::string&, const bool&,
                                                                 const User*) const;
template EvaluationDetails<int> Snapshot::getValueDetails<int>(const std::string&, const int&,
                                                               const User*) const;
template EvaluationDetails<double> Snapshot::getValueDetails<double>(const std::string&,
                                                                     const double&,
                                                                     const User*) const;
template EvaluationDetails<std::string> Snapshot::getValueDetails<std::string>(const std::string&,
                                                                               const std::string&,
                                                                               const User*) const;

}  // namespace confeature
