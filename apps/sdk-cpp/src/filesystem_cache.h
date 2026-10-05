// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_FILESYSTEM_CACHE_H_
#define CONFEATURE_FILESYSTEM_CACHE_H_

// Default ConfigCache: writes JSON blobs under
//   - $HOME/.cache/confeature/confeature-{cacheKey}.json  (POSIX)
//   - %LOCALAPPDATA%/Confeature/confeature-{cacheKey}.json (Windows)
//
// Atomic write: write to tempfile + std::filesystem::rename to avoid
// half-written reads under a concurrent reader.

#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "confeature/config_cache.h"
#include "confeature/logger.h"

namespace confeature::internal {

class FilesystemCache : public ConfigCache {
 public:
  // `directory` may be empty → derive from $HOME / %LOCALAPPDATA% per
  // platform. `logger` is optional; nullptr disables logging.
  explicit FilesystemCache(std::filesystem::path directory,
                           std::shared_ptr<Logger> logger = nullptr);

  std::optional<std::string> read(const std::string& key) override;
  void write(const std::string& key, const std::string& value) override;

  const std::filesystem::path& directory() const { return directory_; }

 private:
  std::filesystem::path pathFor(const std::string& key) const;

  std::filesystem::path directory_;
  std::shared_ptr<Logger> logger_;
  std::mutex mutex_;
};

// Resolves the default cache directory for the running OS. Returns an
// empty path if no $HOME / %LOCALAPPDATA% is set (caller decides what
// to do — fall back to in-memory in that case).
std::filesystem::path defaultCacheDirectory();

}  // namespace confeature::internal

#endif  // CONFEATURE_FILESYSTEM_CACHE_H_
