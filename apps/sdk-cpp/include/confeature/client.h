// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_CLIENT_H_
#define CONFEATURE_CLIENT_H_

// Top-level customer-facing `ConfeatureClient`. Drop-in compatible with
// ConfigCat-cpp's `ConfigCatClient`: customers migrate by renaming the
// class + the include header (constitution Principle II — NON-NEGOTIABLE).
//
// Public API:
//   - ConfeatureClient::create(sdkKey) → std::shared_ptr<ConfeatureClient>
//   - ConfeatureClient::builder(sdkKey) → fluent builder
//   - getValue<T>(key, default, user = nullptr)
//   - snapshot()
//   - forceRefresh()
//   - close() (idempotent via std::atomic<bool>)

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "confeature/config_cache.h"
#include "confeature/evaluation_details.h"
#include "confeature/flag_overrides.h"
#include "confeature/hooks.h"
#include "confeature/logger.h"
#include "confeature/polling_mode.h"
#include "confeature/snapshot.h"
#include "confeature/user.h"

namespace confeature {

class ConfeatureClient;

class ConfeatureClientBuilder {
 public:
  explicit ConfeatureClientBuilder(std::string sdkKey);

  ConfeatureClientBuilder& pollingMode(PollingMode mode);
  ConfeatureClientBuilder& baseUrl(std::string url);
  ConfeatureClientBuilder& httpTimeout(std::chrono::seconds timeout);
  ConfeatureClientBuilder& logger(std::shared_ptr<Logger> logger);
  ConfeatureClientBuilder& cache(std::shared_ptr<ConfigCache> cache);
  ConfeatureClientBuilder& cacheDirectory(std::filesystem::path directory);
  ConfeatureClientBuilder& flagOverrides(FlagOverrides overrides);
  ConfeatureClientBuilder& defaultUser(User user);

  // Validates configuration + constructs the client. Returns a
  // shared_ptr so the customer can keep multiple stable handles to the
  // same underlying poll-thread + cache.
  std::shared_ptr<ConfeatureClient> build();

 private:
  friend class ConfeatureClient;

  std::string sdkKey_;
  PollingMode pollingMode_{PollingMode::autoPoll()};
  std::optional<std::string> baseUrl_;
  std::chrono::seconds httpTimeout_{30};
  std::shared_ptr<Logger> logger_;
  std::shared_ptr<ConfigCache> cache_;
  std::optional<std::filesystem::path> cacheDirectory_;
  std::optional<FlagOverrides> flagOverrides_;
  std::optional<User> defaultUser_;
};

class ConfeatureClient : public std::enable_shared_from_this<ConfeatureClient> {
 public:
  // Static factory mirroring ConfigCat-cpp's ConfigCatClient::create.
  // Returns a shared_ptr seeded with `sdkKey` and the default
  // (AutoPoll) polling mode.
  static std::shared_ptr<ConfeatureClient> create(const std::string& sdkKey);

  // Fluent builder. Returns a ConfeatureClientBuilder ready for
  // chaining (`.pollingMode(...).logger(...).build()`).
  static ConfeatureClientBuilder builder(std::string sdkKey);

  // Resolves `key`. Returns `defaultValue` for any failure path. The
  // SDK NEVER throws from a public method.
  //
  // `T` must be one of {bool, int, double, std::string} — the four
  // SettingType discriminators handled by the v1 evaluator (see
  // internal/evaluator.h). Each `T` resolves through the cache-driven
  // path against its matching slot (`b` / `s` / `i` / `d`).
  template <typename T>
  T getValue(const std::string& key, const T& defaultValue, const User* user = nullptr) const;

  // Spec 085 / #266 slice 7/12 — typed evaluation-details envelope.
  // Mirrors ConfigCat-cpp's `ConfigCatClient::getValueDetails<T>`.
  // Closed clients return an envelope with `value = defaultValue`,
  // `isDefaultValue = true`, `error = "CLIENT_CLOSED"`,
  // `fetchTimeUnixMillis = 0`. Every error branch sets
  // `isDefaultValue = true` and populates `error`.
  template <typename T>
  EvaluationDetails<T> getValueDetails(const std::string& key, const T& defaultValue,
                                       const User* user = nullptr) const;

  // Spec 085 / #266 slice 7/12 — bulk evaluate all known flags.
  // Mirrors ConfigCat-cpp's `ConfigCatClient::getAllValues` shape,
  // using `nlohmann::json` as the heterogeneous value container.
  // Closed clients return an empty map.
  std::unordered_map<std::string, nlohmann::json> getAllValues(
      const User* user = nullptr) const;

  // Triggers an immediate synchronous fetch + cache update. Returns
  // true on success, false if the fetch failed (the reason is logged).
  // No-op when LocalOnly overrides are configured.
  bool forceRefresh();

  // Returns an immutable Snapshot of the last-known config plus a
  // detached reference to the override view.
  Snapshot snapshot() const;

  // Returns the union of cached-config + override keys, sorted
  // ordinally. Mirrors ConfigCat-cpp's
  // `ConfigCatClient::getAllKeys()` return shape
  // (`std::vector<std::string>`). Closed clients return an empty
  // vector (matches the closed-client read semantics of
  // `getValue<T>`). Delegates to `snapshot().getAllKeys()` so the
  // underlying read path is identical to the snapshot accessor.
  std::vector<std::string> getAllKeys() const;

  // Spec 096 / #267 slice 7/14 — online/offline triplet. Mirrors
  // configcat::ConfigCatClient::setOnline() / setOffline() / isOffline().
  // setOnline / setOffline are idempotent. LocalOnly clients: isOffline()
  // returns true; setOnline() logs WARN + no-op; setOffline() silent no-op.
  // Closed clients: isOffline() returns true; setters log WARN + no-op.
  void setOnline();
  void setOffline();
  bool isOffline() const;

  // Spec 111 / #268 slice 7 — hooks/events subscription surface. Mirrors
  // `configcat::ConfigCatClient::getHooks()`. Returns a non-null shared
  // pointer for the lifetime of the client; the same pointer is returned
  // on every call.
  std::shared_ptr<Hooks> getHooks() const;

  // Idempotent close — cancels every spawned task. Safe to call from
  // any thread.
  void close();

  // For tests + diagnostics: reports whether close() has been called.
  bool isClosed() const { return closed_.load(std::memory_order_seq_cst); }

  // Destructor — re-runs close() as a safety net.
  ~ConfeatureClient();

  ConfeatureClient(const ConfeatureClient&) = delete;
  ConfeatureClient& operator=(const ConfeatureClient&) = delete;
  ConfeatureClient(ConfeatureClient&&) = delete;
  ConfeatureClient& operator=(ConfeatureClient&&) = delete;

 private:
  friend class ConfeatureClientBuilder;
  struct Impl;

  explicit ConfeatureClient(std::unique_ptr<Impl> impl);

  std::unique_ptr<Impl> impl_;
  std::atomic<bool> closed_{false};
  std::atomic<bool> offline_{false};
};

}  // namespace confeature

#endif  // CONFEATURE_CLIENT_H_
