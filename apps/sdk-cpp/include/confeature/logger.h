// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_LOGGER_H_
#define CONFEATURE_LOGGER_H_

// Abstract logging façade mirroring ConfigCat-cpp's `ILogger`. The
// default `StdoutLogger` writes to std::cout (errors to std::cerr) and
// honours a configurable `LogLevel` cutoff. Customers may inject their
// own subclass via `ClientBuilder::logger(...)`.
//
// SECURITY (FR-013): the raw SDK key NEVER appears in log payloads;
// every site that needs to reference a key routes through
// `confeature::internal::redactSdkKey` first.

#include <memory>
#include <string>
#include <string_view>

#include "confeature/log_level.h"

namespace confeature {

class Logger {
 public:
  virtual ~Logger() = default;

  virtual void log(LogLevel level, std::string_view message) = 0;

  void debug(std::string_view message) { log(LogLevel::Debug, message); }
  void info(std::string_view message) { log(LogLevel::Info, message); }
  void warning(std::string_view message) { log(LogLevel::Warning, message); }
  void error(std::string_view message) { log(LogLevel::Error, message); }
};

// Default logger: prints to stdout (or stderr for `Error`), filtered by
// the configured cutoff. Thread-safe under a coarse internal mutex.
class StdoutLogger : public Logger {
 public:
  explicit StdoutLogger(LogLevel cutoff = LogLevel::Error);

  void log(LogLevel level, std::string_view message) override;

 private:
  LogLevel cutoff_;
};

// Convenience factory: shared, mutable default logger at Error level.
std::shared_ptr<Logger> makeDefaultLogger();

}  // namespace confeature

#endif  // CONFEATURE_LOGGER_H_
