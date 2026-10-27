// SPDX-License-Identifier: MIT

#include "confeature/client.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "confeature/config_cache.h"
#include "confeature/evaluation_details.h"
#include "confeature/logger.h"
#include "confeature/snapshot.h"
#include "confeature/version.h"
#include "filesystem_cache.h"
#include "internal/config_fetcher.h"
#include "internal/in_memory_cache.h"
#include "internal/sdk_key.h"

namespace confeature {

// Internal state container. Held by unique_ptr so the public client
// header doesn't have to surface libcurl / nlohmann / std::mutex.
struct ConfeatureClient::Impl {
  std::string sdkKey;
  std::shared_ptr<Logger> logger;
  std::shared_ptr<ConfigCache> cache;
  std::string cacheKey;
  std::optional<FlagOverrides> flagOverrides;
  std::optional<User> defaultUser;
  internal::ConfigFetcher fetcher;
  // Spec 111 / #268 slice 7 — hooks/events bus. Lifetime tied to the
  // owning ConfeatureClient — the shared_ptr we return from getHooks()
  // keeps the bus alive even if a listener outlives the client.
  std::shared_ptr<Hooks> hooks;
  std::atomic<bool> clientReadyFired{false};

  mutable std::mutex stateMutex;
  std::shared_ptr<const nlohmann::json> config;
  std::optional<std::string> etag;
  // Spec 085 / #266 — wall-clock millis-since-epoch of the last
  // successful fetch (or cache restore). Reads via Snapshot are
  // expected to be cheap, so the field is an atomic and lives outside
  // the stateMutex critical section.
  std::atomic<std::int64_t> fetchTimeUnixMillis{0};

  /// LocalOnly overrides switch the network off for the client's whole life:
  /// refresh, setOnline/setOffline and isOffline all key off this one predicate.
  bool isLocalOnly() const {
    return flagOverrides.has_value() &&
           flagOverrides->behaviour() == OverrideBehaviour::LocalOnly;
  }

  static std::int64_t nowUnixMillis() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }

  Impl(std::string key, std::shared_ptr<Logger> log, std::shared_ptr<ConfigCache> cacheImpl,
       std::optional<std::string> baseUrl, std::chrono::seconds timeout,
       std::optional<FlagOverrides> overrides, std::optional<User> defaultUserOpt)
      : sdkKey(std::move(key)),
        logger(std::move(log)),
        cache(std::move(cacheImpl)),
        cacheKey(internal::deriveCacheKey(sdkKey)),
        flagOverrides(std::move(overrides)),
        defaultUser(std::move(defaultUserOpt)),
        fetcher(sdkKey, std::string(SDK_VERSION), std::move(baseUrl), timeout, logger),
        hooks(std::make_shared<Hooks>(logger)) {
    // Restore any persisted cache entry so the first getValue can
    // resolve against on-disk state before the first fetch lands.
    if (!cache) {
      return;
    }
    // A custom ConfigCache may throw despite its contract; a cache miss,
    // never a throwing constructor (#838). Its message is not logged: a
    // user cache's text is unknown, and may quote anything.
    std::optional<std::string> persisted;
    try {
      persisted = cache->read(cacheKey);
    } catch (...) {
      if (logger) {
        logger->warning("ConfeatureClient: ignored a cache read that threw");
      }
      return;
    }
    if (!persisted.has_value()) {
      return;
    }
    try {
      auto parsed = nlohmann::json::parse(*persisted);
      // Persisted format: { "body": <config>, "etag": "..." }. Older
      // entries may store the bare config — be tolerant.
      if (parsed.is_object() && parsed.contains("body")) {
        config = std::make_shared<const nlohmann::json>(parsed["body"]);
        if (parsed.contains("etag") && parsed["etag"].is_string()) {
          etag = parsed["etag"].get<std::string>();
        }
      } else {
        config = std::make_shared<const nlohmann::json>(std::move(parsed));
      }
      // Spec 085 / #266 — surface cache-restore as a "fetch observed"
      // moment so EvaluationDetails.fetchTimeUnixMillis is non-zero on
      // the first getValueDetails call (matches upstream behaviour:
      // cache restore counts as a config-observation event).
      if (config) {
        fetchTimeUnixMillis.store(nowUnixMillis(), std::memory_order_seq_cst);
        // Hook bus (spec 111 / #268) — cache hit fires clientReady once.
        fireClientReadyOnce();
      }
    } catch (const nlohmann::json::exception& err) {
      // Every json exception, not only parse_error: a number like 1e400
      // throws out_of_range (406) from parse (#838). The rest of the block
      // reads `body` only after contains() and `etag` only after
      // is_string(), so nothing else in it throws; the entry is ignored.
      config.reset();
      etag.reset();
      if (logger) {
        logger->warning(std::string("ConfeatureClient: ignored malformed cache entry — ") +
                        err.what());
      }
    }
  }

