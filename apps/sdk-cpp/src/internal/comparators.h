// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_COMPARATORS_H_
#define CONFEATURE_INTERNAL_COMPARATORS_H_

// The 36 ConfigCat `UserComparator` operations + attribute conversion
// (spec 130, ported field-for-field from
// `packages/sdk-shared/src/comparators.ts`).
//
// Each comparator yields a three-valued ConditionOutcome: match / no-match /
// error (a validation or conversion failure — bad semver, non-numeric number,
// non-array array). An error short-circuits the AND group like no-match but is
// surfaced rather than silently swallowed (FR-010).
//
// Attribute values reach these functions already type-converted to text (the
// evaluator owns missing-attribute / no-user gates). The corpus user feeds
// custom attributes through the comparator conversion path; native numbers /
// arrays / epochs arrive pre-stringified via {@link userAttributeValueToString}
// at the caller, so the conversion entrypoints here accept the string form.

#include <cstdint>
#include <string>
#include <vector>

namespace confeature::internal {

// UserComparator discriminators (mirror config-json.ts UserComparator).
enum UserComparator : int {
  kTextIsOneOf = 0,
  kTextIsNotOneOf = 1,
  kTextContainsAnyOf = 2,
  kTextNotContainsAnyOf = 3,
  kSemVerIsOneOf = 4,
  kSemVerIsNotOneOf = 5,
  kSemVerLess = 6,
  kSemVerLessOrEquals = 7,
  kSemVerGreater = 8,
  kSemVerGreaterOrEquals = 9,
  kNumberEquals = 10,
  kNumberNotEquals = 11,
  kNumberLess = 12,
  kNumberLessOrEquals = 13,
  kNumberGreater = 14,
  kNumberGreaterOrEquals = 15,
  kSensitiveTextIsOneOf = 16,
  kSensitiveTextIsNotOneOf = 17,
  kDateTimeBefore = 18,
  kDateTimeAfter = 19,
  kSensitiveTextEquals = 20,
  kSensitiveTextNotEquals = 21,
  kSensitiveTextStartsWithAnyOf = 22,
  kSensitiveTextNotStartsWithAnyOf = 23,
  kSensitiveTextEndsWithAnyOf = 24,
  kSensitiveTextNotEndsWithAnyOf = 25,
  kSensitiveArrayContainsAnyOf = 26,
  kSensitiveArrayNotContainsAnyOf = 27,
  kTextEquals = 28,
  kTextNotEquals = 29,
  kTextStartsWithAnyOf = 30,
  kTextNotStartsWithAnyOf = 31,
  kTextEndsWithAnyOf = 32,
  kTextNotEndsWithAnyOf = 33,
  kArrayContainsAnyOf = 34,
  kArrayNotContainsAnyOf = 35,
};

// Three-valued comparator outcome. `error` is non-empty iff a validation /
// conversion failure occurred (in which case `matched` is meaningless).
struct CompareResult {
  bool matched{false};
  std::string error;  // empty unless a validation error

  static CompareResult of(bool m) { return CompareResult{m, std::string()}; }
  static CompareResult err(std::string e) { return CompareResult{false, std::move(e)}; }
};

// ── Text (cleartext, case-sensitive, no trim) ──────────────────────────────
bool textEquals(const std::string& text, const std::string& comparisonValue, bool negate);
bool textIsOneOf(const std::string& text, const std::vector<std::string>& values, bool negate);
bool textContainsAnyOf(const std::string& text, const std::vector<std::string>& values,
                       bool negate);
bool textSliceEqualsAnyOf(const std::string& text, const std::vector<std::string>& values,
                          bool startsWith, bool negate);

// ── Sensitive text (SHA-256 salted) ────────────────────────────────────────
bool sensitiveTextEquals(const std::string& text, const std::string& comparisonValue,
                         const std::string& configSalt, const std::string& contextSalt,
                         bool negate);
bool sensitiveTextIsOneOf(const std::string& text, const std::vector<std::string>& values,
                          const std::string& configSalt, const std::string& contextSalt,
                          bool negate);
bool sensitiveTextSliceEqualsAnyOf(const std::string& text,
                                   const std::vector<std::string>& values,
                                   const std::string& configSalt, const std::string& contextSalt,
                                   bool startsWith, bool negate);

// ── Semver ─────────────────────────────────────────────────────────────────
bool semVerIsOneOf(const std::string& version, const std::vector<std::string>& values,
                   bool negate);
bool semVerRelation(const std::string& version, int comparator, const std::string& comparisonValue);

// ── Number ─────────────────────────────────────────────────────────────────
bool numberRelation(double num, int comparator, double comparisonValue);

// ── Datetime (Unix seconds) ─────────────────────────────────────────────────
bool dateTimeRelation(double seconds, double comparisonValue, bool before);

// ── Array (cleartext + sensitive) ──────────────────────────────────────────
bool arrayContainsAnyOf(const std::vector<std::string>& array,
                        const std::vector<std::string>& values, bool negate);
bool sensitiveArrayContainsAnyOf(const std::vector<std::string>& array,
                                 const std::vector<std::string>& values,
                                 const std::string& configSalt, const std::string& contextSalt,
                                 bool negate);

// ── Attribute conversion (string → typed) with validation outcome ──────────
// Each returns ok=true + the typed value, or ok=false + a validation message.
struct NumberConvert {
  bool ok{false};
  double value{0};
  std::string error;
};
struct ArrayConvert {
  bool ok{false};
  std::vector<std::string> value;
  std::string error;
};

// Strict whole-string float parse (common-js parseFloatStrict), `,`→`.` applied
// by the caller. Rejects empty / leading-zero-octal / trailing garbage.
bool parseFloatStrict(const std::string& value, double* out);

NumberConvert attributeAsNumber(const std::string& attr, const std::string& value);
NumberConvert attributeAsUnixTimeSeconds(const std::string& attr, const std::string& value);
ArrayConvert attributeAsStringArray(const std::string& attr, const std::string& value);

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_COMPARATORS_H_
