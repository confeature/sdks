// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_FLAG_OVERRIDES_H_
#define CONFEATURE_FLAG_OVERRIDES_H_

// FlagOverrides mirrors ConfigCat-cpp's customer-supplied override
// bundle. v0.1 honours `LocalOnly`; `LocalOverRemote` / `RemoteOverLocal`
// are accepted at construction but logged as deferred by the evaluator
// (out-of-scope per spec).
//
// `MapOverrideDataSource` is the only synchronous data source we ship
// in v0.1 — a `std::unordered_map<std::string, nlohmann::json>` snapshot
// supplied by the customer.

#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>

namespace confeature {

enum class OverrideBehaviour {
  LocalOnly = 0,
  LocalOverRemote = 1,
  RemoteOverLocal = 2,
};

// Synchronous override-data-source interface. Customer subclasses
// override `getOverridesSync` to return a JSON map; returning
// `std::nullopt` signals "no synchronous data" (override-eval Branch 3
// — fall through to the cache).
class OverrideDataSource {
 public:
  virtual ~OverrideDataSource() = default;
  virtual std::optional<std::unordered_map<std::string, nlohmann::json>> getOverridesSync()
      const = 0;
};

// Default in-memory implementation backed by a flat map.
class MapOverrideDataSource : public OverrideDataSource {
 public:
  explicit MapOverrideDataSource(std::unordered_map<std::string, nlohmann::json> map)
      : map_(std::move(map)) {}

  std::optional<std::unordered_map<std::string, nlohmann::json>> getOverridesSync() const override {
    return map_;
  }

 private:
  std::unordered_map<std::string, nlohmann::json> map_;
};

// Full-config override source — holds a complete parsed `config_v6` blob
// (`{p, f, s}`) and routes through the real evaluator offline.
//
// Spec 135 / #437 (epic #382, US3): the rule-bearing sibling of
// `MapOverrideDataSource`. Where the map source emits value-only settings,
// this source retains the WHOLE `{p, f, s}` config — salt (`p.s`) + segments
// (`s`) + rule-bearing settings (`f`) — so the C++ evaluator can resolve
// targeting rules / segments / prerequisites / percentage options purely from
// the supplied config, no network fetch.
//
// Additive extension (Principle II): the official `configcat-cpp` SDK exposes
// only a *file-based* full-config override (`FlagOverrides` over a local file)
// alongside the value-only map source. This in-memory form is the
// runtime-agnostic equivalent of the file path (the corpus / test-harness use
// case), mirroring the JS federation's `ConfigOverrideDataSource` /
// `createFlagOverridesFromConfig` and sdk-python / sdk-dart's
// `ConfigOverrideDataSource`. No ConfigCat-named member is renamed or retyped.
//
// The whole config blob is retained (never just `f`) — the spec-129
// dropped-salt regression guard (INV-4): percentage bucketing reads `p.s` and
// segment conditions read `s`.
//
// This source intentionally does NOT route rule-bearing data through the
// value-only resolution path: `getOverridesSync` returns the flat *base* value
// envelopes (so key enumeration / `getAllKeys` / `getAllValues` work), but
// resolution itself never goes through that flat map — the override router
// (`internal::evaluateOverride` in `internal/override_eval.cpp`) dispatches on
// the source TYPE so a `ConfigOverrideDataSource` always routes through the
// evaluator with the full `config()`.
class ConfigOverrideDataSource : public OverrideDataSource {
 public:
  explicit ConfigOverrideDataSource(nlohmann::json config)
      : config_(std::move(config)), baseValues_(baseValuesOf(config_)) {}

  // The full parsed `config_v6` blob (`{p, f, s}`). Consumed by the
  // full-config override router; never the flat-map path.
  const nlohmann::json& config() const { return config_; }

  // Returns the flat *base* value envelopes of the settings (the served
  // `setting.v.{b,s,i,d}`), so `getAllKeys` / `getAllValues` can enumerate the
  // override's flag keys. Rule resolution never goes through this map — the
  // router evaluates the full config through the real evaluator.
  std::optional<std::unordered_map<std::string, nlohmann::json>> getOverridesSync()
      const override {
    return baseValues_;
  }

 private:
  // Derives the flat base-value map from the config's `f` object once at
  // construction so key enumeration is cheap and stable.
  static std::unordered_map<std::string, nlohmann::json> baseValuesOf(
      const nlohmann::json& config) {
    std::unordered_map<std::string, nlohmann::json> out;
    if (!config.is_object()) {
      return out;
    }
    const auto fIt = config.find("f");
    if (fIt == config.end() || !fIt->is_object()) {
      return out;
    }
    for (auto it = fIt->begin(); it != fIt->end(); ++it) {
      const auto& setting = it.value();
      if (!setting.is_object()) {
        continue;
      }
      const auto vIt = setting.find("v");
      if (vIt == setting.end() || !vIt->is_object()) {
        continue;
      }
      for (const char* slot : {"b", "s", "i", "d"}) {
        const auto valIt = vIt->find(slot);
        if (valIt != vIt->end() && !valIt->is_null()) {
          out.emplace(it.key(), *valIt);
          break;
        }
      }
    }
    return out;
  }

  nlohmann::json config_;
  std::unordered_map<std::string, nlohmann::json> baseValues_;
};

class FlagOverrides {
 public:
  FlagOverrides(std::shared_ptr<OverrideDataSource> dataSource, OverrideBehaviour behaviour)
      : dataSource_(std::move(dataSource)), behaviour_(behaviour) {}

  static FlagOverrides localOnly(std::shared_ptr<OverrideDataSource> source) {
    return FlagOverrides(std::move(source), OverrideBehaviour::LocalOnly);
  }

  const std::shared_ptr<OverrideDataSource>& dataSource() const { return dataSource_; }
  OverrideBehaviour behaviour() const { return behaviour_; }

 private:
  std::shared_ptr<OverrideDataSource> dataSource_;
  OverrideBehaviour behaviour_;
};

// Build a `FlagOverrides` from a complete, rule-bearing `config_v6` blob
// (`{p, f, s}`) evaluated offline through the real C++ evaluator.
//
// The in-memory, rule-bearing offline-override factory (spec 135 / #437,
// epic #382, US3). With `OverrideBehaviour::LocalOnly`,
// `getValue(key, default, user)` resolves targeting rules / segments /
// prerequisites / percentage options purely from `config` through the real
// evaluator — no network fetch.
//
// Additive (Principle II): mirrors the JS federation's
// `createFlagOverridesFromConfig` and sdk-python's
// `create_flag_overrides_from_config`. The official `configcat-cpp` SDK
// exposes the value-only map source + the file-based full-config override;
// this is the runtime-agnostic in-memory full-config equivalent, so a customer
// can drive the full rule engine from a config blob already resident in memory
// (the corpus / test-harness use case). No ConfigCat-named member is renamed
// or retyped.
inline FlagOverrides createFlagOverridesFromConfig(nlohmann::json config,
                                                   OverrideBehaviour behaviour) {
  return FlagOverrides(std::make_shared<ConfigOverrideDataSource>(std::move(config)), behaviour);
}

}  // namespace confeature

#endif  // CONFEATURE_FLAG_OVERRIDES_H_
