// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_HOOKS_H_
#define CONFEATURE_HOOKS_H_

// Subscribe to client lifecycle events. Mirrors `configcat::Hooks`
// 1:1 at the public API surface (constitution Principle II, epic #268).
//
// Four hook points map to the JS-family reference contract:
// clientReady, configChanged, flagEvaluated, clientError. Listener
// exceptions are caught + logged by `invokeOn*` paths — never escape
// to the emitter.
//
// Obtain via `ConfeatureClient::getHooks()`.

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "confeature/logger.h"

namespace confeature {

// Non-templated payload passed to onFlagEvaluated listeners. Mirrors
// the metadata exposed by upstream `configcat::EvaluationDetails<>` —
// the boxed `value` is carried as `nlohmann::json` so a single
// (non-template) callback shape covers every T resolved at the
// `getValue<T>` / `getValueDetails<T>` call sites.
struct FlagEvaluatedPayload {
  std::string key;
  nlohmann::json value;
  bool isDefaultValue{false};
  std::optional<std::string> error;
  std::optional<std::string> variationId;
  std::int64_t fetchTimeUnixMillis{0};
};

class Hooks {
 public:
  using OnClientReady = std::function<void()>;
  using OnConfigChanged =
      std::function<void(const std::unordered_map<std::string, nlohmann::json>&)>;
  using OnFlagEvaluated = std::function<void(const FlagEvaluatedPayload&)>;
  using OnError = std::function<void(const std::string&)>;

  explicit Hooks(std::shared_ptr<Logger> logger = nullptr);

  // ── Subscription ────────────────────────────────────────────────────
  void addOnClientReady(OnClientReady listener);
  void addOnConfigChanged(OnConfigChanged listener);
  void addOnFlagEvaluated(OnFlagEvaluated listener);
  void addOnError(OnError listener);

  // ── Internal emit helpers — listener exceptions caught + logged.
  void invokeOnClientReady();
  void invokeOnConfigChanged(const std::unordered_map<std::string, nlohmann::json>& settings);
  void invokeOnFlagEvaluated(const FlagEvaluatedPayload& payload);
  void invokeOnError(const std::string& message);

  Hooks(const Hooks&) = delete;
  Hooks& operator=(const Hooks&) = delete;
  Hooks(Hooks&&) = delete;
  Hooks& operator=(Hooks&&) = delete;

 private:
  mutable std::mutex mutex_;
  std::vector<OnClientReady> on_client_ready_;
  std::vector<OnConfigChanged> on_config_changed_;
  std::vector<OnFlagEvaluated> on_flag_evaluated_;
  std::vector<OnError> on_error_;
  std::shared_ptr<Logger> logger_;
};

}  // namespace confeature

#endif  // CONFEATURE_HOOKS_H_
