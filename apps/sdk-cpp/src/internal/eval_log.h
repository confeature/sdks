// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_EVAL_LOG_H_
#define CONFEATURE_INTERNAL_EVAL_LOG_H_

// ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494,
// C++ slice of #501).
//
// C++ port of the spec-117 TS reference
// (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder` + `COMPARATOR_META`
// + `logger.ts` per-eventId strings) and the Go / Python / Rust / .NET ports
// (`apps/sdk-dotnet/.../EvalLog.cs`). Produces the byte-identical indented
// textual trace ConfigCat's SDKs emit during flag evaluation — its
// `evaluationlog/` corpus (replayed via
// `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is the
// byte-oracle.
//
// The trace is captured via the `EvalTraceSink` seam: every emitted line is one
// `(level, eventId, message)` tuple. The INFO 5000 multi-line trace plus the
// WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk reconstruct
// ConfigCat's byte-identical capture string. A `nullptr` sink (the hot path) is
// zero-cost — the evaluator never builds a trace. Header-only: the strings are
// ported VERBATIM from the canonical (Principle II), so a single translation
// unit owns them without a separate .cpp.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>

#include "internal/comparators.h"

namespace confeature::internal {

// ── eval-log constants (eval-log.ts parity) ────────────────────────────────

// ConfigCat's event id for the "config evaluated" INFO log line. Captured as
// `... [5000] ...`, matching the upstream oracle.
inline constexpr const char* kEvalLogEventId = "5000";

// ConfigCat indents each nested eval-log line by two spaces per level.
inline constexpr const char* kIndentUnit = "  ";

// Max IS-ONE-OF / list items rendered before truncation (configcat parity).
inline constexpr int kStringListMaxLength = 10;

// Placeholders ConfigCat substitutes for malformed condition parts.
inline constexpr const char* kInvalidValuePlaceholder = "<invalid value>";
inline constexpr const char* kInvalidNamePlaceholder = "<invalid name>";
inline constexpr const char* kInvalidOperatorPlaceholder = "<invalid operator>";

// Numeric log levels mirroring configcat-common's ordering (logger.ts
// `LogLevel`), so level filtering ("Info and above") works identically across
// SDKs. Intentionally distinct from the public `confeature::LogLevel` (the
// customer-facing enum) — this is the internal capture-side ordering.
enum class EvalTraceLevel : int {
  kOff = -1,
  kError = 1,
  kWarn = 2,
  kInfo = 3,
  kDebug = 4,
};

// Captures the evaluator's structured log calls. Each call is one
// `(level, eventId, message)` tuple; an INFO-enabled sink drives the eval-log
// trace plus the WARN/ERROR lines emitted during the walk. This is the seam the
// parity test taps to reconstruct ConfigCat's byte-identical capture string.
struct EvalTraceSink {
  EvalTraceSink() = default;
  EvalTraceSink(const EvalTraceSink&) = default;
  EvalTraceSink(EvalTraceSink&&) = default;
  EvalTraceSink& operator=(const EvalTraceSink&) = default;
  EvalTraceSink& operator=(EvalTraceSink&&) = default;
  virtual ~EvalTraceSink() = default;

  // The configured threshold (`kInfo` enables tracing).
  virtual EvalTraceLevel level() const = 0;

