// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_TESTS_REQUIRE_VALUE_H_
#define CONFEATURE_TESTS_REQUIRE_VALUE_H_

#include <optional>
#include <stdexcept>
#include <string>

namespace confeature::tests {

/// Unwraps an optional the test needs engaged, or fails the test.
///
/// Catch2's `REQUIRE(opt.has_value())` aborts the test on failure, but by a
/// throw clang-tidy's `bugprone-unchecked-optional-access` cannot see, so a
/// `*opt` after it still reads as unchecked (#839). The check lives here
/// instead: an empty optional throws, which Catch2 reports as a failed test
/// naming `what`. Returns by value so a temporary optional cannot dangle.
template <typename T>
T requireValue(const std::optional<T>& opt, const char* what) {
  if (!opt.has_value()) {
    throw std::logic_error(std::string("expected a value: ") + what);
  }
  return *opt;
}

}  // namespace confeature::tests

#endif  // CONFEATURE_TESTS_REQUIRE_VALUE_H_
