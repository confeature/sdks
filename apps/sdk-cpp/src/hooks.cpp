// SPDX-License-Identifier: MIT
#include "confeature/hooks.h"

#include <exception>
#include <utility>

namespace confeature {

Hooks::Hooks(std::shared_ptr<Logger> logger) : logger_(std::move(logger)) {}

void Hooks::addOnClientReady(OnClientReady listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  on_client_ready_.push_back(std::move(listener));
}

void Hooks::addOnConfigChanged(OnConfigChanged listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  on_config_changed_.push_back(std::move(listener));
}

void Hooks::addOnFlagEvaluated(OnFlagEvaluated listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  on_flag_evaluated_.push_back(std::move(listener));
}

void Hooks::addOnError(OnError listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  on_error_.push_back(std::move(listener));
}

namespace {

template <typename Listeners, typename... Args>
void invoke_each(const Listeners& listeners, const char* hook_name, Logger* logger,
                 const Args&... args) {
  // Every listener sees the same arguments, so none may be forwarded: a
  // listener taking one by value would move it away from the next (#839).
  for (const auto& listener : listeners) {
    try {
      listener(args...);
    } catch (const std::exception& ex) {
      if (logger != nullptr) {
        logger->error(std::string("Hooks: ") + hook_name + " listener raised: " + ex.what());
      }
    } catch (...) {
      if (logger != nullptr) {
        logger->error(std::string("Hooks: ") + hook_name +
                      " listener raised an unknown exception.");
      }
    }
  }
}

}  // namespace

void Hooks::invokeOnClientReady() {
  std::vector<OnClientReady> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = on_client_ready_;
  }
  invoke_each(snapshot, "onClientReady", logger_.get());
}

void Hooks::invokeOnConfigChanged(const std::unordered_map<std::string, nlohmann::json>& settings) {
  std::vector<OnConfigChanged> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = on_config_changed_;
  }
  invoke_each(snapshot, "onConfigChanged", logger_.get(), settings);
}

void Hooks::invokeOnFlagEvaluated(const FlagEvaluatedPayload& payload) {
  std::vector<OnFlagEvaluated> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = on_flag_evaluated_;
  }
  invoke_each(snapshot, "onFlagEvaluated", logger_.get(), payload);
}

void Hooks::invokeOnError(const std::string& message) {
  std::vector<OnError> snapshot;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot = on_error_;
  }
  invoke_each(snapshot, "onError", logger_.get(), message);
}

}  // namespace confeature
