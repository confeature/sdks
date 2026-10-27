// SPDX-License-Identifier: MIT

#include "filesystem_cache.h"

#include <unistd.h>

#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>

using confeature::internal::FilesystemCache;

namespace {

std::filesystem::path uniqueTempDir() {
  auto base = std::filesystem::temp_directory_path();
  // Mix the pid + an intra-process counter + a random draw so parallel
  // ctest runs (and the random seeding) don't collide on the same
  // cache directory.
  static std::atomic<unsigned long long> counter{0};
  const auto suffix = std::to_string(static_cast<unsigned long long>(::getpid())) + "-" +
                      std::to_string(++counter) + "-" + std::to_string(std::random_device{}());
  const auto dir = base / ("confeature-cpp-test-" + suffix);
  std::filesystem::create_directories(dir);
  return dir;
}

}  // namespace

TEST_CASE("FilesystemCache round-trips a written value", "[filesystem_cache]") {
  const auto dir = uniqueTempDir();
  FilesystemCache cache(dir, nullptr);
  cache.write("cache-key-alpha", R"({"hello":"world"})");
  const auto read = cache.read("cache-key-alpha");
  REQUIRE(read.has_value());
  REQUIRE(read == R"({"hello":"world"})");
}

TEST_CASE("FilesystemCache returns nullopt for missing keys", "[filesystem_cache]") {
  const auto dir = uniqueTempDir();
  FilesystemCache cache(dir, nullptr);
  REQUIRE_FALSE(cache.read("absent-key").has_value());
}

TEST_CASE("FilesystemCache overwrites an existing entry atomically", "[filesystem_cache]") {
  const auto dir = uniqueTempDir();
  FilesystemCache cache(dir, nullptr);
  cache.write("k", "v1");
  cache.write("k", "v2");
  cache.write("k", "v3");
  const auto read = cache.read("k");
  REQUIRE(read.has_value());
  REQUIRE(read == "v3");
  // No leftover tempfiles in the cache directory.
  std::size_t tmpfiles = 0;
  for (const auto& entry : std::filesystem::directory_iterator(dir)) {
    if (entry.path().filename().string().find(".tmp.") != std::string::npos) {
      ++tmpfiles;
    }
  }
  REQUIRE(tmpfiles == 0);
}

TEST_CASE("FilesystemCache creates the cache directory on first write", "[filesystem_cache]") {
  const auto dir = uniqueTempDir();
  const auto nested = dir / "nested" / "deep";
  REQUIRE_FALSE(std::filesystem::exists(nested));
  FilesystemCache cache(nested, nullptr);
  cache.write("k", "v");
  REQUIRE(std::filesystem::exists(nested));
  REQUIRE(cache.read("k").value_or("") == "v");
}
