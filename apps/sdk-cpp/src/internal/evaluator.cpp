// SPDX-License-Identifier: MIT

#include "internal/evaluator.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

#include "confeature/user.h"
#include "internal/comparators.h"
#include "internal/eval_log.h"
#include "internal/hashing.h"
#include "internal/semver.h"

namespace confeature::internal {

namespace {

using nlohmann::json;

const char* const kMissingUserError = "cannot evaluate, User Object is missing";

std::string missingAttributeError(const std::string& attr) {
  return "cannot evaluate, the User." + attr + " attribute is missing";
}

std::string invalidSemVer(const std::string& attr, const std::string& value) {
  return "cannot evaluate, the User." + attr + " attribute is invalid ('" + value +
         "' is not a valid semantic version)";
}

// Thrown on a detected prerequisite cycle / malformed reference. Caught at the
// evaluate() boundary → fail-closed default + EVAL_ERROR (FR-007, SC-004).
struct CircularDependencyError : std::runtime_error {
  explicit CircularDependencyError(std::string cyclePath)
      : std::runtime_error("Circular dependency detected between the following depending flags: " +
                           cyclePath + "."),
        cycle(std::move(cyclePath)) {}
  // The bare cycle path (`a -> b -> a`) for the ERROR 1002 trace line.
  std::string cycle;
};

// Three-valued condition outcome: match / no-match / error.
struct Outcome {
  enum class Kind { kTrue, kFalse, kError } kind{Kind::kTrue};
  std::string error;