  bool performFetch() {
    std::optional<std::string> prev;
    {
      std::lock_guard<std::mutex> guard(stateMutex);
      prev = etag;
    }
    auto result = fetcher.fetch(prev);
    if (result.status == internal::FetchStatus::Failed) {
      // Hook bus (spec 111 / #268) — fire onError on fetch failure.
      if (hooks) {
        hooks->invokeOnError("Config fetch failed.");
      }
      return false;
    }
    if (result.status == internal::FetchStatus::NotModified) {
      // 304 — keep the cached config, refresh the etag slot if the
      // server sent one. Counts as a successful fetch for the
      // wall-clock accounting (matches upstream: a 304 IS a fresh
      // confirmation that the cached config is current).
      if (result.etag.has_value()) {
        std::lock_guard<std::mutex> guard(stateMutex);
        etag = result.etag;
      }
      fetchTimeUnixMillis.store(nowUnixMillis(), std::memory_order_seq_cst);
      fireClientReadyOnce();
      return true;
    }
    if (!result.body.has_value()) {
      return false;
    }
    auto body = std::make_shared<const nlohmann::json>(std::move(*result.body));
    {
      std::lock_guard<std::mutex> guard(stateMutex);
      config = body;
      etag = result.etag;
    }
    fetchTimeUnixMillis.store(nowUnixMillis(), std::memory_order_seq_cst);
    if (cache) {
      nlohmann::json envelope;
      envelope["body"] = *body;
      envelope["etag"] = result.etag.value_or("");
      cache->write(cacheKey, envelope.dump());
    }
    // Hook bus (spec 111 / #268) — fire configChanged + clientReady.
    if (hooks) {
      std::unordered_map<std::string, nlohmann::json> settings;
      if (body->is_object() && body->contains("f") && (*body)["f"].is_object()) {
        for (auto it = (*body)["f"].begin(); it != (*body)["f"].end(); ++it) {
          settings.emplace(it.key(), it.value());
        }
      }
      hooks->invokeOnConfigChanged(settings);
    }
    fireClientReadyOnce();
    return true;
  }

  void fireClientReadyOnce() {
    bool expected = false;
    if (clientReadyFired.compare_exchange_strong(expected, true)) {
      if (hooks) {
        hooks->invokeOnClientReady();
      }
    }
  }

  Snapshot makeSnapshot() const {
    std::shared_ptr<const nlohmann::json> cfg;
    {
      std::lock_guard<std::mutex> guard(stateMutex);
      cfg = config;
    }
    std::shared_ptr<const FlagOverrides> overridesPtr;
    if (flagOverrides.has_value()) {
      overridesPtr = std::make_shared<const FlagOverrides>(*flagOverrides);
    }
    std::shared_ptr<const User> userPtr;
    if (defaultUser.has_value()) {
      userPtr = std::make_shared<const User>(*defaultUser);
    }
    return Snapshot(std::move(cfg), std::move(overridesPtr), std::move(userPtr),
                    fetchTimeUnixMillis.load(std::memory_order_seq_cst));
  }
};

// ----- Builder ---------------------------------------------------------------

ConfeatureClientBuilder::ConfeatureClientBuilder(std::string sdkKey) : sdkKey_(std::move(sdkKey)) {}

