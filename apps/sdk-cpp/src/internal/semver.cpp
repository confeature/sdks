// SPDX-License-Identifier: MIT

#include "internal/semver.h"

#include <cctype>
#include <cstdint>
#include <optional>
#include <regex>
#include <string>
#include <vector>

namespace confeature::internal {

namespace {

constexpr std::size_t kMaxLength = 256;
// JS Number.MAX_SAFE_INTEGER — the upstream ceiling for core + numeric ids.
constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ULL;

// FULL grammar, mirroring semver.ts: optional `v`, MAJOR.MINOR.PATCH each
// `0|[1-9]\d*`, optional `-prerelease`, optional `+build`. Capture groups:
//   1=major 2=minor 3=patch 4=prerelease 5=build.
const std::regex& fullRe() {
  static const std::string num = "0|[1-9]\\d*";
  static const std::string nonNum = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
  static const std::string mainVer =
      "(" + num + ")\\.(" + num + ")\\.(" + num + ")";
  static const std::string preId = "(?:" + num + "|" + nonNum + ")";
  static const std::string pre = "(?:-(" + preId + "(?:\\." + preId + ")*))";
  static const std::string buildId = "[0-9A-Za-z-]+";
  static const std::string build = "(?:\\+(" + buildId + "(?:\\." + buildId + ")*))";
  static const std::regex re("^v?" + mainVer + pre + "?" + build + "?$");
  return re;
}

std::string trim(const std::string& s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && (std::isspace(static_cast<unsigned char>(s[b])) != 0)) {
    ++b;
  }
  while (e > b && (std::isspace(static_cast<unsigned char>(s[e - 1])) != 0)) {
    --e;
  }
  return s.substr(b, e - b);
}

bool isAllDigits(const std::string& s) {
  if (s.empty()) {
    return false;
  }
  for (const char c : s) {
    if (std::isdigit(static_cast<unsigned char>(c)) == 0) {
      return false;
    }
  }
  return true;
}

// Parse a `0|[1-9]\d*` core component to a uint64, rejecting > MAX_SAFE_INTEGER.
std::optional<std::uint64_t> parseCore(const std::string& s) {
  // The grammar already guarantees an all-digit string; guard overflow.
  if (s.size() > 16) {
    // Could exceed 2^63; fall through to a safe-integer compare below.
    try {
      const std::uint64_t v = std::stoull(s);
      return v <= kMaxSafeInteger ? std::optional<std::uint64_t>(v) : std::nullopt;
    } catch (...) {
      return std::nullopt;
    }
  }
  try {
    const std::uint64_t v = std::stoull(s);
    return v <= kMaxSafeInteger ? std::optional<std::uint64_t>(v) : std::nullopt;
  } catch (...) {
    return std::nullopt;
  }
}

}  // namespace

std::optional<SemVer> SemVer::parse(const std::string& version) {
  const std::string trimmed = trim(version);
  if (trimmed.size() > kMaxLength) {
    return std::nullopt;
  }
  std::smatch m;
  if (!std::regex_match(trimmed, m, fullRe())) {
    return std::nullopt;
  }

  const auto major = parseCore(m[1].str());
  const auto minor = parseCore(m[2].str());
  const auto patch = parseCore(m[3].str());
  if (!major || !minor || !patch) {
    return std::nullopt;
  }

  SemVer out;
  out.major_ = *major;
  out.minor_ = *minor;
  out.patch_ = *patch;

  if (m[4].matched) {
    const std::string& raw = m[4].str();
    std::size_t start = 0;
    while (start <= raw.size()) {
      std::size_t dot = raw.find('.', start);
      const std::string id =
          raw.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
      Identifier ident;
      if (isAllDigits(id)) {
        // Numberify numeric pre-release ids (matching common-js), but only
        // when in safe-integer range; otherwise keep as string.
        try {
          const std::uint64_t num = std::stoull(id);
          if (num < kMaxSafeInteger) {
            ident.numeric = true;
            ident.num = num;
          } else {
            ident.str = id;
          }
        } catch (...) {
          ident.str = id;
        }
      } else {
        ident.str = id;
      }
      out.prerelease_.push_back(std::move(ident));
      if (dot == std::string::npos) {
        break;
      }
      start = dot + 1;
    }
  }

  std::string canonical = std::to_string(out.major_) + "." + std::to_string(out.minor_) + "." +
                          std::to_string(out.patch_);
  if (!out.prerelease_.empty()) {
    canonical += "-";
    for (std::size_t i = 0; i < out.prerelease_.size(); ++i) {
      if (i > 0) {
        canonical += ".";
      }
      const auto& id = out.prerelease_[i];
      canonical += id.numeric ? std::to_string(id.num) : id.str;
    }
  }
  out.canonical_ = std::move(canonical);
  return out;
}

namespace {

// compareIdentifiers (semver.ts): both numeric → numeric compare; a numeric id
// is lower-precedence than an alphanumeric one; otherwise ASCII-lexical.
int compareIdentifiers(const SemVer* /*unused*/, bool aNumeric, std::uint64_t aNum,
                       const std::string& aStr, bool bNumeric, std::uint64_t bNum,
                       const std::string& bStr) {
  if (aNumeric && bNumeric) {
    if (aNum == bNum) {
      return 0;
    }
    return aNum < bNum ? -1 : 1;
  }
  if (aNumeric && !bNumeric) {
    return -1;
  }
  if (bNumeric && !aNumeric) {
    return 1;
  }
  if (aStr == bStr) {
    return 0;
  }
  return aStr < bStr ? -1 : 1;
}

}  // namespace

int SemVer::compareMain(const SemVer& other) const {
  if (major_ != other.major_) {
    return major_ < other.major_ ? -1 : 1;
  }
  if (minor_ != other.minor_) {
    return minor_ < other.minor_ ? -1 : 1;
  }
  if (patch_ != other.patch_) {
    return patch_ < other.patch_ ? -1 : 1;
  }
  return 0;
}

int SemVer::comparePre(const SemVer& other) const {
  // A version WITHOUT a pre-release is higher-precedence than one WITH.
  if (!prerelease_.empty() && other.prerelease_.empty()) {
    return -1;
  }
  if (prerelease_.empty() && !other.prerelease_.empty()) {
    return 1;
  }
  if (prerelease_.empty() && other.prerelease_.empty()) {
    return 0;
  }

  for (std::size_t i = 0;; ++i) {
    const bool aHas = i < prerelease_.size();
    const bool bHas = i < other.prerelease_.size();
    if (!aHas && !bHas) {
      return 0;
    }
    if (!bHas) {
      return 1;
    }
    if (!aHas) {
      return -1;
    }
    const auto& a = prerelease_[i];
    const auto& b = other.prerelease_[i];
    if (a.numeric == b.numeric && a.num == b.num && a.str == b.str) {
      continue;
    }
    return compareIdentifiers(this, a.numeric, a.num, a.str, b.numeric, b.num, b.str);
  }
}

int SemVer::compare(const SemVer& other) const {
  if (canonical_ == other.canonical_) {
    return 0;
  }
  const int main = compareMain(other);
  if (main != 0) {
    return main;
  }
  return comparePre(other);
}

}  // namespace confeature::internal
