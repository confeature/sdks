// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_SEMVER_H_
#define CONFEATURE_INTERNAL_SEMVER_H_

// ConfigCat-semantics semver parse + compare (spec 130, ported field-for-field
// from `packages/sdk-shared/src/semver.ts`, itself a port of common-js
// `Semver.ts`). Deliberately NOT a third-party library — the npm `semver`
// package diverges on loose-parse + precedence edge cases and would fail the
// vendored `testmatrix_semantic*` rows.
//
// Key behaviours:
//   - Strict (non-loose) FULL grammar: v?MAJOR.MINOR.PATCH(-pre)?(+build)?,
//     each core component `0|[1-9]\d*`. Optional leading `v`.
//   - Parse on trim. Unparseable → nullopt, never a throw.
//   - Precedence: numeric major.minor.patch; a version WITHOUT a pre-release
//     ranks HIGHER than one WITH; pre-release ids compared field-by-field
//     (numeric < alphanumeric; more fields rank higher); build metadata
//     ignored.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace confeature::internal {

class SemVer {
 public:
  // Parse `version` under ConfigCat's strict grammar. Returns nullopt on any
  // failure (length, grammar, out-of-range core). Trims the input first.
  static std::optional<SemVer> parse(const std::string& version);

  // Compare against `other`: <0 lower-precedence, 0 equal, >0 higher.
  // Build metadata is ignored.
  int compare(const SemVer& other) const;

 private:
  SemVer() = default;

  // A pre-release identifier: either a numeric value (`numeric == true`) or an
  // alphanumeric string. Mirrors the TS number|string union.
  struct Identifier {
    bool numeric{false};
    std::uint64_t num{0};
    std::string str;
  };

  std::string canonical_;
  std::uint64_t major_{0};
  std::uint64_t minor_{0};
  std::uint64_t patch_{0};
  std::vector<Identifier> prerelease_;

  int compareMain(const SemVer& other) const;
  int comparePre(const SemVer& other) const;
};

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_SEMVER_H_