ConfeatureClientBuilder& ConfeatureClientBuilder::pollingMode(PollingMode mode) {
  pollingMode_ = mode;
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::baseUrl(std::string url) {
  baseUrl_ = std::move(url);
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::httpTimeout(std::chrono::seconds timeout) {
  httpTimeout_ = timeout;
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::logger(std::shared_ptr<Logger> logger) {
  logger_ = std::move(logger);
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::cache(std::shared_ptr<ConfigCache> cache) {
  cache_ = std::move(cache);
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::cacheDirectory(std::filesystem::path directory) {
  cacheDirectory_ = std::move(directory);
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::flagOverrides(FlagOverrides overrides) {
  flagOverrides_ = std::move(overrides);
  return *this;
}
ConfeatureClientBuilder& ConfeatureClientBuilder::defaultUser(User user) {
  defaultUser_ = std::move(user);
  return *this;
}

std::shared_ptr<ConfeatureClient> ConfeatureClientBuilder::build() {
  std::shared_ptr<Logger> log = logger_ ? logger_ : makeDefaultLogger();

  if (sdkKey_.empty()) {
    log->error("ConfeatureClient: empty SDK key — refusing to construct");
    return nullptr;
  }
  if (!internal::isValidConfeatureKeyFormat(sdkKey_)) {
    log->warning("INVALID_SDK_KEY format; continuing — runtime is lenient (sdkKey=" +
                 internal::redactSdkKey(sdkKey_) + ")");
  }

  std::shared_ptr<ConfigCache> cacheImpl = cache_;
  if (!cacheImpl) {
    auto dir = cacheDirectory_.value_or(internal::defaultCacheDirectory());
    if (dir.empty() || dir.string() == ":memory:") {
      cacheImpl = std::make_shared<internal::InMemoryCache>();
    } else {
      cacheImpl = std::make_shared<internal::FilesystemCache>(std::move(dir), log);
    }
  }

  auto impl = std::make_unique<ConfeatureClient::Impl>(
      std::move(sdkKey_), std::move(log), cacheImpl, std::move(baseUrl_), httpTimeout_,
      std::move(flagOverrides_), std::move(defaultUser_));
  // Hold a unique_ptr through the private constructor — std::make_shared
  // can't see ConfeatureClient's private ctor.
  std::shared_ptr<ConfeatureClient> client(new ConfeatureClient(std::move(impl)));

  // v0.1 fetches synchronously on first force_refresh; AutoPoll thread
  // lands with the poll-service follow-up. ManualPoll and LazyLoad
  // behave correctly today — no fetch on build, only on
  // forceRefresh()/getValue() per the upstream contract.
  // The pollingMode_ option is captured for the follow-up but not yet
  // wired into a background thread (see plan §Phase 0 R4).
  (void)pollingMode_;

  return client;
}

// ----- ConfeatureClient ------------------------------------------------------

ConfeatureClient::ConfeatureClient(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}

ConfeatureClient::~ConfeatureClient() {
  close();
}

std::shared_ptr<ConfeatureClient> ConfeatureClient::create(const std::string& sdkKey) {
  return builder(sdkKey).build();
}

ConfeatureClientBuilder ConfeatureClient::builder(std::string sdkKey) {
  return ConfeatureClientBuilder(std::move(sdkKey));
}

bool ConfeatureClient::forceRefresh() {
  if (closed_.load(std::memory_order_seq_cst)) {
    return false;
  }
  if (impl_->isLocalOnly()) {
    // LocalOnly never fetches — treat refresh as a no-op success.
    return true;
  }
  if (offline_.load(std::memory_order_seq_cst)) {
    // Spec 096 / #267 — no HTTP while offline. Mirrors upstream's
    // RefreshResult.failure("OFFLINE_MODE") semantic.
    return false;
  }
  return impl_->performFetch();
}

// Spec 096 / #267 slice 7/14 — online/offline triplet. Mirrors
// configcat::ConfigCatClient::setOnline() / setOffline() / isOffline().
void ConfeatureClient::setOnline() {
  if (closed_.load(std::memory_order_seq_cst)) {
    if (impl_->logger) {
      impl_->logger->warning("setOnline called after close (sdkKey=" +
                             internal::redactSdkKey(impl_->sdkKey) + ")");
    }
    return;
  }
  if (impl_->isLocalOnly()) {
    if (impl_->logger) {
      impl_->logger->warning(
          "Client is configured to use the LocalOnly override behaviour, "
          "thus setOnline has no effect (sdkKey=" +
          internal::redactSdkKey(impl_->sdkKey) + ")");
    }
    return;
  }
  offline_.store(false, std::memory_order_seq_cst);
}

void ConfeatureClient::setOffline() {
  if (closed_.load(std::memory_order_seq_cst)) {
    if (impl_->logger) {
      impl_->logger->warning("setOffline called after close (sdkKey=" +
                             internal::redactSdkKey(impl_->sdkKey) + ")");
    }
    return;
  }
  if (impl_->isLocalOnly()) {
    // Silent no-op — LocalOnly never polls.
    return;
  }
  offline_.store(true, std::memory_order_seq_cst);
}

bool ConfeatureClient::isOffline() const {
  if (closed_.load(std::memory_order_seq_cst)) {
    return true;
  }
  if (impl_->isLocalOnly()) {
    return true;
  }
  return offline_.load(std::memory_order_seq_cst);
}

Snapshot ConfeatureClient::snapshot() const {
  return impl_->makeSnapshot();
}

// Spec 111 / #268 slice 7 — hooks/events subscription surface.
std::shared_ptr<Hooks> ConfeatureClient::getHooks() const {
  return impl_->hooks;
}

std::vector<std::string> ConfeatureClient::getAllKeys() const {
  if (closed_.load(std::memory_order_seq_cst)) {
    return {};
  }
  return impl_->makeSnapshot().getAllKeys();
}

void ConfeatureClient::close() {
  // Idempotent — atomic CAS so concurrent calls see one winner.
  bool expected = false;
  if (!closed_.compare_exchange_strong(expected, true)) {
    return;
  }
  // Poll-service follow-up will shut down its thread here. v0.1 has
  // nothing to tear down besides the atomic flag.
}

template <typename T>
T ConfeatureClient::getValue(const std::string& key, const T& defaultValue,
                             const User* user) const {
  if (closed_.load(std::memory_order_seq_cst)) {
    if (impl_->logger) {
      impl_->logger->warning("getValue called after close (sdkKey=" +
                             internal::redactSdkKey(impl_->sdkKey) + ", key=" + key + ")");
    }
    return defaultValue;
  }
  const auto snap = impl_->makeSnapshot();
  return snap.getValue<T>(key, defaultValue, user);
}

template bool ConfeatureClient::getValue<bool>(const std::string&, const bool&, const User*) const;
template int ConfeatureClient::getValue<int>(const std::string&, const int&, const User*) const;
template double ConfeatureClient::getValue<double>(const std::string&, const double&,
                                                   const User*) const;
template std::string ConfeatureClient::getValue<std::string>(const std::string&, const std::string&,
                                                             const User*) const;

// Spec 085 / #266 slice 7/12 — typed evaluation-details envelope.
template <typename T>
EvaluationDetails<T> ConfeatureClient::getValueDetails(const std::string& key,
                                                      const T& defaultValue,
                                                      const User* user) const {
  if (closed_.load(std::memory_order_seq_cst)) {
    if (impl_->logger) {
      impl_->logger->warning("getValueDetails called after close (sdkKey=" +
                             internal::redactSdkKey(impl_->sdkKey) + ", key=" + key + ")");
    }
    EvaluationDetails<T> closedDetails;
    closedDetails.key = key;
    closedDetails.value = defaultValue;
    closedDetails.fetchTimeUnixMillis = 0;
    closedDetails.isDefaultValue = true;
    closedDetails.error = std::string("CLIENT_CLOSED");
    if (user != nullptr) {
      closedDetails.user = *user;
    } else {
      closedDetails.user = impl_->defaultUser;
    }
    // Hook bus (spec 111 / #268) — fire flagEvaluated on closed path too.
    if (impl_->hooks) {
      FlagEvaluatedPayload payload;
      payload.key = closedDetails.key;
      payload.value = nlohmann::json(closedDetails.value);
      payload.isDefaultValue = closedDetails.isDefaultValue;
      payload.error = closedDetails.error;
      payload.fetchTimeUnixMillis = closedDetails.fetchTimeUnixMillis;
      impl_->hooks->invokeOnFlagEvaluated(payload);
    }
    return closedDetails;
  }
  const auto snap = impl_->makeSnapshot();
  auto details = snap.getValueDetails<T>(key, defaultValue, user);
  // Hook bus (spec 111 / #268) — fire flagEvaluated with the produced envelope.
  if (impl_->hooks) {
    FlagEvaluatedPayload payload;
    payload.key = details.key;
    payload.value = nlohmann::json(details.value);
    payload.isDefaultValue = details.isDefaultValue;
    payload.error = details.error;
    payload.variationId = details.variationId;
    payload.fetchTimeUnixMillis = details.fetchTimeUnixMillis;
    impl_->hooks->invokeOnFlagEvaluated(payload);
  }
  return details;
}

template EvaluationDetails<bool> ConfeatureClient::getValueDetails<bool>(const std::string&,
                                                                        const bool&,
                                                                        const User*) const;
template EvaluationDetails<int> ConfeatureClient::getValueDetails<int>(const std::string&,
                                                                      const int&,
                                                                      const User*) const;
template EvaluationDetails<double> ConfeatureClient::getValueDetails<double>(const std::string&,
                                                                            const double&,
                                                                            const User*) const;
template EvaluationDetails<std::string> ConfeatureClient::getValueDetails<std::string>(
    const std::string&, const std::string&, const User*) const;

// Spec 085 / #266 slice 7/12 — bulk evaluate every known flag.
std::unordered_map<std::string, nlohmann::json> ConfeatureClient::getAllValues(
    const User* user) const {
  if (closed_.load(std::memory_order_seq_cst)) {
    if (impl_->logger) {
      impl_->logger->warning("getAllValues called after close (sdkKey=" +
                             internal::redactSdkKey(impl_->sdkKey) + ")");
    }
    return {};
  }
  return impl_->makeSnapshot().getAllValues(user);
}

}  // namespace confeature