  static Outcome t() { return Outcome{Kind::kTrue, std::string()}; }
  static Outcome f() { return Outcome{Kind::kFalse, std::string()}; }
  static Outcome of(bool m) { return m ? t() : f(); }
  static Outcome e(std::string msg) { return Outcome{Kind::kError, std::move(msg)}; }
  bool isTrue() const { return kind == Kind::kTrue; }
};

// Per-evaluation context threaded through rule / condition / prerequisite
// resolution. `visitedFlags` is the shared cycle-detection stack.
struct EvalContext {
  const json* settings;    // config["f"] object
  const json* segments;    // config["s"] array (may be null)
  std::string configSalt;  // config["p"]["s"]
  const User* user;        // optional
  std::vector<std::string>* visitedFlags;
  std::string* evalError;         // first surfaced condition error
  bool* missingUserLogged;        // dedups the no-user surface
  EvalTraceLog* log;              // trace logger (WARN/ERROR sink)
  EvaluateLogBuilder* lb;         // trace builder (nullptr when tracing off)
  const std::string* currentKey;  // setting key currently under evaluation
};

// The resolved value envelope + matched-rule/option identity.
struct SettingResult {
  json value;  // the resolved `v` envelope ({b}/{s}/{i}/{d})
  std::string variationId;
  bool matchedRule{false};
  bool matchedOption{false};
};

// ── nlohmann helpers (every access type-guarded) ───────────────────────────

const json* findObject(const json& obj, const char* key) {
  if (!obj.is_object()) {
    return nullptr;
  }
  auto it = obj.find(key);
  return it != obj.end() ? &(*it) : nullptr;
}

std::string getString(const json& obj, const char* key, const std::string& fallback = "") {
  const json* v = findObject(obj, key);
  return (v != nullptr && v->is_string()) ? v->get<std::string>() : fallback;
}

std::vector<std::string> getStringList(const json& obj, const char* key) {
  std::vector<std::string> out;
  const json* v = findObject(obj, key);
  if (v != nullptr && v->is_array()) {
    for (const auto& e : *v) {
      if (e.is_string()) {
        out.push_back(e.get<std::string>());
      }
    }
  }
  return out;
}

// Selects the typed JS-primitive-equivalent from a `v` envelope by SettingType,
// returning the json value or null when absent / wrong-typed.
json selectSettingValue(const json* value, int type) {
  if (value == nullptr || !value->is_object()) {
    return json();
  }
  const char* slot = nullptr;
  switch (type) {
    case kSettingTypeBool:
      slot = "b";
      break;
    case kSettingTypeString:
      slot = "s";
      break;
    case kSettingTypeInt:
      slot = "i";
      break;
    case kSettingTypeDouble:
      slot = "d";
      break;
    default:
      return json();
  }
  auto it = value->find(slot);
  if (it == value->end()) {
    return json();
  }
  return *it;
}

// ── canonical user-attribute stringification (userAttributeValueToString) ────
//
// Ports `packages/sdk-shared/src/comparators.ts::userAttributeValueToString`;
// numbers render through eval_log.h's `evalLogNumberToString` (the ECMAScript
// `Number.toString` shape), the one home of that rule in the SDK. A
// string attribute is used verbatim; a non-string custom attribute (number /
// date_time_t / string array) is canonicalised here ConfigCat-exactly so the
// comparators (which are string-only by contract) see the same text the
// upstream SDK would produce.

// Stringify a typed `User::AttributeValue`: string verbatim; date_time_t → Unix
// **seconds** (ConfigCat `getTime()/1000`); string array → compact
// `JSON.stringify` (no spaces, slashes/unicode raw, control chars escaped);
// number → ECMAScript canonical string.
std::string userAttributeValueToString(const User::AttributeValue& value) {
  if (std::holds_alternative<std::string>(value)) {
    return std::get<std::string>(value);
  }
  if (std::holds_alternative<double>(value)) {
    return evalLogNumberToString(std::get<double>(value));
  }
  if (std::holds_alternative<User::date_time_t>(value)) {
    const auto tp = std::get<User::date_time_t>(value);
    const double ms =
        std::chrono::duration_cast<std::chrono::duration<double, std::milli>>(tp.time_since_epoch())
            .count();
    return evalLogNumberToString(ms / 1000.0);
  }
  // string array → JSON.stringify (compact, slashes + UTF-8 raw, ensure_ascii
  // off so unicode codepoints stay literal — matching JS).
  const auto& arr = std::get<std::vector<std::string>>(value);
  std::string out = "[";
  bool first = true;
  for (const auto& e : arr) {
    if (!first) {
      out += ",";
    }
    first = false;
    out += json(e).dump(-1, ' ', /*ensure_ascii=*/false);
  }
  out += "]";
  return out;
}

// Look up a user attribute by name. Returns true + the canonical string value
// when set, false when absent. Mirrors getUserAttribute over the public typed
// User: well-known attrs are always strings; custom attrs route through
// userAttributeValueToString.
bool getUserAttribute(const User& user, const std::string& name, std::string* out) {
  if (name == "Identifier") {
    *out = user.identifier();
    return true;
  }
  if (name == "Email") {
    if (user.email().empty()) {
      return false;
    }
    *out = user.email();
    return true;
  }
  if (name == "Country") {
    if (user.country().empty()) {
      return false;
    }
    *out = user.country();
    return true;
  }
  const auto& custom = user.customAttributes();
  auto it = custom.find(name);
  if (it == custom.end()) {
    return false;
  }
  *out = userAttributeValueToString(it->second);
  return true;
}

// Render a resolved SETTING value for the eval log (eval-log.ts
// settingValueToString): boolean → "true"/"false", string → verbatim, number →
// canonical decimal string. The value is a typed JSON primitive selected by
// selectSettingValue.
std::string settingValueToLogString(const json& value) {
  if (value.is_boolean()) {
    return value.get<bool>() ? "true" : "false";
  }
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_number()) {
    return evalLogNumberToString(value.get<double>());
  }
  return std::string();
}

// Render the user's attributes as the eval-log header shows them — a
// Confeature-canonical object {Identifier, Email?, Country?, …custom}
// JSON-serialized to the `for User '…'` token. configcat-js form: insertion
// order Identifier, Email, Country, then custom (sorted; corpus scenarios carry
// at most one custom key, so any total order is byte-identical to the oracle).
std::string userAttributesForLogJson(const User& user) {
  std::string out = "{";
  out += "\"Identifier\":" + json(user.identifier()).dump(-1, ' ', /*ensure_ascii=*/false);
  if (!user.email().empty()) {
    out += ",\"Email\":" + json(user.email()).dump(-1, ' ', /*ensure_ascii=*/false);
  }
  if (!user.country().empty()) {
    out += ",\"Country\":" + json(user.country()).dump(-1, ' ', /*ensure_ascii=*/false);
  }
  for (const auto& kv : user.customAttributes()) {
    out += "," + json(kv.first).dump(-1, ' ', false) + ":" +
           json(userAttributeValueToString(kv.second)).dump(-1, ' ', false);
  }
  out += "}";
  return out;
}

void surfaceMissingUser(EvalContext& ctx) {
  if (ctx.evalError->empty()) {
    *ctx.evalError = kMissingUserError;
  }
  // ConfigCat logs the no-user WARN (event 3001) once per context. A
  // prerequisite flag evaluates in its OWN context (fresh state), so a prereq
  // referenced by N rules logs it N times (common-js parity).
  if (!*ctx.missingUserLogged) {
    if (ctx.log != nullptr) {
      ctx.log->userObjectIsMissing(*ctx.currentKey);
    }
    *ctx.missingUserLogged = true;
  }
}

// ── condition / rule machinery (forward declarations) ──────────────────────

SettingResult evaluateSetting(EvalContext& ctx, const std::string& key, const json& setting);

Outcome evaluateConditions(EvalContext& ctx, const json& conditions, const std::string& contextSalt,
                           const std::string& settingKey, const json* rule, int settingType);

// ── user-condition dispatch (US2) ──────────────────────────────────────────

// Build the eval-log rendering of one user condition (delegates to the builder,
// reading the same compact value slots the comparator dispatch reads).
void appendUserConditionTrace(EvalContext& ctx, const json& condition) {
  if (ctx.lb == nullptr) {
    return;
  }
  const std::string attrName = getString(condition, "a");
  const json* cmpJson = findObject(condition, "c");
  const int cmp = (cmpJson != nullptr && cmpJson->is_number_integer()) ? cmpJson->get<int>() : -1;
  const std::vector<std::string> list = getStringList(condition, "l");
  const bool hasList = findObject(condition, "l") != nullptr;
  const json* svJson = findObject(condition, "s");
  const bool hasSv = svJson != nullptr && svJson->is_string();
  const std::string sv = hasSv ? svJson->get<std::string>() : std::string();
  const json* dvJson = findObject(condition, "d");
  const bool hasDv = dvJson != nullptr && dvJson->is_number();
  const double dv = hasDv ? dvJson->get<double>() : 0.0;
  ctx.lb->appendUserCondition(attrName, cmp, list, hasList, sv, hasSv, dv, hasDv);
}

// #509: validate the CONFIG comparison value for the semver-relation / number /
// datetime comparators BEFORE the user attribute. A malformed operand surfaces
// the distinct `comparison value '<v>' is invalid (<reason>)` error (no
// "please check the User.<attr>…" suffix) and wins even when the attribute is
// also malformed. Returns true + the error when the operand is invalid.
bool comparisonValueInvalid(int cmp, const std::string& sv, const json* dvJson,
                            std::string* error) {
  switch (cmp) {
    case kSemVerLess:
    case kSemVerLessOrEquals:
    case kSemVerGreater:
    case kSemVerGreaterOrEquals: {
      std::string trimmed = sv;
      // common-js trims the operand before parsing.
      const auto b = trimmed.find_first_not_of(" \t\n\r\f\v");
      const auto e = trimmed.find_last_not_of(" \t\n\r\f\v");
      trimmed = (b == std::string::npos) ? std::string() : trimmed.substr(b, e - b + 1);
      if (!SemVer::parse(trimmed)) {
        *error = "comparison value '" + sv + "' is invalid ('" + sv +
                 "' is not a valid semantic version)";
        return true;
      }
      return false;
    }
    case kNumberEquals:
    case kNumberNotEquals:
    case kNumberLess:
    case kNumberLessOrEquals:
    case kNumberGreater:
    case kNumberGreaterOrEquals: {
      if (dvJson == nullptr || !dvJson->is_number() || std::isnan(dvJson->get<double>())) {
        const std::string v =
            dvJson != nullptr
                ? evalLogNumberToString(dvJson->is_number() ? dvJson->get<double>() : std::nan(""))
                : "undefined";
        *error = "comparison value '" + v + "' is invalid ('" + v +
                 "' is not a valid decimal "
                 "number)";
        return true;
      }
      return false;
    }
    case kDateTimeBefore:
    case kDateTimeAfter: {
      if (dvJson == nullptr || !dvJson->is_number() || std::isnan(dvJson->get<double>())) {
        const std::string v =
            dvJson != nullptr
                ? evalLogNumberToString(dvJson->is_number() ? dvJson->get<double>() : std::nan(""))
                : "undefined";
        *error = "comparison value '" + v + "' is invalid ('" + v +
                 "' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch))";
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// Surface a typed-attribute conversion failure (bad semver / number / datetime
// / array): record it for FR-016 + emit WARN 3004 (splitting attr + reason from
// the `cannot evaluate, the User.<attr> attribute is invalid (<reason>)` text).
Outcome invalidAttributeOutcome(EvalContext& ctx, const std::string& error) {
  if (ctx.evalError->empty()) {
    *ctx.evalError = error;
  }
  if (ctx.log != nullptr) {
    // Parse `cannot evaluate, the User.<attr> attribute is invalid (<reason>)`.
    static const std::string kPrefix = "cannot evaluate, the User.";
    static const std::string kMid = " attribute is invalid (";
    if (error.rfind(kPrefix, 0) == 0) {
      const std::size_t midPos = error.find(kMid);
      if (midPos != std::string::npos && !error.empty() && error.back() == ')') {
        const std::string attr = error.substr(kPrefix.size(), midPos - kPrefix.size());
        const std::size_t reasonStart = midPos + kMid.size();
        const std::string reason = error.substr(reasonStart, error.size() - reasonStart - 1);
        ctx.log->userObjectAttributeIsInvalid(*ctx.currentKey, attr, reason);
      }
    }
  }
  return Outcome::e(error);
}

Outcome evaluateUserCondition(EvalContext& ctx, const json& condition,
                              const std::string& contextSalt) {
  appendUserConditionTrace(ctx, condition);

  if (ctx.user == nullptr) {
    surfaceMissingUser(ctx);
    return Outcome::e(kMissingUserError);
  }
  const std::string attrName = getString(condition, "a");
  std::string attrValue;
  const bool has = getUserAttribute(*ctx.user, attrName, &attrValue);
  if (!has || attrValue.empty()) {
    const std::string msg = missingAttributeError(attrName);
    if (ctx.evalError->empty()) {
      *ctx.evalError = msg;
    }
    // ConfigCat logs a WARN (event 3003) per targeting rule whose attribute is
    // missing — not deduped per evaluation.
    if (ctx.log != nullptr) {
      ctx.log->userObjectAttributeIsMissing(*ctx.currentKey, attrName);
    }
    return Outcome::e(msg);
  }

  const json* cmpJson = findObject(condition, "c");
  if (cmpJson == nullptr || !cmpJson->is_number_integer()) {
    return Outcome::e("malformed condition");
  }
  const int cmp = cmpJson->get<int>();
  const std::vector<std::string> list = getStringList(condition, "l");
  const std::string sv = getString(condition, "s");
  double dv = 0;
  const json* dvJson = findObject(condition, "d");
  if (dvJson != nullptr && dvJson->is_number()) {
    dv = dvJson->get<double>();
  }
  const std::string& salt = ctx.configSalt;

  // #509: comparison-value validation BEFORE the user attribute.
  {
    std::string cvError;
    if (comparisonValueInvalid(cmp, sv, dvJson, &cvError)) {
      if (ctx.evalError->empty()) {
        *ctx.evalError = cvError;
      }
      if (ctx.log != nullptr) {
        ctx.log->comparisonValueIsInvalid(*ctx.currentKey, cvError);
      }
      return Outcome::e(cvError);
    }
  }

  bool matched = false;
  switch (cmp) {
    case kTextEquals:
    case kTextNotEquals:
      matched = textEquals(attrValue, sv, cmp == kTextNotEquals);
      break;
    case kSensitiveTextEquals:
    case kSensitiveTextNotEquals:
      matched =
          sensitiveTextEquals(attrValue, sv, salt, contextSalt, cmp == kSensitiveTextNotEquals);
      break;
    case kTextIsOneOf:
    case kTextIsNotOneOf:
      matched = textIsOneOf(attrValue, list, cmp == kTextIsNotOneOf);
      break;
    case kSensitiveTextIsOneOf:
    case kSensitiveTextIsNotOneOf:
      matched =
          sensitiveTextIsOneOf(attrValue, list, salt, contextSalt, cmp == kSensitiveTextIsNotOneOf);
      break;
    case kTextStartsWithAnyOf:
    case kTextNotStartsWithAnyOf:
      matched = textSliceEqualsAnyOf(attrValue, list, true, cmp == kTextNotStartsWithAnyOf);
      break;
    case kSensitiveTextStartsWithAnyOf:
    case kSensitiveTextNotStartsWithAnyOf:
      matched = sensitiveTextSliceEqualsAnyOf(attrValue, list, salt, contextSalt, true,
                                              cmp == kSensitiveTextNotStartsWithAnyOf);
      break;
    case kTextEndsWithAnyOf:
    case kTextNotEndsWithAnyOf:
      matched = textSliceEqualsAnyOf(attrValue, list, false, cmp == kTextNotEndsWithAnyOf);
      break;
    case kSensitiveTextEndsWithAnyOf:
    case kSensitiveTextNotEndsWithAnyOf:
      matched = sensitiveTextSliceEqualsAnyOf(attrValue, list, salt, contextSalt, false,
                                              cmp == kSensitiveTextNotEndsWithAnyOf);
      break;
    case kTextContainsAnyOf:
    case kTextNotContainsAnyOf:
      matched = textContainsAnyOf(attrValue, list, cmp == kTextNotContainsAnyOf);
      break;
    case kSemVerIsOneOf:
    case kSemVerIsNotOneOf: {
      const auto v = SemVer::parse(attrValue);
      if (!v) {
        return invalidAttributeOutcome(ctx, invalidSemVer(attrName, attrValue));
      }
      matched = semVerIsOneOf(attrValue, list, cmp == kSemVerIsNotOneOf);
      break;
    }
    case kSemVerLess:
    case kSemVerLessOrEquals:
    case kSemVerGreater:
    case kSemVerGreaterOrEquals: {
      const auto v = SemVer::parse(attrValue);
      if (!v) {
        return invalidAttributeOutcome(ctx, invalidSemVer(attrName, attrValue));
      }
      matched = semVerRelation(attrValue, cmp, sv);
      break;
    }
    case kNumberEquals:
    case kNumberNotEquals:
    case kNumberLess:
    case kNumberLessOrEquals:
    case kNumberGreater:
    case kNumberGreaterOrEquals: {
      const auto r = attributeAsNumber(attrName, attrValue);
      if (!r.ok) {
        return invalidAttributeOutcome(ctx, r.error);
      }
      matched = numberRelation(r.value, cmp, dv);
      break;
    }
    case kDateTimeBefore:
    case kDateTimeAfter: {
      const auto r = attributeAsUnixTimeSeconds(attrName, attrValue);
      if (!r.ok) {
        return invalidAttributeOutcome(ctx, r.error);
      }
      matched = dateTimeRelation(r.value, dv, cmp == kDateTimeBefore);
      break;
    }
    case kArrayContainsAnyOf:
    case kArrayNotContainsAnyOf: {
      const auto r = attributeAsStringArray(attrName, attrValue);
      if (!r.ok) {
        return invalidAttributeOutcome(ctx, r.error);
      }
      matched = arrayContainsAnyOf(r.value, list, cmp == kArrayNotContainsAnyOf);
      break;
    }
    case kSensitiveArrayContainsAnyOf:
    case kSensitiveArrayNotContainsAnyOf: {
      const auto r = attributeAsStringArray(attrName, attrValue);
      if (!r.ok) {
        return invalidAttributeOutcome(ctx, r.error);
      }
      matched = sensitiveArrayContainsAnyOf(r.value, list, salt, contextSalt,
                                            cmp == kSensitiveArrayNotContainsAnyOf);
      break;
    }
    default:
      return Outcome::e("unknown comparator " + std::to_string(cmp));
  }
  return matched ? Outcome::t() : Outcome::f();
}

// ── segment condition (US4) ────────────────────────────────────────────────

Outcome evaluateSegmentCondition(EvalContext& ctx, const json& condition) {
  EvaluateLogBuilder* lb = ctx.lb;
  const json* segIdxJson = findObject(condition, "s");
  const int segIndex =
      (segIdxJson != nullptr && segIdxJson->is_number_integer()) ? segIdxJson->get<int>() : -1;
  const json* cmpJson = findObject(condition, "c");
  const int segCmp = (cmpJson != nullptr && cmpJson->is_number_integer()) ? cmpJson->get<int>() : 0;
  const json* segmentForName =
      (ctx.segments != nullptr && ctx.segments->is_array() && segIndex >= 0 &&
       static_cast<std::size_t>(segIndex) < ctx.segments->size())
          ? &(*ctx.segments)[static_cast<std::size_t>(segIndex)]
          : nullptr;
  const std::string segNameForTrace =
      segmentForName != nullptr ? getString(*segmentForName, "n") : std::string();
  if (lb != nullptr) {
    lb->appendSegmentCondition(segNameForTrace, segCmp);
  }

  if (ctx.user == nullptr) {
    surfaceMissingUser(ctx);
    return Outcome::e(kMissingUserError);
  }
  if (segIdxJson == nullptr || !segIdxJson->is_number_integer()) {
    throw std::runtime_error("Segment reference is invalid.");
  }
  if (segmentForName == nullptr) {
    throw std::runtime_error("Segment reference is invalid.");
  }
  const json& segment = *segmentForName;
  const std::string segmentName = getString(segment, "n");
  if (segmentName.empty()) {
    throw std::runtime_error("Segment name is missing.");
  }

  if (lb != nullptr) {
    lb->newLine("(").increaseIndent().newLine("Evaluating segment '" + segmentName + "':");
  }

  // The segment's `r[]` is an AND-group of BARE user conditions; the context
  // salt is the segment NAME. Short-circuit on the first non-match / error.
  // Wrap each user condition as { u: ... } and drive via evaluateConditions so
  // the IF/AND trace renders identically to a rule's condition list.
  json wrapped = json::array();
  const json* rules = findObject(segment, "r");
  if (rules != nullptr && rules->is_array()) {
    for (const auto& uc : *rules) {
      json w = json::object();
      w["u"] = uc;
      wrapped.push_back(std::move(w));
    }
  }
  const Outcome inSegment = evaluateConditions(ctx, wrapped, segmentName, segmentName, nullptr, -1);

  // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
  Outcome result = inSegment;
  if (inSegment.kind != Outcome::Kind::kError && segCmp == 1) {
    result = inSegment.isTrue() ? Outcome::f() : Outcome::t();
  }

  if (lb != nullptr) {
    lb->newLine("Segment evaluation result: ");
    if (inSegment.kind != Outcome::Kind::kError) {
      lb->append(inSegment.isTrue() ? "User IS IN SEGMENT" : "User IS NOT IN SEGMENT");
    } else {
      lb->append(inSegment.error);
    }
    lb->append(".");
    lb->newLine("Condition (").appendSegmentCondition(segmentName, segCmp).append(")");
    if (result.kind != Outcome::Kind::kError) {
      lb->append(" evaluates to ").appendConditionResult(result.isTrue());
    } else {
      lb->append(" failed to evaluate");
    }
    lb->append(".").decreaseIndent().newLine(")");
  }

  return result;
}

// ── prerequisite condition (US4) ───────────────────────────────────────────

Outcome evaluatePrerequisiteCondition(EvalContext& ctx, const json& condition,
                                      const std::string& currentKey) {
  const std::string prereqKey = getString(condition, "f");
  if (prereqKey.empty()) {
    throw std::runtime_error("Prerequisite flag key is missing or invalid.");
  }
  const json* prereqSetting = findObject(*ctx.settings, prereqKey.c_str());
  if (prereqSetting == nullptr || !prereqSetting->is_object()) {
    throw std::runtime_error("Prerequisite flag is missing or invalid.");
  }
  const json* tJson = findObject(*prereqSetting, "t");
  if (tJson == nullptr || !tJson->is_number_integer()) {
    throw std::runtime_error("Prerequisite flag is missing or invalid.");
  }
  const int declaredType = tJson->get<int>();

  // The expected comparison value `v`, read through the prereq flag's type.
  const json* vJson = findObject(condition, "v");
  const json comparisonValue = selectSettingValue(vJson, declaredType);

  EvaluateLogBuilder* lb = ctx.lb;
  if (lb != nullptr) {
    const json* pcmpJson = findObject(condition, "c");
    const int pcmp =
        (pcmpJson != nullptr && pcmpJson->is_number_integer()) ? pcmpJson->get<int>() : 0;
    lb->appendPrerequisiteFlagCondition(prereqKey, pcmp, settingValueToLogString(comparisonValue));
  }

  // Cycle detection: push current key, detect a revisit BEFORE recursing.
  ctx.visitedFlags->push_back(currentKey);
  for (const auto& f : *ctx.visitedFlags) {
    if (f == prereqKey) {
      ctx.visitedFlags->push_back(prereqKey);
      std::string cycle;
      for (std::size_t i = 0; i < ctx.visitedFlags->size(); ++i) {
        if (i > 0) {
          cycle += " -> ";
        }
        cycle += (*ctx.visitedFlags)[i];
      }
      throw CircularDependencyError(cycle);
    }
  }

  // The trace re-enters the full evaluation nested in `( … )` (go-sdk oracle
  // structure): the child appends its own "Evaluating '<key>' …" header +
  // "Returning …". The prerequisite evaluates in its OWN missing-user dedup
  // state (fresh `false`) so a prereq referenced by N rules logs WARN 3001 N
  // times, not once (common-js parity).
  if (lb != nullptr) {
    lb->newLine("(").increaseIndent().newLine("Evaluating '" + prereqKey + "'");
    if (ctx.user != nullptr) {
      lb->append(" for User '" + userAttributesForLogJson(*ctx.user) + "'");
    }
  }

  bool childMissingUserLogged = false;
  bool* savedMissingUserLogged = ctx.missingUserLogged;
  ctx.missingUserLogged = &childMissingUserLogged;
  const SettingResult resolved = evaluateSetting(ctx, prereqKey, *prereqSetting);
  ctx.missingUserLogged = savedMissingUserLogged;
  // Restore the stack for sibling prerequisites.
  ctx.visitedFlags->pop_back();

  const json resolvedValue = selectSettingValue(&resolved.value, declaredType);

  if (lb != nullptr) {
    lb->newLine("Returning '" + settingValueToLogString(resolvedValue) + "'.")
        .decreaseIndent()
        .newLine(")");
  }

  const json* cmpJson = findObject(condition, "c");
  if (cmpJson == nullptr || !cmpJson->is_number_integer()) {
    throw std::runtime_error("Comparison operator is missing or invalid.");
  }
  const int prereqCmp = cmpJson->get<int>();
  // PrerequisiteFlagComparator: 0 = Equals, 1 = NotEquals.
  if (prereqCmp == 0) {
    return resolvedValue == comparisonValue ? Outcome::t() : Outcome::f();
  }
  if (prereqCmp == 1) {
    return resolvedValue != comparisonValue ? Outcome::t() : Outcome::f();
  }
  throw std::runtime_error("Comparison operator is missing or invalid.");
}

// ── condition group (AND) ──────────────────────────────────────────────────

Outcome evaluateConditions(EvalContext& ctx, const json& conditions, const std::string& contextSalt,
                           const std::string& settingKey, const json* rule, int settingType) {
  EvaluateLogBuilder* lb = ctx.lb;
  Outcome result = Outcome::t();
  const bool isArray = conditions.is_array();
  std::size_t count = isArray ? conditions.size() : 0;

  if (lb != nullptr) {
    lb->newLine("- ");
  }
  if (isArray) {
    std::size_t i = 0;
    for (const auto& condition : conditions) {
      if (lb != nullptr) {
        if (i == 0) {
          lb->append("IF ").increaseIndent();
        } else {
          lb->increaseIndent().newLine("AND ");
        }
      }
      const json* u = findObject(condition, "u");
      const json* p = findObject(condition, "p");
      const json* s = findObject(condition, "s");
      if (u != nullptr) {
        result = evaluateUserCondition(ctx, *u, contextSalt);
      } else if (p != nullptr) {
        result = evaluatePrerequisiteCondition(ctx, *p, settingKey);
      } else if (s != nullptr) {
        result = evaluateSegmentCondition(ctx, *s);
      } else {
        result = Outcome::e("empty condition");
      }
      if (lb != nullptr) {
        // The go-sdk oracle always shows the per-condition consequence.
        lb->appendConditionConsequence(result.isTrue());
        lb->decreaseIndent();
      }
      if (!result.isTrue()) {
        break;
      }
      ++i;
    }
  }

  // When evaluating a targeting rule (not a bare segment), append its THEN
  // consequence. The go oracle always newlines THEN when the rule has
  // conditions.
  if (rule != nullptr && lb != nullptr) {
    const json* served = findObject(*rule, "s");
    std::string thenValue;
    bool hasThen = false;
    if (served != nullptr && served->is_object()) {
      const json* v = findObject(*served, "v");
      thenValue = settingValueToLogString(selectSettingValue(v, settingType));
      hasThen = true;
    }
    int matchKind = 0;
    std::string errorText;
    if (result.kind == Outcome::Kind::kTrue) {
      matchKind = 0;
    } else if (result.kind == Outcome::Kind::kFalse) {
      matchKind = 1;
    } else {
      matchKind = 2;
      errorText = result.error;
    }
    lb->appendTargetingRuleConsequence(thenValue, hasThen, matchKind, errorText, count > 0);
  }
  return result;
}

// ── percentage options (US3) ───────────────────────────────────────────────

// Returns true + fills `out` when an option decides the value; false to skip
// (no user / missing keying attribute). Throws on a malformed (<100% sum).
bool evaluatePercentageOptions(EvalContext& ctx, const json& options, const std::string& settingKey,
                               const json& settingObj, int settingType, bool matchedRule,
                               SettingResult* out) {
  EvaluateLogBuilder* lb = ctx.lb;
  if (ctx.user == nullptr) {
    surfaceMissingUser(ctx);
    if (lb != nullptr) {
      lb->newLine("Skipping % options because the User Object is missing.");
    }
    return false;
  }
  std::string attrName = getString(settingObj, "a");
  std::string attrValue;
  if (attrName.empty()) {
    attrName = "Identifier";
    attrValue = ctx.user->identifier();
  } else if (!getUserAttribute(*ctx.user, attrName, &attrValue)) {
    if (ctx.evalError->empty()) {
      *ctx.evalError = missingAttributeError(attrName);
    }
    if (ctx.log != nullptr) {
      ctx.log->userObjectAttributeIsMissingForPercentage(*ctx.currentKey, attrName);
    }
    if (lb != nullptr) {
      lb->newLine("Skipping % options because the User." + attrName + " attribute is missing.");
    }
    return false;
  }

  const std::uint64_t hashValue = percentageBucket(settingKey, attrValue);
  if (lb != nullptr) {
    lb->newLine("Evaluating % options based on the User." + attrName + " attribute:");
    lb->newLine("- Computing hash in the [0..99] range from User." + attrName + " => " +
                std::to_string(hashValue) +
                " (this value is sticky and consistent across all SDKs)");
  }
  std::uint64_t bucket = 0;
  if (options.is_array()) {
    int index = 0;
    for (const auto& option : options) {
      const json* pJson = findObject(option, "p");
      const std::uint64_t width =
          (pJson != nullptr && pJson->is_number()) ? pJson->get<std::uint64_t>() : 0;
      bucket += width;
      if (hashValue < bucket) {
        out->value = option.contains("v") ? option["v"] : json();
        out->variationId = getString(option, "i");
        out->matchedRule = matchedRule;
        out->matchedOption = true;
        if (lb != nullptr) {
          const json optValue =
              selectSettingValue(out->value.is_object() ? &out->value : nullptr, settingType);
          lb->newLine("- Hash value " + std::to_string(hashValue) + " selects % option " +
                      std::to_string(index + 1) + " (" + std::to_string(width) + "%), '" +
                      settingValueToLogString(optValue) + "'.");
        }
        return true;
      }
      ++index;
    }
  }
  throw std::runtime_error("Sum of percentage option percentages is less than 100.");
}

// ── targeting-rule walk (US1) ──────────────────────────────────────────────

bool evaluateTargetingRules(EvalContext& ctx, const json& rules, const std::string& settingKey,
                            const json& settingObj, int settingType, SettingResult* out) {
  EvaluateLogBuilder* lb = ctx.lb;
  if (!rules.is_array()) {
    return false;
  }
  if (lb != nullptr) {
    lb->newLine("Evaluating targeting rules and applying the first match if any:");
  }
  for (const auto& rule : rules) {
    const json* conditions = findObject(rule, "c");
    const json conds = conditions != nullptr ? *conditions : json::array();
    const Outcome outcome =
        evaluateConditions(ctx, conds, settingKey, settingKey, &rule, settingType);
    if (!outcome.isTrue()) {
      // A rule whose conditions ERRORED (missing user/attr/validation) is
      // ignored and evaluation continues — ConfigCat emits this trace line. A
      // rule that merely did NOT match (false) just continues, with no line.
      if (lb != nullptr && outcome.kind == Outcome::Kind::kError) {
        lb->increaseIndent()
            .newLine(
                "The current targeting rule is ignored and the evaluation continues with the "
                "next rule.")
            .decreaseIndent();
      }
      continue;
    }
    // A rule serves either a fixed value (`s`) or percentage options (`p`).
    const json* served = findObject(rule, "s");
    if (served != nullptr && served->is_object()) {
      out->value = served->contains("v") ? (*served)["v"] : json();
      out->variationId = getString(*served, "i");
      out->matchedRule = true;
      out->matchedOption = false;
      return true;
    }
    const json* options = findObject(rule, "p");
    if (lb != nullptr) {
      lb->increaseIndent();
    }
    if (options != nullptr &&
        evaluatePercentageOptions(ctx, *options, settingKey, settingObj, settingType, true, out)) {
      if (lb != nullptr) {
        lb->decreaseIndent();
      }
      return true;
    }
    // % options weren't resolvable (no user / missing attr) → continue.
    if (lb != nullptr) {
      lb->newLine(
            "The current targeting rule is ignored and the evaluation continues with the next "
            "rule.")
          .decreaseIndent();
    }
  }
  return false;
}

// ── setting resolution ─────────────────────────────────────────────────────

SettingResult evaluateSetting(EvalContext& ctx, const std::string& key, const json& setting) {
  SettingResult result;

  // The current key drives the per-setting WARN messages (3001/3003/3004). A
  // prerequisite re-evaluation sets it to the prereq key; restore on return.
  const std::string* savedKey = ctx.currentKey;
  ctx.currentKey = &key;

  const json* tJson = findObject(setting, "t");
  const int settingType = (tJson != nullptr && tJson->is_number_integer()) ? tJson->get<int>() : -1;

  // 1. Targeting rules — first-match-wins (US1).
  const json* rules = findObject(setting, "r");
  if (rules != nullptr && rules->is_array() && !rules->empty()) {
    if (evaluateTargetingRules(ctx, *rules, key, setting, settingType, &result)) {
      ctx.currentKey = savedKey;
      return result;
    }
  }

  // 2. Setting-level percentage options (US3).
  const json* options = findObject(setting, "p");
  if (options != nullptr && options->is_array() && !options->empty()) {
    if (evaluatePercentageOptions(ctx, *options, key, setting, settingType, false, &result)) {
      ctx.currentKey = savedKey;
      return result;
    }
  }

  // 3. Served fallback `setting.v`.
  result.value = setting.contains("v") ? setting["v"] : json();
  result.variationId = getString(setting, "i");
  result.matchedRule = false;
  result.matchedOption = false;
  ctx.currentKey = savedKey;
  return result;
}

EvalResult fail(const json& defaultValue, std::string code) {
  EvalResult r;
  r.value = defaultValue;
  r.error = std::move(code);
  return r;
}

}  // namespace

static EvalResult evaluateImpl(const nlohmann::json* config, const std::string& key,
                               const nlohmann::json& defaultValue, const User* user,
                               EvalTraceSink* sink) {
  if (config == nullptr || config->is_null()) {
    return fail(defaultValue, "NO_CONFIG");
  }
  if (!config->is_object()) {
    return fail(defaultValue, "MALFORMED_CONFIG");
  }
  auto fIt = config->find("f");
  if (fIt == config->end() || !fIt->is_object()) {
    return fail(defaultValue, "MALFORMED_CONFIG");
  }
  auto settingIt = fIt->find(key);
  if (settingIt == fIt->end()) {
    return fail(defaultValue, "KEY_NOT_FOUND");
  }
  if (!settingIt->is_object()) {
    return fail(defaultValue, "MALFORMED_CONFIG");
  }
  const json& setting = *settingIt;

  auto tIt = setting.find("t");
  if (tIt == setting.end() || !tIt->is_number_integer()) {
    return fail(defaultValue, "MALFORMED_CONFIG");
  }
  const int settingType = tIt->get<int>();

  // Default-type guard, mirroring the pre-existing tier-0 contract (SC-006).
  // A `null` default OPTS OUT of the type check (matching the TS evaluator's
  // `defaultValue !== null && typeof defaultValue !== expectedType` guard):
  // this is how `getValueDetails(key, null)` resolves the served value +
  // variationId regardless of the flag's declared type (FR-011). The four
  // typed slots are still validated below, after resolution.
  if (!defaultValue.is_null()) {
    switch (settingType) {
      case kSettingTypeBool:
        if (!defaultValue.is_boolean()) {
          return fail(defaultValue, "TYPE_MISMATCH");
        }
        break;
      case kSettingTypeString:
        if (!defaultValue.is_string()) {
          return fail(defaultValue, "TYPE_MISMATCH");
        }
        break;
      case kSettingTypeInt:
        if (!defaultValue.is_number_integer()) {
          return fail(defaultValue, "TYPE_MISMATCH");
        }
        break;
      case kSettingTypeDouble:
        if (!defaultValue.is_number()) {
          return fail(defaultValue, "TYPE_MISMATCH");
        }
        break;
      default:
        return fail(defaultValue, "UNSUPPORTED_TYPE");
    }
  } else if (settingType != kSettingTypeBool && settingType != kSettingTypeString &&
             settingType != kSettingTypeInt && settingType != kSettingTypeDouble) {
    return fail(defaultValue, "UNSUPPORTED_TYPE");
  }

  // Evaluation core — wrapped in the fail-closed boundary. A residual nlohmann
  // type error or a detected prerequisite cycle is converted to a tier-0
  // EVAL_ERROR + the supplied default (FR-012, SC-004). `traceLog` is declared
  // outside the try so the circular-dependency handler can emit ERROR 1002.
  EvalTraceLog traceLog(sink);
  try {
    std::vector<std::string> visitedFlags;
    std::string evalError;
    bool missingUserLogged = false;
    const json* segments = nullptr;
    auto sIt = config->find("s");
    if (sIt != config->end() && sIt->is_array()) {
      segments = &(*sIt);
    }
    std::string configSalt;
    auto pIt = config->find("p");
    if (pIt != config->end() && pIt->is_object()) {
      auto psIt = pIt->find("s");
      if (psIt != pIt->end() && psIt->is_string()) {
        configSalt = psIt->get<std::string>();
      }
    }

    // Eval-log trace setup (ADR 0003 / #501). `traceLog` no-ops when `sink` is
    // null/below INFO; the builder accrues the indented trace only when tracing
    // is enabled. The top-level header is the entry's responsibility (the
    // prerequisite child appends its own nested header).
    EvaluateLogBuilder traceBuilder;
    EvaluateLogBuilder* lbPtr = nullptr;
    if (traceLog.enabled(EvalTraceLevel::kInfo)) {
      lbPtr = &traceBuilder;
      traceBuilder.append("Evaluating '" + key + "'");
      if (user != nullptr) {
        traceBuilder.append(" for User '" + userAttributesForLogJson(*user) + "'");
      }
    }

    EvalContext ctx{&(*fIt),       segments,   std::move(configSalt), user,
                    &visitedFlags, &evalError, &missingUserLogged,    &traceLog,
                    lbPtr,         &key};
    const SettingResult resolved = evaluateSetting(ctx, key, setting);

    // Select the typed value by `t`; an absent / wrong-typed slot is "missing".
    const json value = selectSettingValue(&resolved.value, settingType);
    bool typeOk = false;
    switch (settingType) {
      case kSettingTypeBool:
        typeOk = value.is_boolean();
        break;
      case kSettingTypeString:
        typeOk = value.is_string();
        break;
      case kSettingTypeInt:
        typeOk = value.is_number_integer();
        break;
      case kSettingTypeDouble:
        typeOk = value.is_number();
        break;
      default:
        typeOk = false;
        break;
    }
    if (!typeOk) {
      // Preserve the pre-existing differentiated codes for the boolean slot.
      return fail(defaultValue,
                  settingType == kSettingTypeBool ? "VALUE_NOT_BOOL" : "MALFORMED_VALUE");
    }

    EvalResult out;
    if (settingType == kSettingTypeInt) {
      out.value = json(value.get<std::int64_t>());
    } else if (settingType == kSettingTypeDouble) {
      out.value = json(value.get<double>());
    } else {
      out.value = value;
    }
    out.variationId = resolved.variationId;
    out.hasMatchedRule = resolved.matchedRule;
    out.hasMatchedOption = resolved.matchedOption;
    out.evalError = evalError;
    if (lbPtr != nullptr) {
      traceBuilder.newLine("Returning '" + settingValueToLogString(value) + "'.");
      traceLog.info(kEvalLogEventId, traceBuilder.str());
    }
    return out;
  } catch (const CircularDependencyError& e) {
    // A detected prerequisite cycle: emit ConfigCat's ERROR 1002 (naming the
    // setting + the chain) before failing closed (matching the JS reference).
    traceLog.circularDependency(key, e.cycle);
    return fail(defaultValue, "EVAL_ERROR");
  } catch (const std::exception&) {
    // Fail-closed: any other internal exception (residual type error) →
    // default + tier-0 error.
    return fail(defaultValue, "EVAL_ERROR");
  }
}

EvalResult evaluate(const nlohmann::json* config, const std::string& key,
                    const nlohmann::json& defaultValue, const User* user) {
  return evaluateImpl(config, key, defaultValue, user, nullptr);
}

EvalResult evaluateTraced(const nlohmann::json* config, const std::string& key,
                          const nlohmann::json& defaultValue, const User* user,
                          EvalTraceSink* sink) {
  return evaluateImpl(config, key, defaultValue, user, sink);
}

}  // namespace confeature::internal
