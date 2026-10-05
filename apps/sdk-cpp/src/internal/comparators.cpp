// SPDX-License-Identifier: MIT

#include "internal/comparators.h"

#include <nlohmann/json.hpp>

#include <cctype>
#include <cmath>
#include <cstddef>
#include <optional>
#include <regex>
#include <string>
#include <vector>

#include "internal/hashing.h"
#include "internal/semver.h"

namespace confeature::internal {

namespace {

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

std::string invalidAttr(const std::string& attr, const std::string& reason) {
  return "cannot evaluate, the User." + attr + " attribute is invalid (" + reason + ")";
}

}  // namespace

// ── Text (cleartext) ───────────────────────────────────────────────────────

bool textEquals(const std::string& text, const std::string& comparisonValue, bool negate) {
  return (text == comparisonValue) != negate;
}

bool textIsOneOf(const std::string& text, const std::vector<std::string>& values, bool negate) {
  bool found = false;
  for (const auto& v : values) {
    if (v == text) {
      found = true;
      break;
    }
  }
  return found != negate;
}

bool textContainsAnyOf(const std::string& text, const std::vector<std::string>& values,
                       bool negate) {
  for (const auto& v : values) {
    if (text.find(v) != std::string::npos) {
      return !negate;
    }
  }
  return negate;
}

bool textSliceEqualsAnyOf(const std::string& text, const std::vector<std::string>& values,
                          bool startsWith, bool negate) {
  for (const auto& item : values) {
    if (text.size() < item.size()) {
      continue;
    }
    bool result = false;
    if (startsWith) {
      result = text.compare(0, item.size(), item) == 0;
    } else {
      result = text.compare(text.size() - item.size(), item.size(), item) == 0;
    }
    if (result) {
      return !negate;
    }
  }
  return negate;
}

// ── Sensitive text ─────────────────────────────────────────────────────────

bool sensitiveTextEquals(const std::string& text, const std::string& comparisonValue,
                         const std::string& configSalt, const std::string& contextSalt,
                         bool negate) {
  const std::string hash = hashComparisonValue(text, configSalt, contextSalt);
  return (hash == comparisonValue) != negate;
}

bool sensitiveTextIsOneOf(const std::string& text, const std::vector<std::string>& values,
                          const std::string& configSalt, const std::string& contextSalt,
                          bool negate) {
  const std::string hash = hashComparisonValue(text, configSalt, contextSalt);
  bool found = false;
  for (const auto& v : values) {
    if (v == hash) {
      found = true;
      break;
    }
  }
  return found != negate;
}

bool sensitiveTextSliceEqualsAnyOf(const std::string& text,
                                   const std::vector<std::string>& values,
                                   const std::string& configSalt, const std::string& contextSalt,
                                   bool startsWith, bool negate) {
  for (const auto& item : values) {
    const std::size_t underscore = item.find('_');
    if (underscore == std::string::npos) {
      continue;
    }
    std::size_t sliceLength = 0;
    try {
      sliceLength = static_cast<std::size_t>(std::stoull(item.substr(0, underscore)));
    } catch (...) {
      continue;
    }
    if (text.size() < sliceLength) {
      continue;
    }
    const std::string slice =
        startsWith ? text.substr(0, sliceLength) : text.substr(text.size() - sliceLength);
    const std::string hash = hashComparisonValueSlice(slice, configSalt, contextSalt);
    if (hash == item.substr(underscore + 1)) {
      return !negate;
    }
  }
  return negate;
}

// ── Semver ─────────────────────────────────────────────────────────────────

bool semVerIsOneOf(const std::string& version, const std::vector<std::string>& values,
                   bool negate) {
  const auto v1 = SemVer::parse(version);
  // The caller (attributeAsSemVer) already validated `version`; this is reached
  // only with a parseable user version.
  if (!v1) {
    return negate;
  }
  bool result = false;
  for (const auto& rawItem : values) {
    // Trim FIRST, then skip empty — matching ConfigCat, which trims before the
    // empty check, so a whitespace-only operand is skipped (not an error). A
    // non-empty but unparseable operand still errors the whole comparator.
    const auto item = trim(rawItem);
    if (item.empty()) {
      continue;
    }
    const auto v2 = SemVer::parse(item);
    if (!v2) {
      return false;
    }
    if (!result && v1->compare(*v2) == 0) {
      result = true;
    }
  }
  return result != negate;
}

bool semVerRelation(const std::string& version, int comparator,
                    const std::string& comparisonValue) {
  const auto v1 = SemVer::parse(version);
  if (!v1) {
    return false;
  }
  const auto v2 = SemVer::parse(trim(comparisonValue));
  if (!v2) {
    return false;
  }
  const int cmp = v1->compare(*v2);
  switch (comparator) {
    case kSemVerLess:
      return cmp < 0;
    case kSemVerLessOrEquals:
      return cmp <= 0;
    case kSemVerGreater:
      return cmp > 0;
    case kSemVerGreaterOrEquals:
      return cmp >= 0;
    default:
      return false;
  }
}

// ── Number ─────────────────────────────────────────────────────────────────

bool numberRelation(double num, int comparator, double comparisonValue) {
  switch (comparator) {
    case kNumberEquals:
      return num == comparisonValue;
    case kNumberNotEquals:
      return num != comparisonValue;
    case kNumberLess:
      return num < comparisonValue;
    case kNumberLessOrEquals:
      return num <= comparisonValue;
    case kNumberGreater:
      return num > comparisonValue;
    case kNumberGreaterOrEquals:
      return num >= comparisonValue;
    default:
      return false;
  }
}

// ── Datetime ───────────────────────────────────────────────────────────────

bool dateTimeRelation(double seconds, double comparisonValue, bool before) {
  return before ? seconds < comparisonValue : seconds > comparisonValue;
}

// ── Array ──────────────────────────────────────────────────────────────────

bool arrayContainsAnyOf(const std::vector<std::string>& array,
                        const std::vector<std::string>& values, bool negate) {
  for (const auto& a : array) {
    for (const auto& v : values) {
      if (a == v) {
        return !negate;
      }
    }
  }
  return negate;
}

bool sensitiveArrayContainsAnyOf(const std::vector<std::string>& array,
                                 const std::vector<std::string>& values,
                                 const std::string& configSalt, const std::string& contextSalt,
                                 bool negate) {
  for (const auto& a : array) {
    const std::string hash = hashComparisonValue(a, configSalt, contextSalt);
    for (const auto& v : values) {
      if (v == hash) {
        return !negate;
      }
    }
  }
  return negate;
}

// ── Attribute conversion ───────────────────────────────────────────────────

bool parseFloatStrict(const std::string& value, double* out) {
  // common-js parseFloatStrict: reject empty / all-whitespace and a leading
  // `0` followed by a non-digit/non-`.`/non-`e` (octal/hex); else strict
  // whole-string number parse.
  if (value.empty()) {
    return false;
  }
  static const std::regex reject(R"(^\s*$|^\s*0[^\d.eE])");
  if (std::regex_search(value, reject)) {
    return false;
  }
  // Whole-string numeric parse (JS `+value`). Allow surrounding whitespace,
  // optional sign, decimal + exponent. Reject any trailing garbage.
  static const std::regex numRe(R"(^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$)");
  if (!std::regex_match(value, numRe)) {
    return false;
  }
  try {
    *out = std::stod(value);
    return true;
  } catch (...) {
    return false;
  }
}

NumberConvert attributeAsNumber(const std::string& attr, const std::string& value) {
  std::string normalized = value;
  // common-js replaces only the FIRST comma with a dot.
  const std::size_t comma = normalized.find(',');
  if (comma != std::string::npos) {
    normalized[comma] = '.';
  }
  double num = 0;
  if (parseFloatStrict(normalized, &num)) {
    return NumberConvert{true, num, std::string()};
  }
  if (trim(value) == "NaN") {
    return NumberConvert{true, std::nan(""), std::string()};
  }
  return NumberConvert{false, 0, invalidAttr(attr, "'" + value + "' is not a valid decimal number")};
}

NumberConvert attributeAsUnixTimeSeconds(const std::string& attr, const std::string& value) {
  std::string normalized = value;
  const std::size_t comma = normalized.find(',');
  if (comma != std::string::npos) {
    normalized[comma] = '.';
  }
  double num = 0;
  if (parseFloatStrict(normalized, &num)) {
    return NumberConvert{true, num, std::string()};
  }
  if (trim(value) == "NaN") {
    return NumberConvert{true, std::nan(""), std::string()};
  }
  return NumberConvert{
      false, 0,
      invalidAttr(attr, "'" + value +
                            "' is not a valid Unix timestamp (number of seconds elapsed since "
                            "Unix epoch)")};
}

ArrayConvert attributeAsStringArray(const std::string& attr, const std::string& value) {
  // A string attribute is JSON-parsed; the result must be a string array
  // (common-js getUserAttributeValueAsStringArray).
  ArrayConvert out;
  try {
    const auto parsed = nlohmann::json::parse(value);
    if (parsed.is_array()) {
      bool allStrings = true;
      std::vector<std::string> arr;
      for (const auto& e : parsed) {
        if (!e.is_string()) {
          allStrings = false;
          break;
        }
        arr.push_back(e.get<std::string>());
      }
      if (allStrings) {
        out.ok = true;
        out.value = std::move(arr);
        return out;
      }
    }
  } catch (...) {
    // Non-JSON string falls through to the validation error (no-op catch,
    // matches common-js).
  }
  out.ok = false;
  out.error = invalidAttr(attr, "'" + value + "' is not a valid string array");
  return out;
}

}  // namespace confeature::internal
