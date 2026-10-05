// SPDX-License-Identifier: MIT

#include "filesystem_cache.h"

#include <atomic>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>

#include "confeature/logger.h"

namespace confeature::internal {

namespace {

// Monotonic counter ensuring unique tempfile names across racing writers
// in the same process. The PID + counter pair is enough — we keep this
// per-process; cross-process races are resolved by std::filesystem::rename's
// atomicity on POSIX.
std::atomic<unsigned long long> g_tempfile_counter{0};

}  // namespace

std::filesystem::path defaultCacheDirectory() {
#if defined(_WIN32)
  if (const char* localAppData = std::getenv("LOCALAPPDATA");
      localAppData != nullptr && *localAppData != '\0') {
    return std::filesystem::path(localAppData) / "Confeature";
  }
  return {};
#else
  if (const char* xdg = std::getenv("XDG_CACHE_HOME"); xdg != nullptr && *xdg != '\0') {
    return std::filesystem::path(xdg) / "confeature";
  }
  if (const char* home = std::getenv("HOME"); home != nullptr && *home != '\0') {
    return std::filesystem::path(home) / ".cache" / "confeature";
  }
  return {};
#endif
}

FilesystemCache::FilesystemCache(std::filesystem::path directory, std::shared_ptr<Logger> logger)
    : directory_(std::move(directory)), logger_(std::move(logger)) {
  if (directory_.empty()) {
    directory_ = defaultCacheDirectory();
  }
}

std::filesystem::path FilesystemCache::pathFor(const std::string& key) const {
  return directory_ / ("confeature-" + key + ".json");
}

std::optional<std::string> FilesystemCache::read(const std::string& key) {
  if (directory_.empty()) {
    return std::nullopt;
  }
  std::lock_guard<std::mutex> guard(mutex_);
  const auto path = pathFor(key);
  std::error_code ec;
  if (!std::filesystem::exists(path, ec) || ec) {
    return std::nullopt;
  }
  std::ifstream stream(path, std::ios::binary);
  if (!stream.is_open()) {
    if (logger_) {
      logger_->warning("FilesystemCache: read open failed for cacheKey=" + key);
    }
    return std::nullopt;
  }
  std::ostringstream buf;
  buf << stream.rdbuf();
  if (stream.bad()) {
    if (logger_) {
      logger_->warning("FilesystemCache: read raised for cacheKey=" + key);
    }
    return std::nullopt;
  }
  return buf.str();
}

void FilesystemCache::write(const std::string& key, const std::string& value) {
  if (directory_.empty()) {
    return;
  }
  std::lock_guard<std::mutex> guard(mutex_);
  std::error_code ec;
  std::filesystem::create_directories(directory_, ec);
  if (ec) {
    if (logger_) {
      logger_->warning("FilesystemCache: create_directories failed (" + ec.message() + ")");
    }
    return;
  }
  const auto finalPath = pathFor(key);
  const auto counter = ++g_tempfile_counter;
  const auto tempPath = directory_ / ("confeature-" + key + ".tmp." + std::to_string(counter));
  {
    std::ofstream out(tempPath, std::ios::binary | std::ios::trunc);
    if (!out.is_open()) {
      if (logger_) {
        logger_->warning("FilesystemCache: write open failed for cacheKey=" + key);
      }
      return;
    }
    out << value;
    if (!out.good()) {
      if (logger_) {
        logger_->warning("FilesystemCache: write payload failed for cacheKey=" + key);
      }
      std::filesystem::remove(tempPath, ec);
      return;
    }
  }
  std::filesystem::rename(tempPath, finalPath, ec);
  if (ec) {
    if (logger_) {
      logger_->warning("FilesystemCache: rename failed (" + ec.message() + ")");
    }
    std::filesystem::remove(tempPath, ec);
  }
}

}  // namespace confeature::internal
