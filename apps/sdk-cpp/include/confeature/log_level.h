// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_LOG_LEVEL_H_
#define CONFEATURE_LOG_LEVEL_H_

// Log-level enum mirroring ConfigCat-cpp's `LogLevel`. Numeric ordering
// matches the upstream so a customer-supplied filter is byte-portable.

namespace confeature {

enum class LogLevel {
  Debug = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
  Off = 4,
};

}  // namespace confeature

#endif  // CONFEATURE_LOG_LEVEL_H_
