// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_CONFIG_CACHE_H_
#define CONFEATURE_CONFIG_CACHE_H_

// Customer-extensible config cache interface mirroring ConfigCat-cpp's
// `ConfigCache`. The default implementation (filesystem cache, see
// src/filesystem_cache.cpp) writes to $HOME/.cache/confeature/ on
// POSIX and %LOCALAPPDATA%/Confeature/ on Windows.
//
// A customer may inject their own ConfigCache (Redis, SQLite, etc.) via
// ClientBuilder::cache(...). Implementations MUST be thread-safe: the
// poll thread and customer get_value calls race on read().

#include <optional>
#include <string>

namespace confeature {

class ConfigCache {
 public:
  virtual ~ConfigCache() = default;

  // Returns the previously-stored value for `key`, or std::nullopt if
  // none. Treat any I/O failure as "miss" (return nullopt + log).
  virtual std::optional<std::string> read(const std::string& key) = 0;

  // Writes `value` under `key`. Implementations should write
  // atomically (e.g. write-to-tempfile + rename) so a crashed process
  // never leaves a half-written cache entry.
  virtual void write(const std::string& key, const std::string& value) = 0;
};

}  // namespace confeature

#endif  // CONFEATURE_CONFIG_CACHE_H_
