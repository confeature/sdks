// SPDX-License-Identifier: MIT

#include "confeature/logger.h"

#include <iostream>
#include <memory>
#include <mutex>
#include <string_view>

namespace confeature {

namespace {

// Coarse mutex serialising writes to std::cout / std::cerr from
// background poll threads. The contention is irrelevant in practice —
// log volume is at most one line per fetch — and keeping the lock
// local to this TU prevents leaking the implementation detail.
std::mutex g_log_mutex;

const char* levelTag(LogLevel level) {
  switch (level) {
    case LogLevel::Debug:
      return "[DEBUG] ";
    case LogLevel::Info:
      return "[INFO] ";
    case LogLevel::Warning:
      return "[WARN] ";
    case LogLevel::Error:
      return "[ERROR] ";
    case LogLevel::Off:
      return "";
  }
  return "";
}

}  // namespace

StdoutLogger::StdoutLogger(LogLevel cutoff) : cutoff_(cutoff) {}

void StdoutLogger::log(LogLevel level, std::string_view message) {
  if (level == LogLevel::Off) {
    return;
  }
  if (static_cast<int>(level) < static_cast<int>(cutoff_)) {
    return;
  }
  std::lock_guard<std::mutex> guard(g_log_mutex);
  auto& sink = (level == LogLevel::Error) ? std::cerr : std::cout;
  sink << "confeature-cpp-sdk " << levelTag(level) << message << std::endl;
}

std::shared_ptr<Logger> makeDefaultLogger() {
  return std::make_shared<StdoutLogger>(LogLevel::Error);
}

}  // namespace confeature
