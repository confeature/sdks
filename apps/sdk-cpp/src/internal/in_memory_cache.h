// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_IN_MEMORY_CACHE_H_
#define CONFEATURE_INTERNAL_IN_MEMORY_CACHE_H_

// In-memory fallback ConfigCache. Used when the customer disables
// filesystem caching (`cache_directory(":memory:")`), and as the
// underlying impl for unit tests that don't want to touch the disk.

#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#include "confeature/config_cache.h"

namespace confeature::internal {

class InMemoryCache : public ConfigCache {
 public:
  std::optional<std::string> read(const std::string& key) override {
    std::lock_guard<std::mutex> guard(mutex_);
    auto it = entries_.find(key);
    if (it == entries_.end()) {
      return std::nullopt;
    }
    return it->second;
  }

  void write(const std::string& key, const std::string& value) override {
    std::lock_guard<std::mutex> guard(mutex_);
    entries_.insert_or_assign(key, value);
  }

 private:
  std::mutex mutex_;
  std::unordered_map<std::string, std::string> entries_;
};

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_IN_MEMORY_CACHE_H_