  // Records one emitted line.
  virtual void log(EvalTraceLevel level, const std::string& eventId,
                   const std::string& message) = 0;
};

// ── canonical number formatting (eval-log.ts settingValueToString parity) ───
//
// Renders a finite double exactly as ECMAScript `Number.toString`: the shortest
// round-tripping digit sequence reshaped into fixed-point / exponential form.
// The SDK's one home of this rule: the eval-log builder and the evaluator's
// user-attribute stringification both render through it. The corpus test
// keeps its own independent reference as the oracle.
inline std::string evalLogNumberToString(double value) {
  if (std::isnan(value)) {
    return "NaN";
  }
  if (std::isinf(value)) {
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (value == 0.0) {
    return "0";
  }

  const std::string sign = value < 0 ? "-" : "";
  const double av = std::fabs(value);
  const std::string shortest = nlohmann::json(av).dump();

  std::string mant = shortest;
  long long expVal = 0;
  const auto ePos = shortest.find_first_of("eE");
  if (ePos != std::string::npos) {
    mant = shortest.substr(0, ePos);
    expVal = std::stoll(shortest.substr(ePos + 1));
  }

  std::string intPart;
  std::string fracPart;
  const auto dotPos = mant.find('.');
  if (dotPos != std::string::npos) {
    intPart = mant.substr(0, dotPos);
    fracPart = mant.substr(dotPos + 1);
  } else {
    intPart = mant;
  }

  std::string raw = intPart + fracPart;
  long long point = static_cast<long long>(intPart.size()) + expVal;

  std::size_t lead = 0;
  while (lead + 1 < raw.size() && raw[lead] == '0') {
    ++lead;
    --point;
  }
  raw = raw.substr(lead);
  while (raw.size() > 1 && raw.back() == '0') {
    raw.pop_back();
  }
  if (raw == "0") {
    return "0";
  }

  const auto k = static_cast<long long>(raw.size());
  const long long n = point;

  if (n >= k && n <= 21) {
    return sign + raw + std::string(static_cast<std::size_t>(n - k), '0');
  }
  if (n > 0 && n <= 21) {
    return sign + raw.substr(0, static_cast<std::size_t>(n)) + "." +
           raw.substr(static_cast<std::size_t>(n));
  }
  if (n > -6 && n <= 0) {
    return sign + "0." + std::string(static_cast<std::size_t>(-n), '0') + raw;
  }
  const long long e = n - 1;
  const std::string expSign = e >= 0 ? "+" : "-";
  const std::string mantOut = (k == 1) ? raw : raw.substr(0, 1) + "." + raw.substr(1);
  return sign + mantOut + "e" + expSign + std::to_string(std::llabs(e));
}

// Render a Unix-seconds value as ConfigCat's eval-log datetime suffix —
// JS `new Date(value*1000).toISOString()`, e.g. `2023-04-01T00:00:00.000Z`
// (always millisecond precision, UTC). Returns false for non-finite values
// (NaN / ±Inf), matching the JS `isNaN(date)` guard.
inline bool evalLogUnixSecondsToIso(double seconds, std::string* iso) {
  if (std::isnan(seconds) || std::isinf(seconds)) {
    iso->clear();
    return false;
  }
  const long long ms = std::llround(seconds * 1000.0);
  // Decompose the epoch-millisecond count into a UTC civil datetime. The corpus
  // datetimes are all post-epoch; the algorithm (Howard Hinnant's days_from_civil
  // inverse) is exact for the full valid range.
  long long totalSeconds = ms / 1000;
  long long milli = ms % 1000;
  if (milli < 0) {
    milli += 1000;
    --totalSeconds;
  }
  long long days = totalSeconds / 86400;
  long long secOfDay = totalSeconds % 86400;
  if (secOfDay < 0) {
    secOfDay += 86400;
    --days;
  }
  const long long hour = secOfDay / 3600;
  const long long minute = (secOfDay % 3600) / 60;
  const long long second = secOfDay % 60;

  // civil_from_days (Hinnant): days since 1970-01-01 → (y, m, d).
  long long z = days + 719468;
  const long long era = (z >= 0 ? z : z - 146096) / 146097;
  const long long doe = z - era * 146097;
  const long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const long long y = yoe + era * 400;
  const long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const long long mp = (5 * doy + 2) / 153;
  const long long d = doy - (153 * mp + 2) / 5 + 1;
  const long long m = mp < 10 ? mp + 3 : mp - 9;
  const long long year = y + (m <= 2 ? 1 : 0);

  char buf[48];
  std::snprintf(buf, sizeof(buf), "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ", year, m, d,
                hour, minute, second, milli);
  *iso = buf;
  return true;
}

// ── comparator metadata (eval-log.ts COMPARATOR_META parity) ───────────────

enum class ComparatorKind { kList, kStr, kNumber, kDateTime };

struct ComparatorMeta {
  const char* token;
  ComparatorKind kind;
  bool sensitive;
};

// One table drives both the operator token and the condition value slot.
inline bool comparatorMeta(int comparator, ComparatorMeta* out) {
  static const std::unordered_map<int, ComparatorMeta> kMap = {
      {kTextIsOneOf, {"IS ONE OF", ComparatorKind::kList, false}},
      {kTextIsNotOneOf, {"IS NOT ONE OF", ComparatorKind::kList, false}},
      {kTextContainsAnyOf, {"CONTAINS ANY OF", ComparatorKind::kList, false}},
      {kTextNotContainsAnyOf, {"NOT CONTAINS ANY OF", ComparatorKind::kList, false}},
      {kSemVerIsOneOf, {"IS ONE OF", ComparatorKind::kList, false}},
      {kSemVerIsNotOneOf, {"IS NOT ONE OF", ComparatorKind::kList, false}},
      {kSemVerLess, {"<", ComparatorKind::kStr, false}},
      {kSemVerLessOrEquals, {"<=", ComparatorKind::kStr, false}},
      {kSemVerGreater, {">", ComparatorKind::kStr, false}},
      {kSemVerGreaterOrEquals, {">=", ComparatorKind::kStr, false}},
      {kNumberEquals, {"=", ComparatorKind::kNumber, false}},
      {kNumberNotEquals, {"!=", ComparatorKind::kNumber, false}},
      {kNumberLess, {"<", ComparatorKind::kNumber, false}},
      {kNumberLessOrEquals, {"<=", ComparatorKind::kNumber, false}},
      {kNumberGreater, {">", ComparatorKind::kNumber, false}},
      {kNumberGreaterOrEquals, {">=", ComparatorKind::kNumber, false}},
      {kSensitiveTextIsOneOf, {"IS ONE OF", ComparatorKind::kList, true}},
      {kSensitiveTextIsNotOneOf, {"IS NOT ONE OF", ComparatorKind::kList, true}},
      {kDateTimeBefore, {"BEFORE", ComparatorKind::kDateTime, false}},
      {kDateTimeAfter, {"AFTER", ComparatorKind::kDateTime, false}},
      {kSensitiveTextEquals, {"EQUALS", ComparatorKind::kStr, true}},
      {kSensitiveTextNotEquals, {"NOT EQUALS", ComparatorKind::kStr, true}},
      {kSensitiveTextStartsWithAnyOf, {"STARTS WITH ANY OF", ComparatorKind::kList, true}},
      {kSensitiveTextNotStartsWithAnyOf, {"NOT STARTS WITH ANY OF", ComparatorKind::kList, true}},
      {kSensitiveTextEndsWithAnyOf, {"ENDS WITH ANY OF", ComparatorKind::kList, true}},
      {kSensitiveTextNotEndsWithAnyOf, {"NOT ENDS WITH ANY OF", ComparatorKind::kList, true}},
      {kSensitiveArrayContainsAnyOf, {"ARRAY CONTAINS ANY OF", ComparatorKind::kList, true}},
      {kSensitiveArrayNotContainsAnyOf, {"ARRAY NOT CONTAINS ANY OF", ComparatorKind::kList, true}},
      {kTextEquals, {"EQUALS", ComparatorKind::kStr, false}},
      {kTextNotEquals, {"NOT EQUALS", ComparatorKind::kStr, false}},
      {kTextStartsWithAnyOf, {"STARTS WITH ANY OF", ComparatorKind::kList, false}},
      {kTextNotStartsWithAnyOf, {"NOT STARTS WITH ANY OF", ComparatorKind::kList, false}},
      {kTextEndsWithAnyOf, {"ENDS WITH ANY OF", ComparatorKind::kList, false}},
      {kTextNotEndsWithAnyOf, {"NOT ENDS WITH ANY OF", ComparatorKind::kList, false}},
      {kArrayContainsAnyOf, {"ARRAY CONTAINS ANY OF", ComparatorKind::kList, false}},
      {kArrayNotContainsAnyOf, {"ARRAY NOT CONTAINS ANY OF", ComparatorKind::kList, false}},
  };
  auto it = kMap.find(comparator);
  if (it == kMap.end()) {
    return false;
  }
  *out = it->second;
  return true;
}

inline std::string formatUserComparator(int comparator) {
  ComparatorMeta meta{};
  return comparatorMeta(comparator, &meta) ? std::string(meta.token) : kInvalidOperatorPlaceholder;
}

// ── EvaluateLogBuilder (eval-log.ts parity) ────────────────────────────────
//
// The indent / newLine / append primitives + the condition-rendering helpers.
// `eol` is `"\n"` — the byte the upstream oracle uses.
class EvaluateLogBuilder {
 public:
  EvaluateLogBuilder& append(const std::string& text) {
    chunks_ += text;
    return *this;
  }

  EvaluateLogBuilder& newLine(const std::string& text = "") {
    chunks_ += eol_;
    for (int i = 0; i < indentLevel_; ++i) {
      chunks_ += kIndentUnit;
    }
    chunks_ += text;
    return *this;
  }

  EvaluateLogBuilder& increaseIndent() {
    ++indentLevel_;
    return *this;
  }

  EvaluateLogBuilder& decreaseIndent() {
    if (indentLevel_ > 0) {
      --indentLevel_;
    }
    return *this;
  }

  // Render one user condition (`User.<attr> <COMP> <value>`). The compact
  // condition carries the value in `l` (list), `s` (string / sensitive-equals),
  // or `d` (number / datetime), selected by the comparator kind.
  EvaluateLogBuilder& appendUserCondition(const std::string& attr, int comparator,
                                          const std::vector<std::string>& list, bool hasList,
                                          const std::string& sv, bool hasSv, double dv,
                                          bool hasDv) {
    const std::string name = attr.empty() ? kInvalidNamePlaceholder : attr;
    ComparatorMeta meta{};
    if (!comparatorMeta(comparator, &meta)) {
      // Fallback: render whatever value slot is present.
      if (hasSv) {
        return appendUserConditionCore(name, comparator, sv);
      }
      if (hasDv) {
        return appendUserConditionCore(name, comparator, evalLogNumberToString(dv));
      }
      if (hasList && !list.empty()) {
        return appendUserConditionCore(name, comparator, list[0]);
      }
      return appendUserConditionCore(name, comparator, "");
    }
    switch (meta.kind) {
      case ComparatorKind::kList:
        return appendUserConditionStringList(name, comparator, list, hasList, meta.sensitive);
      case ComparatorKind::kStr:
        return appendUserConditionString(name, comparator, sv, hasSv, meta.sensitive);
      case ComparatorKind::kNumber:
        return appendUserConditionNumber(name, comparator, dv, hasDv, false);
      case ComparatorKind::kDateTime:
        return appendUserConditionNumber(name, comparator, dv, hasDv, true);
    }
    return *this;
  }

  // Append a single condition's boolean result (` => true` / ` => false, …`).
  EvaluateLogBuilder& appendConditionConsequence(bool result) {
    append(" => ").append(result ? "true" : "false");
    return result ? *this : append(", skipping the remaining AND conditions");
  }

  // Three-valued THEN consequence (kind: 0=MATCH, 1=no match, 2=error text).
  EvaluateLogBuilder& appendTargetingRuleConsequence(const std::string& thenValue, bool hasThen,
                                                     int matchKind, const std::string& errorText,
                                                     bool newLineBeforeThen) {
    increaseIndent();
    if (newLineBeforeThen) {
      newLine();
    } else {
      append(" ");
    }
    append("THEN");
    append(hasThen ? " '" + thenValue + "'" : " % options");
    append(" => ");
    if (matchKind == 0) {
      append("MATCH, applying rule");
    } else if (matchKind == 1) {
      append("no match");
    } else {
      append(errorText);
    }
    return decreaseIndent();
  }

  // Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`).
  EvaluateLogBuilder& appendPrerequisiteFlagCondition(const std::string& prereqKey, int comparator,
                                                      const std::string& comparisonValue) {
    // PrerequisiteFlagComparator: 0 = Equals, 1 = NotEquals.
    const std::string op = comparator == 1 ? "NOT EQUALS" : "EQUALS";
    return append("Flag '" + prereqKey + "' " + op + " '" + comparisonValue + "'");
  }

  // Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`).
  EvaluateLogBuilder& appendSegmentCondition(const std::string& segmentName, int comparator) {
    // SegmentComparator: 0 = IsIn, 1 = IsNotIn.
    const std::string op = comparator == 1 ? "IS NOT IN SEGMENT" : "IS IN SEGMENT";
    return append("User " + op + " '" + segmentName + "'");
  }

  // Append a bare boolean condition result (`true` / `false`).
  EvaluateLogBuilder& appendConditionResult(bool result) {
    return append(result ? "true" : "false");
  }

  std::string str() const { return chunks_; }

 private:
  EvaluateLogBuilder& appendUserConditionCore(const std::string& attr, int comparator,
                                              std::string value) {
    if (value.empty()) {
      value = kInvalidValuePlaceholder;
    }
    return append("User." + attr + " " + formatUserComparator(comparator) + " '" + value + "'");
  }

  EvaluateLogBuilder& appendUserConditionString(const std::string& attr, int comparator,
                                                const std::string& value, bool hasValue,
                                                bool isSensitive) {
    if (!hasValue) {
      return appendUserConditionCore(attr, comparator, "");
    }
    return appendUserConditionCore(attr, comparator, !isSensitive ? value : "<hashed value>");
  }

  EvaluateLogBuilder& appendUserConditionStringList(const std::string& attr, int comparator,
                                                    const std::vector<std::string>& values,
                                                    bool hasValues, bool isSensitive) {
    if (!hasValues) {
      return appendUserConditionCore(attr, comparator, "");
    }
    const std::string comparatorText = formatUserComparator(comparator);
    if (isSensitive) {
      const std::string word = values.size() == 1 ? "value" : "values";
      return append("User." + attr + " " + comparatorText + " [<" + std::to_string(values.size()) +
                    " hashed " + word + ">]");
    }
    return append("User." + attr + " " + comparatorText + " [" +
                  formatStringList(values, kStringListMaxLength) + "]");
  }

  EvaluateLogBuilder& appendUserConditionNumber(const std::string& attr, int comparator,
                                                double value, bool hasValue, bool isDateTime) {
    if (!hasValue) {
      return appendUserConditionCore(attr, comparator, "");
    }
    const std::string comparatorText = formatUserComparator(comparator);
    const std::string valueText = evalLogNumberToString(value);
    std::string iso;
    if (isDateTime && evalLogUnixSecondsToIso(value, &iso)) {
      return append("User." + attr + " " + comparatorText + " '" + valueText + "' (" + iso +
                    " UTC)");
    }
    return append("User." + attr + " " + comparatorText + " '" + valueText + "'");
  }

  // configcat-common's formatStringList (Utils.ts): `'a', 'b'` joined by `, `,
  // with an optional truncation appendix once maxLength is exceeded.
  static std::string formatStringList(const std::vector<std::string>& items, int maxLength) {
    if (items.empty()) {
      return "";
    }
    std::vector<std::string> shown = items;
    std::string appendix;
    if (maxLength > 0 && static_cast<int>(items.size()) > maxLength) {
      shown.assign(items.begin(), items.begin() + maxLength);
      const std::size_t count = items.size() - static_cast<std::size_t>(maxLength);
      const std::string word = count == 1 ? "value" : "values";
      appendix = ", ... <" + std::to_string(count) + " more " + word + ">";
    }
    std::string out = "'";
    for (std::size_t i = 0; i < shown.size(); ++i) {
      if (i > 0) {
        out += "', '";
      }
      out += shown[i];
    }
    out += "'";
    out += appendix;
    return out;
  }

  std::string chunks_;
  int indentLevel_ = 0;
  std::string eol_ = "\n";
};

// ── EvalTraceLog (logger.ts LoggerWrapper parity, strings VERBATIM) ─────────
//
// Internal logger adapter threaded through the evaluation context. A `nullptr`
// inner means tracing is off (zero cost); every helper is level-gated at the
// boundary. The strings are ported VERBATIM from logger.ts (Principle II).
class EvalTraceLog {
 public:
  explicit EvalTraceLog(EvalTraceSink* inner) : inner_(inner) {}

  bool enabled(EvalTraceLevel level) const {
    if (inner_ == nullptr) {
      return false;
    }
    const EvalTraceLevel threshold = inner_->level();
    if (threshold == EvalTraceLevel::kOff) {
      return false;
    }
    return static_cast<int>(level) <= static_cast<int>(threshold);
  }

  // WARN 3001 (verbatim from logger.ts userObjectIsMissing).
  void userObjectIsMissing(const std::string& key) {
    emit(EvalTraceLevel::kWarn, "3001",
         "cannot evaluate targeting rules and % options for setting '" + key +
             "' (User Object is missing); you should pass a User Object to the evaluation "
             "methods like `getValue()` in order to make targeting work properly; read more: "
             "https://configcat.com/docs/advanced/user-object/");
  }

  // WARN 3003 (verbatim from logger.ts userObjectAttributeIsMissing).
  void userObjectAttributeIsMissing(const std::string& key, const std::string& attr) {
    emit(EvalTraceLevel::kWarn, "3003",
         "cannot evaluate certain targeting rules of setting '" + key + "' (the User." + attr +
             " attribute is missing); you should set the User." + attr +
             " attribute in order to make targeting work properly; read more: "
             "https://configcat.com/docs/advanced/user-object/");
  }

  // WARN 3003, % options variant (verbatim from logger.ts).
  void userObjectAttributeIsMissingForPercentage(const std::string& key, const std::string& attr) {
    emit(EvalTraceLevel::kWarn, "3003",
         "cannot evaluate % options for setting '" + key + "' (the User." + attr +
             " attribute is missing); you should set the User." + attr +
             " attribute in order to make targeting work properly; read more: "
             "https://configcat.com/docs/advanced/user-object/");
  }

  // WARN 3004 (verbatim from logger.ts userObjectAttributeIsInvalid).
  void userObjectAttributeIsInvalid(const std::string& key, const std::string& attr,
                                    const std::string& reason) {
    emit(EvalTraceLevel::kWarn, "3004",
         "cannot evaluate certain targeting rules of setting '" + key + "' (the User." + attr +
             " attribute is invalid (" + reason + ")); please check the User." + attr +
             " attribute and make sure that its value corresponds to the comparison operator");
  }

  // WARN 3004, malformed config operand (#509). NO "please check…" suffix
  // (verbatim from logger.ts comparisonValueIsInvalid). `innerMessage` is the
  // full `comparison value '<v>' is invalid (<reason>)` text.
  void comparisonValueIsInvalid(const std::string& key, const std::string& innerMessage) {
    emit(EvalTraceLevel::kWarn, "3004",
         "cannot evaluate certain targeting rules of setting '" + key + "' (" + innerMessage + ")");
  }

  // ERROR 1002 (verbatim from logger.ts circularDependency).
  void circularDependency(const std::string& key, const std::string& cycle) {
    emit(EvalTraceLevel::kError, "1002",
         "failed to evaluate setting '" + key +
             "' (circular dependency detected between the following depending flags: [" + cycle +
             "])");
  }

  // INFO line (the 5000 trace). Mirrors logger.ts LoggerWrapper.info.
  void info(const std::string& eventId, const std::string& message) {
    emit(EvalTraceLevel::kInfo, eventId, message);
  }

 private:
  void emit(EvalTraceLevel level, const std::string& eventId, const std::string& message) {
    if (!enabled(level)) {
      return;
    }
    inner_->log(level, eventId, message);
  }

  EvalTraceSink* inner_;
};

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_EVAL_LOG_H_
