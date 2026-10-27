// SPDX-License-Identifier: MIT

// ConfigCat conformance gate (spec 130, SC-001) — the C++ engine replays the
// vendored upstream evaluation matrix. Mirrors the spec-117 TS reference suite
// (`packages/sdk-shared/tests/parity-upstream.test.ts`) and the spec-118..121
// Python / Go / Ruby / PHP ports — most directly `apps/sdk-php/tests/
// EvaluatorUpstreamCorpusTest.php`. The corpus
// (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
// `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is the
// oracle: each `(config, key, user) -> expected` tuple is checked against
// `confeature::internal::evaluate(...)`.
//
// Per FR-018 only structured value / variationId / matched-rule|option identity
// is asserted — never a textual trace.
//
// The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
// faithfully — most critically the Go `csv.Reader` LazyQuotes semantics (a `"`
// only opens a quoted field at the field start), without which every JSON-array
// attribute cell is corrupted. The CSV is parsed by a hand-rolled LazyQuotes
// reader; a naive `;`-split mis-parses the JSON-array cells.
//
// Custom attributes are fed through a corpus-local typed-User path: the public
// `confeature::User` stringifies custom values by contract (its store is
// `map<string,string>`), so the matrix string attrs flow through that contract
// verbatim, while the `comparison_attribute_conversion` native number / array /
// epoch cases are canonicalised here via `userAttributeValueToString` — exactly
// what the public conversion path does — before being placed on the User. This
// exercises the comparator conversion path with the values the conversion
// driver intends (NaN / +/-Infinity / exponential numbers, JSON arrays).

#include <algorithm>
#include <catch2/catch_test_macros.hpp>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <memory>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "confeature/user.h"
#include "internal/evaluator.h"
#include "workspace_root.h"

using confeature::User;
using confeature::internal::EvalResult;
using confeature::internal::evaluate;
using confeature::internal::evaluateTraced;
using confeature::tests::upstreamPath;
using nlohmann::json;

namespace {

// `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob was
// NOT captured by the spec-117 vendoring (known DATA gap #401, not an engine
// gap). The multilevel-prerequisite path IS exercised by the reconstructed
// chain test below + the circular_dep chain. Excluded LOUDLY (the same marker
// the TS / Python / Ruby / PHP references use), never silently.
const char* const kUnvendoredEvalLogKey = "dependentFeatureMultipleLevels";  // #401

constexpr const char* kPkd = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/";
constexpr const char* kJcp = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/";

// ── file readers ────────────────────────────────────────────────────────────

std::string readText(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  REQUIRE(stream.is_open());
  std::ostringstream buf;
  buf << stream.rdbuf();
  return buf.str();
}

json readJson(const std::string& relative) {
  return json::parse(readText(upstreamPath() / relative));
}

// ── canonical user-attribute stringification (userAttributeValueToString) ────
//
// Ports `packages/sdk-shared/src/comparators.ts::userAttributeValueToString`
// and `numberToCanonicalString` (the ECMAScript `Number.toString` shape). The
// matrix CSVs deliver every attr as a string already; this is only reached by
// the `comparison_attribute_conversion` driver, which feeds native numbers /
// arrays. NaN / +/-Infinity / exponential magnitudes must format exactly as JS.

std::string numberToCanonicalString(double value) {
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

  // nlohmann's dump() yields the shortest round-tripping decimal repr (it uses
  // a Grisu/dragonbox-class algorithm), the same property the PHP port gets
  // from `serialize_precision = -1`. We then reshape it into the ECMAScript
  // `Number.toString` form via the [digits, point] decomposition.
  const std::string shortest = json(av).dump();

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

  // Strip leading zeros (adjusting point), then trailing zeros.
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

// Mirrors userAttributeValueToString for the JSON-decoded native values the
// conversion driver supplies: string verbatim, bool -> "true"/"false", string
// array -> compact JSON (unescaped slashes/unicode), number -> canonical.
std::string userAttributeValueToString(const json& value) {
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_boolean()) {
    return value.get<bool>() ? "true" : "false";
  }
  if (value.is_array()) {
    // JSON.stringify of a string array — compact, unescaped slashes/unicode.
    std::string out = "[";
    bool first = true;
    for (const auto& e : value) {
      if (!first) {
        out += ",";
      }
      first = false;
      // nlohmann escapes "/" by default? It does NOT escape forward slashes,
      // and emits \uXXXX for non-ASCII unless ensure_ascii=false. Use
      // dump(-1,' ',false) on the element to keep slashes + UTF-8 raw.
      out += e.dump(-1, ' ', /*ensure_ascii=*/false);
    }
    out += "]";
    return out;
  }
  if (value.is_number()) {
    return numberToCanonicalString(value.get<double>());
  }
  return value.dump();
}

// ── corpus user ─────────────────────────────────────────────────────────────
//
// Builds the public `confeature::User`. Well-known attrs map to the typed
// setters; custom attrs are canonicalised to their string form (what the public
// User stores by contract) so the matrix-string path and the native-typed
// conversion path converge on the same comparator input.

std::unique_ptr<User> makeUser(const std::string& identifier, const json& custom) {
  auto user = std::make_unique<User>(identifier);
  if (custom.is_object()) {
    for (auto it = custom.begin(); it != custom.end(); ++it) {
      const std::string& key = it.key();
      const json& v = it.value();
      if (key == "Email") {
        user->withEmail(userAttributeValueToString(v));
      } else if (key == "Country") {
        user->withCountry(userAttributeValueToString(v));
      } else {
        user->withCustom(key, userAttributeValueToString(v));
      }
    }
  }
  return user;
}

// ── LazyQuotes CSV reader (Go csv.Reader, Comma=';', LazyQuotes=true) ────────
//
// A `"` only opens a quoted field when it is the FIRST char of the field;
// anywhere else it is a literal quote. Getting this wrong corrupts every
// JSON-array attribute cell.

std::vector<std::string> parseCsvLine(const std::string& line) {
  std::vector<std::string> fields;
  std::string field;
  bool inQuotes = false;
  bool fieldStart = true;
  const std::size_t n = line.size();
  for (std::size_t i = 0; i < n; ++i) {
    const char ch = line[i];
    if (inQuotes && ch == '"' && i + 1 < n && line[i + 1] == '"') {
      field += '"';
      ++i;
    } else if (inQuotes && ch == '"') {
      inQuotes = false;
    } else if (inQuotes) {
      field += ch;
    } else if (ch == '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch == ';') {
      fields.push_back(field);
      field.clear();
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  fields.push_back(field);
  return fields;
}

std::vector<std::string> splitLines(const std::string& text) {
  std::vector<std::string> lines;
  std::string cur;
  for (char ch : text) {
    if (ch == '\n') {
      if (!cur.empty() && cur.back() == '\r') {
        cur.pop_back();
      }
      if (!cur.empty()) {
        lines.push_back(cur);
      }
      cur.clear();
    } else {
      cur += ch;
    }
  }
  if (!cur.empty() && cur.back() == '\r') {
    cur.pop_back();
  }
  if (!cur.empty()) {
    lines.push_back(cur);
  }
  return lines;
}

// Parse a CSV cell to its primitive (mirrors upstream `parseCell`).
json parseCell(const std::string& s) {
  // Integer (within the 2^53 safe range, exact round-trip).
  if (!s.empty()) {
    bool allDigits = true;
    std::size_t start = (s[0] == '-') ? 1 : 0;
    if (start == s.size()) {
      allDigits = false;
    }
    for (std::size_t i = start; i < s.size(); ++i) {
      if (s[i] < '0' || s[i] > '9') {
        allDigits = false;
        break;
      }
    }
    if (allDigits) {
      // strtoll, not stoll: an overflow (ERANGE) is an expected input that
      // falls through to the string branch, not an exception to swallow.
      errno = 0;
      const long long n = std::strtoll(s.c_str(), nullptr, 10);
      if (errno == 0 && std::llabs(n) <= 9007199254740991LL && std::to_string(n) == s) {
        return json(n);
      }
    }
  }
  // Float.
  {
    bool looksFloat = !s.empty();
    bool sawDigit = false;
    bool sawDot = false;
    bool sawExp = false;
    for (std::size_t i = 0; i < s.size() && looksFloat; ++i) {
      const char c = s[i];
      if (c >= '0' && c <= '9') {
        sawDigit = true;
      } else if (c == '-' || c == '+') {
        // sign allowed at start or right after exponent marker
      } else if (c == '.') {
        sawDot = true;
      } else if (c == 'e' || c == 'E') {
        sawExp = true;
      } else {
        looksFloat = false;
      }
    }
    if (looksFloat && sawDigit && (sawDot || sawExp)) {
      // strtod, not stod: no conversion or an out-of-range value falls
      // through to the string branch exactly where stod would have thrown.
      errno = 0;
      char* end = nullptr;
      const double d = std::strtod(s.c_str(), &end);
      if (end != s.c_str() && errno != ERANGE) {
        return json(d);
      }
    }
  }
  if (s == "True") {
    return json(true);
  }
  if (s == "False") {
    return json(false);
  }
  return json(s);
}

// ── matrix → sdkKey mapping (verbatim from upstream-corpus.ts) ───────────────

struct MatrixEntry {
  std::string sdkKey;
  bool variation;  // kind == "variation"
};

bool matrixEntry(const std::string& matrix, MatrixEntry* out) {
  static const std::vector<std::pair<std::string, MatrixEntry>> map = {
      {"testmatrix.csv", {std::string(kPkd) + "AG6C1ngVb0CvM07un6JisQ", false}},
      {"testmatrix_semantic.csv", {std::string(kPkd) + "iV8vH2MBakKxkFZylxHmTg", false}},
      {"testmatrix_number.csv", {std::string(kPkd) + "FCWN-k1dV0iBf8QZrDgjdw", false}},
      {"testmatrix_semantic_2.csv", {std::string(kPkd) + "U8nt3zEhDEO5S2ulubCopA", false}},
      {"testmatrix_sensitive.csv", {std::string(kPkd) + "-0YmVOUNgEGKkgRF-rU65g", false}},
      {"testmatrix_segments_old.csv", {std::string(kPkd) + "y_ZB7o-Xb0Swxth-ZlMSeA", false}},
      {"testmatrix_and_or.csv", {std::string(kJcp) + "ByMO9yZNn02kXcm72lnY1A", false}},
      {"testmatrix_comparators_v6.csv", {std::string(kJcp) + "OfQqcTjfFUGBwMKqtyEOrQ", false}},
      {"testmatrix_prerequisite_flag.csv", {std::string(kJcp) + "JoGwdqJZQ0K2xDy7LnbyOg", false}},
      {"testmatrix_segments.csv", {std::string(kJcp) + "h99HYXWWNE2bH8eWyLAVMA", false}},
      {"testmatrix_unicode.csv", {std::string(kJcp) + "Da6w8dBbmUeMUBhh0iEeQQ", false}},
      {"testmatrix_variationId.csv", {std::string(kPkd) + "spQnkRTIPEWVivZkWM84lQ", true}},
  };
  const auto it = std::find_if(map.begin(), map.end(),
                               [&matrix](const auto& kv) { return kv.first == matrix; });
  if (it == map.end()) {
    return false;
  }
  *out = it->second;
  return true;
}

// ── config resolution ────────────────────────────────────────────────────────

const json& contentByKey() {
  static const json cache = readJson("content-by-key.json");
  return cache;
}

const json& evalLogConfigs() {
  static const json cache = readJson("evaluationlog/_configs-by-key.json");
  return cache;
}

// The null-token used by the matrix loaders for an absent user.
const char* const kNullToken = "##null##";

// ── type-aware default + value equality (mirror the PHP helpers) ─────────────

int settingType(const json& config, const std::string& key) {
  if (!config.is_object()) {
    return -1;
  }
  auto fIt = config.find("f");
  if (fIt == config.end() || !fIt->is_object()) {
    return -1;
  }
  auto sIt = fIt->find(key);
  if (sIt == fIt->end() || !sIt->is_object()) {
    return -1;
  }
  auto tIt = sIt->find("t");
  if (tIt == sIt->end() || !tIt->is_number_integer()) {
    return -1;
  }
  return tIt->get<int>();
}

// Type-appropriate default matching the resolved primitive type. The strict
// evaluator distinguishes int (t=2) from double (t=3), so the default must be
// the SAME numeric kind the setting type expects.
json defaultFor(const json& expected, int type) {
  if (expected.is_boolean()) {
    return json(false);
  }
  if (expected.is_number()) {
    return type == confeature::internal::kSettingTypeDouble ? json(0.0) : json(0);
  }
  return json("__default__");
}

// Cast a JSON-decoded eval-log default to the type implied by `t`.
json coerceDefault(const json& def, int type) {
  if (def.is_boolean()) {
    return def;
  }
  if (type == confeature::internal::kSettingTypeDouble && def.is_number_integer()) {
    return json(def.get<double>());
  }
  if (type == confeature::internal::kSettingTypeInt && def.is_number_float()) {
    return json(static_cast<std::int64_t>(def.get<double>()));
  }
  return def;
}

// Numeric-tolerant equality (5 == 5.0); booleans must not equate with numbers.
bool valueEqual(const json& actual, const json& expected) {
  if (expected.is_number() && !expected.is_boolean()) {
    if (actual.is_boolean()) {
      return false;
    }
    if (!actual.is_number()) {
      return false;
    }
    return actual.get<double>() == expected.get<double>();
  }
  if (expected.is_boolean() != actual.is_boolean()) {
    return false;
  }
  return actual == expected;
}

// ── tuple collection ─────────────────────────────────────────────────────────

struct MatrixTuple {
  std::string label;
  std::string key;
  std::unique_ptr<User> user;
  bool variation{false};
  json expected;
  const json* config{nullptr};
};

std::string userLabel(const User* user) {
  if (user == nullptr) {
    return "null";
  }
  std::string s = "id=" + user->identifier();
  if (!user->email().empty()) {
    s += " email=" + user->email();
  }
  if (!user->country().empty()) {
    s += " country=" + user->country();
  }
  for (const auto& kv : user->custom()) {
    s += " " + kv.first + "=" + kv.second;
  }
  return s;
}

std::unique_ptr<User> userFromRow(const std::vector<std::string>& cols,
                                  const std::string& customKey) {
  if (cols.empty() || cols[0] == kNullToken) {
    return nullptr;
  }
  auto setOrNull = [](const std::string& v) -> bool { return !(v.empty() || v == kNullToken); };
  const std::string identifier = !cols[0].empty() ? cols[0] : std::string();
  auto user = std::make_unique<User>(identifier);
  if (cols.size() > 1 && setOrNull(cols[1])) {
    user->withEmail(cols[1]);
  }
  if (cols.size() > 2 && setOrNull(cols[2])) {
    user->withCountry(cols[2]);
  }
  if (cols.size() > 3 && setOrNull(cols[3])) {
    user->withCustom(customKey, cols[3]);
  }
  return user;
}

std::vector<MatrixTuple> loadMatrix(const std::string& matrix) {
  MatrixEntry entry;
  REQUIRE(matrixEntry(matrix, &entry));
  const json& byKey = contentByKey();
  REQUIRE(byKey.contains(entry.sdkKey));
  const json& config = byKey.at(entry.sdkKey);

  const auto lines = splitLines(readText(upstreamPath() / matrix));
  REQUIRE(lines.size() > 1);
  const auto header = parseCsvLine(lines[0]);
  const std::string customKey = header.size() > 3 ? header[3] : "Custom1";
  std::vector<std::string> settingKeys(header.begin() + 4, header.end());

  std::vector<MatrixTuple> out;
  for (std::size_t r = 1; r < lines.size(); ++r) {
    const auto cols = parseCsvLine(lines[r]);
    for (std::size_t c = 0; c < settingKeys.size(); ++c) {
      const std::string raw = (c + 4) < cols.size() ? cols[c + 4] : std::string();
      MatrixTuple t;
      t.key = settingKeys[c];
      t.user = userFromRow(cols, customKey);
      t.variation = entry.variation;
      t.expected = entry.variation ? json(raw) : parseCell(raw);
      t.config = &config;
      t.label = matrix + " " + t.key + " user=" + userLabel(t.user.get());
      out.push_back(std::move(t));
    }
  }
  return out;
}

// ── eval-log scenario loading ────────────────────────────────────────────────

struct EvalLogTuple {
  std::string label;
  std::string key;
  json defaultValue;  // null when absent
  std::unique_ptr<User> user;
  json expected;
  std::shared_ptr<json> config;  // owns jsonOverride configs
};

std::unique_ptr<User> evalLogUser(const json& raw) {
  if (!raw.is_object() || raw.empty()) {
    return nullptr;
  }
  std::string identifier;
  json custom = json::object();
  std::string email;
  std::string country;
  bool hasEmail = false;
  bool hasCountry = false;
  for (auto it = raw.begin(); it != raw.end(); ++it) {
    const std::string& k = it.key();
    if (k == "Identifier") {
      identifier = it.value().is_string() ? it.value().get<std::string>()
                                          : userAttributeValueToString(it.value());
    } else if (k == "Email") {
      email = it.value().is_string() ? it.value().get<std::string>()
                                     : userAttributeValueToString(it.value());
      hasEmail = true;
    } else if (k == "Country") {
      country = it.value().is_string() ? it.value().get<std::string>()
                                       : userAttributeValueToString(it.value());
      hasCountry = true;
    } else {
      // Custom attrs keep their native JSON type; canonicalised to the string
      // the public User stores (mirrors the matrix loader's intent).
      custom[k] = it.value();
    }
  }
  auto user = makeUser(identifier, custom);
  if (hasEmail) {
    user->withEmail(email);
  }
  if (hasCountry) {
    user->withCountry(country);
  }
  return user;
}

std::shared_ptr<json> evalLogConfig(const json& suite) {
  if (suite.contains("jsonOverride") && suite["jsonOverride"].is_string()) {
    return std::make_shared<json>(
        readJson("evaluationlog/_overrides/" + suite["jsonOverride"].get<std::string>()));
  }
  if (suite.contains("sdkKey") && suite["sdkKey"].is_string()) {
    const std::string sdkKey = suite["sdkKey"].get<std::string>();
    if (contentByKey().contains(sdkKey)) {
      return std::make_shared<json>(contentByKey().at(sdkKey));
    }
    if (evalLogConfigs().contains(sdkKey)) {
      return std::make_shared<json>(evalLogConfigs().at(sdkKey));
    }
    FAIL("No config for eval-log sdkKey " + sdkKey);
  }
  FAIL("Eval-log suite has neither jsonOverride nor sdkKey");
  return nullptr;
}

std::vector<EvalLogTuple> loadEvalLog(const std::string& scenario) {
  const json suite = readJson("evaluationlog/" + scenario + ".json");
  auto config = evalLogConfig(suite);
  std::vector<EvalLogTuple> out;
  if (!suite.contains("tests") || !suite["tests"].is_array()) {
    return out;
  }
  for (const auto& t : suite["tests"]) {
    if (!t.is_object()) {
      continue;
    }
    EvalLogTuple e;
    e.key = t.value("key", "");
    e.defaultValue = t.contains("defaultValue") ? t["defaultValue"] : json();
    e.user = evalLogUser(t.contains("user") ? t["user"] : json());
    e.expected = t.contains("returnValue") ? t["returnValue"] : json();
    e.config = config;
    e.label = scenario + " " + e.key + " user=" + userLabel(e.user.get());
    out.push_back(std::move(e));
  }
  return out;
}

// ── assertion helpers ────────────────────────────────────────────────────────

void assertMatrixTuple(const MatrixTuple& t, std::vector<std::string>& failures) {
  if (t.variation) {
    // The variation matrix carries no per-row default; ConfigCat resolves the
    // variationId via a null default, which opts out of the default-type guard
    // so the served value + id resolve regardless of the flag's declared type.
    const EvalResult r = evaluate(t.config, t.key, json(nullptr), t.user.get());
    if (json(r.variationId) != t.expected) {
      failures.push_back(t.label + ": actual=" + json(r.variationId).dump() +
                         " expected=" + t.expected.dump());
    }
    return;
  }
  const json def = defaultFor(t.expected, settingType(*t.config, t.key));
  const EvalResult r = evaluate(t.config, t.key, def, t.user.get());
  if (!valueEqual(r.value, t.expected)) {
    failures.push_back(t.label + ": actual=" + r.value.dump() + " expected=" + t.expected.dump());
  }
}

void assertEvalLogTuple(const EvalLogTuple& t, std::vector<std::string>& failures) {
  const int type = settingType(*t.config, t.key);
  const json def =
      t.defaultValue.is_null() ? defaultFor(t.expected, type) : coerceDefault(t.defaultValue, type);
  const EvalResult r = evaluate(t.config.get(), t.key, def, t.user.get());
  if (!valueEqual(r.value, t.expected)) {
    failures.push_back(t.label + ": actual=" + r.value.dump() + " expected=" + t.expected.dump());
  }
}

// ── Eval-log TRACE fidelity (ADR 0003 / epic #494, #501 C++ slice) ──────────
// Replays parity-evaluationlog.json (the cross-language byte-oracle; each tuple
// carries a Confeature-canonical expectedTrace) through evaluateTraced and
// asserts the emitted trace is byte-identical. Mirrors the .NET / Rust / Ruby
// ports.

const std::vector<std::string> kTraceScenarios = {
    "simple_value",
    "1_targeting_rule",
    "2_targeting_rules",
    "and_rules",
    "options_based_on_user_id",
    "options_based_on_custom_attr",
    "options_after_targeting_rule",
    "options_within_targeting_rule",
    "list_truncation",
    "number_validation",
    "circular_dep",
    "prerequisite_flag",
    "semver_validation",
    "epoch_date_validation",
};

std::string traceLabel(confeature::internal::EvalTraceLevel level) {
  switch (level) {
    case confeature::internal::EvalTraceLevel::kError:
      return "ERROR";
    case confeature::internal::EvalTraceLevel::kWarn:
      return "WARN";
    case confeature::internal::EvalTraceLevel::kInfo:
      return "INFO";
    case confeature::internal::EvalTraceLevel::kDebug:
      return "DEBUG";
    default:
      return "?";
  }
}

// INFO-level capture sink reconstructing the parity byte-string.
struct CaptureSink : confeature::internal::EvalTraceSink {
  std::vector<std::string> lines;

  confeature::internal::EvalTraceLevel level() const override {
    return confeature::internal::EvalTraceLevel::kInfo;
  }

  void log(confeature::internal::EvalTraceLevel lvl, const std::string& eventId,
           const std::string& message) override {
    lines.push_back(traceLabel(lvl) + ": [" + eventId + "] " + message);
  }
};

// Build a User from the corpus tuple's LOWERCASE user object
// (`{identifier, email?, country?, custom?}`) by reshaping it into the
// capitalized flat form evalLogUser/makeUser expect, then reusing them.
std::unique_ptr<User> traceUser(const json& raw) {
  if (!raw.is_object() || raw.empty()) {
    return nullptr;
  }
  json reshaped = json::object();
  if (raw.contains("identifier")) {
    reshaped["Identifier"] = raw["identifier"];
  }
  if (raw.contains("email")) {
    reshaped["Email"] = raw["email"];
  }
  if (raw.contains("country")) {
    reshaped["Country"] = raw["country"];
  }
  if (raw.contains("custom") && raw["custom"].is_object()) {
    for (auto it = raw["custom"].begin(); it != raw["custom"].end(); ++it) {
      reshaped[it.key()] = it.value();
    }
  }
  return evalLogUser(reshaped);
}

}  // namespace

// =============================================================================
// US1 / US2 — value + comparator matrices
// =============================================================================

TEST_CASE("upstream corpus — value + comparator matrices", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& matrix :
       {"testmatrix.csv", "testmatrix_comparators_v6.csv", "testmatrix_semantic.csv",
        "testmatrix_semantic_2.csv", "testmatrix_number.csv", "testmatrix_sensitive.csv",
        "testmatrix_unicode.csv"}) {
    const auto tuples = loadMatrix(matrix);
    REQUIRE_FALSE(tuples.empty());
    for (const auto& t : tuples) {
      assertMatrixTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  INFO("drift count=" << failures.size());
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

// =============================================================================
// US4 — segments / prerequisites / AND-OR matrices
// =============================================================================

TEST_CASE("upstream corpus — segment / prerequisite / and-or matrices", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& matrix :
       {"testmatrix_and_or.csv", "testmatrix_segments.csv", "testmatrix_segments_old.csv",
        "testmatrix_prerequisite_flag.csv"}) {
    const auto tuples = loadMatrix(matrix);
    REQUIRE_FALSE(tuples.empty());
    for (const auto& t : tuples) {
      assertMatrixTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

// =============================================================================
// US5 — variationId matrix (FR-011)
// =============================================================================

TEST_CASE("upstream corpus — variationId matrix", "[upstream_corpus]") {
  const auto tuples = loadMatrix("testmatrix_variationId.csv");
  REQUIRE_FALSE(tuples.empty());
  std::vector<std::string> failures;
  for (const auto& t : tuples) {
    assertMatrixTuple(t, failures);
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

// =============================================================================
// US1 — targeting-rule eval-log scenarios
// =============================================================================

TEST_CASE("upstream corpus — targeting-rule scenarios", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& scenario : {"1_targeting_rule", "2_targeting_rules", "simple_value"}) {
    for (const auto& t : loadEvalLog(scenario)) {
      assertEvalLogTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("upstream corpus — matched targeting rule + no-user fallback", "[upstream_corpus]") {
  const auto cases = loadEvalLog("1_targeting_rule");

  // The matching case (Email contains @configcat.com) serves "Dog" via a rule.
  const EvalLogTuple* matching = nullptr;
  const EvalLogTuple* noUser = nullptr;
  for (const auto& c : cases) {
    if (c.expected.is_string() && c.expected.get<std::string>() == "Dog") {
      matching = &c;
    }
    if (c.user == nullptr) {
      noUser = &c;
    }
  }
  REQUIRE(matching != nullptr);
  REQUIRE(noUser != nullptr);

  const EvalResult m =
      evaluate(matching->config.get(), matching->key, json("default"), matching->user.get());
  REQUIRE(m.value == json("Dog"));
  REQUIRE(m.hasMatchedRule);
  REQUIRE_FALSE(m.hasMatchedOption);
  REQUIRE(m.error.empty());

  // No user → fallback served value (Cat) + a surfaced (non-fatal) eval error,
  // never a throw (FR-017).
  const EvalResult n = evaluate(noUser->config.get(), noUser->key, json("default"), nullptr);
  REQUIRE(n.value == json("Cat"));
  REQUIRE(n.error.empty());  // a value resolved cleanly
  REQUIRE_FALSE(n.evalError.empty());
  REQUIRE(n.evalError.find("User Object is missing") != std::string::npos);
  REQUIRE_FALSE(n.hasMatchedRule);
}

// =============================================================================
// US3 — percentage rollout + repeat-invariance (FR-005)
// =============================================================================

TEST_CASE("upstream corpus — percentage scenarios", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& scenario :
       {"options_based_on_user_id", "options_based_on_custom_attr", "options_after_targeting_rule",
        "options_within_targeting_rule"}) {
    for (const auto& t : loadEvalLog(scenario)) {
      assertEvalLogTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("upstream corpus — percentage bucketing is repeat-invariant", "[upstream_corpus]") {
  const auto cases = loadEvalLog("options_based_on_user_id");
  const EvalLogTuple* withUser = nullptr;
  for (const auto& c : cases) {
    if (c.user != nullptr) {
      withUser = &c;
      break;
    }
  }
  REQUIRE(withUser != nullptr);
  const int type = settingType(*withUser->config, withUser->key);
  const json def = withUser->defaultValue.is_null() ? defaultFor(withUser->expected, type)
                                                    : coerceDefault(withUser->defaultValue, type);
  const EvalResult first =
      evaluate(withUser->config.get(), withUser->key, def, withUser->user.get());
  for (int i = 0; i < 20; ++i) {
    const EvalResult again =
        evaluate(withUser->config.get(), withUser->key, def, withUser->user.get());
    REQUIRE(again.value == first.value);
    REQUIRE(again.variationId == first.variationId);
  }
  REQUIRE(valueEqual(first.value, withUser->expected));
  REQUIRE(first.hasMatchedOption);
}

// Regression lock for the in-rule percentage-option variationId fix (spec-130
// review): when a MATCHING targeting rule serves a PERCENTAGE OPTION (in-rule
// `p`), the result must report BOTH a matched rule AND a matched option, and the
// variationId must propagate from the bucketed option's `i` — not the
// setting-level `i`. This pins the exact (setting-level + in-rule percentage)
// variationId-propagation bug against regression.
TEST_CASE("upstream corpus — in-rule percentage option reports rule+option+variationId",
          "[upstream_corpus]") {
  const auto cases = loadEvalLog("options_within_targeting_rule");

  // The fully-targeted case: Email contains @configcat.com matches the rule,
  // Country (the percentage attribute) is present, so an in-rule percentage
  // option decides the value.
  const EvalLogTuple* inRule = nullptr;
  for (const auto& c : cases) {
    if (c.user != nullptr && !c.user->email().empty() && !c.user->country().empty()) {
      inRule = &c;
      break;
    }
  }
  REQUIRE(inRule != nullptr);

  const EvalResult r =
      evaluate(inRule->config.get(), inRule->key, json("default"), inRule->user.get());

  // Non-vacuous: a value resolved (not the default).
  REQUIRE(r.value == json("Cat"));
  REQUIRE(r.error.empty());
  // The exact bug surface: BOTH a matched rule AND a matched percentage option.
  REQUIRE(r.hasMatchedRule);
  REQUIRE(r.hasMatchedOption);
  // variationId is the bucketed option's `i` ("Cat" → 05a1d8f3).
  REQUIRE(r.variationId == "05a1d8f3");

  // Distinct-id construction: here the bucketed in-rule option's `i`
  // ("optHit") DIFFERS from the setting-level `i` ("setLevel"), so the
  // assertion fails iff variationId propagation reverts to the setting level.
  // A single 100%-weighted option deterministically buckets to itself for any
  // user, isolating the propagation path from the hash.
  const json config = json::parse(R"JSON({
    "p": {"u": "", "r": 0, "s": "salt"},
    "s": [],
    "f": {
      "inRulePct": {
        "t": 1, "a": "Identifier", "v": {"s": "off"}, "i": "setLevel",
        "r": [{
          "c": [{"u": {"a": "Email", "c": 2, "l": ["@configcat.com"]}}],
          "p": [{"p": 100, "v": {"s": "on"}, "i": "optHit"}]
        }]
      }
    }
  })JSON");
  auto matchUser = std::make_unique<User>("12345");
  matchUser->withEmail("joe@configcat.com");
  const EvalResult rr = evaluate(&config, "inRulePct", json("default"), matchUser.get());
  REQUIRE(rr.value == json("on"));
  REQUIRE(rr.hasMatchedRule);
  REQUIRE(rr.hasMatchedOption);
  REQUIRE(rr.variationId == "optHit");
}

// =============================================================================
// US4 — segment / prerequisite / and-rule eval-log scenarios
// =============================================================================

TEST_CASE("upstream corpus — segment / prerequisite / and-rule scenarios", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& scenario : {"segment", "prerequisite_flag", "and_rules"}) {
    for (const auto& t : loadEvalLog(scenario)) {
      // #401: the multilevel-prerequisite config blob was not vendored. The
      // path is covered by the reconstructed-chain test below — exclude LOUDLY.
      if (t.key == kUnvendoredEvalLogKey) {
        continue;
      }
      assertEvalLogTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("upstream corpus — segment match reports value + variationId", "[upstream_corpus]") {
  const auto cases = loadEvalLog("segment");
  const EvalLogTuple* match = nullptr;
  for (const auto& c : cases) {
    if (c.key == "featureWithSegmentTargeting" && c.user != nullptr && c.expected.is_boolean() &&
        c.expected.get<bool>()) {
      match = &c;
      break;
    }
  }
  REQUIRE(match != nullptr);
  const EvalResult r = evaluate(match->config.get(), match->key, json(false), match->user.get());
  REQUIRE(r.value == json(true));
  REQUIRE(r.hasMatchedRule);
  REQUIRE_FALSE(r.variationId.empty());
}

// #401: the multilevel A->B->C prerequisite chain reconstructed (its config blob
// was not vendored). Proves the engine recurses through nested prerequisites.
TEST_CASE("upstream corpus — multilevel prerequisite via reconstructed chain",
          "[upstream_corpus]") {
  const json config = json::parse(R"JSON({
    "p": {"u": "", "r": 0, "s": "salt"},
    "s": [],
    "f": {
      "mainFeatureWithoutUserCondition": {"t": 0, "v": {"b": true}, "i": "main", "r": []},
      "intermediateFeature": {
        "t": 0, "v": {"b": false}, "i": "inter",
        "r": [{
          "c": [
            {"p": {"f": "mainFeatureWithoutUserCondition", "c": 0, "v": {"b": true}}},
            {"p": {"f": "mainFeatureWithoutUserCondition", "c": 0, "v": {"b": true}}}
          ],
          "s": {"v": {"b": true}, "i": "interT"}
        }]
      },
      "dependentFeatureMultipleLevels": {
        "t": 1, "v": {"s": "Cat"}, "i": "dep",
        "r": [{
          "c": [{"p": {"f": "intermediateFeature", "c": 0, "v": {"b": true}}}],
          "s": {"v": {"s": "Dog"}, "i": "depDog"}
        }]
      }
    }
  })JSON");
  const EvalResult r =
      evaluate(&config, "dependentFeatureMultipleLevels", json("default"), nullptr);
  REQUIRE(r.value == json("Dog"));
  REQUIRE(r.hasMatchedRule);
}

// =============================================================================
// US4 — circular-dependency termination (SC-004, bounded fail-closed)
// =============================================================================

TEST_CASE("upstream corpus — circular dependency is bounded + fail-closed", "[upstream_corpus]") {
  std::vector<std::string> failures;
  for (const auto& t : loadEvalLog("circular_dep")) {
    const auto start = std::chrono::steady_clock::now();
    const EvalResult r = evaluate(t.config.get(), t.key, json("default"), t.user.get());
    const auto elapsed =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    if (elapsed >= 1.0) {
      failures.push_back(t.key + " took too long (" + std::to_string(elapsed) +
                         "s) — cycle not bounded");
    }
    if (r.value != json("default")) {
      failures.push_back(t.key + " value=" + r.value.dump() + " (expected fail-closed default)");
    }
    if (r.error.empty()) {
      failures.push_back(t.key + " resolved with no error code");
    }
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("upstream corpus — direct two-flag cycle terminates", "[upstream_corpus]") {
  const json config = json::parse(R"JSON({
    "p": {"u": "", "r": 0, "s": "salt"},
    "s": [],
    "f": {
      "flagA": {"t": 1, "v": {"s": "A"}, "i": "a",
        "r": [{"c": [{"p": {"f": "flagB", "c": 0, "v": {"b": true}}}], "s": {"v": {"s": "AA"}, "i": "aa"}}]},
      "flagB": {"t": 1, "v": {"s": "B"}, "i": "b",
        "r": [{"c": [{"p": {"f": "flagA", "c": 0, "v": {"b": true}}}], "s": {"v": {"s": "BB"}, "i": "bb"}}]}
    }
  })JSON");
  const auto start = std::chrono::steady_clock::now();
  const EvalResult r = evaluate(&config, "flagA", json("default"), nullptr);
  const auto elapsed =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  REQUIRE(elapsed < 1.0);
  REQUIRE(r.value == json("default"));
  REQUIRE_FALSE(r.error.empty());
}

// =============================================================================
// US5 — typed-attribute validation (FR-010) + list truncation
// =============================================================================

TEST_CASE("upstream corpus — validation + list-truncation scenarios", "[upstream_corpus]") {
  std::size_t total = 0;
  std::vector<std::string> failures;
  for (const std::string& scenario :
       {"semver_validation", "number_validation", "epoch_date_validation", "list_truncation"}) {
    for (const auto& t : loadEvalLog(scenario)) {
      assertEvalLogTuple(t, failures);
      ++total;
    }
  }
  REQUIRE(total > 0);
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

// =============================================================================
// US5 — comparison_*.json conversion / trimming drivers
// =============================================================================

TEST_CASE("upstream corpus — attribute conversion (NaN/Inf/exp/array)", "[upstream_corpus]") {
  const json config = readJson("comparison_attribute_conversion.json");
  const double inf = std::numeric_limits<double>::infinity();
  const double nan = std::numeric_limits<double>::quiet_NaN();

  struct Case {
    std::string key;
    json custom1;
    std::string expected;
  };
  std::vector<Case> driver = {
      {"numberToStringConversion", json(0.12345), "1"},
      {"numberToStringConversionInt", json(125), "4"},
      {"numberToStringConversionPositiveExp", json(-1.23456789e96), "2"},
      {"numberToStringConversionNegativeExp", json(-1.23456789e-96), "4"},
      {"numberToStringConversionNaN", json(nan), "3"},
      {"numberToStringConversionPositiveInf", json(inf), "4"},
      {"numberToStringConversionNegativeInf", json(-inf), "3"},
      {"dateToStringConversion", json(1680307199.999), "3"},
      {"dateToStringConversionNaN", json(nan), "3"},
      {"dateToStringConversionPositiveInf", json(inf), "1"},
      {"dateToStringConversionNegativeInf", json(-inf), "5"},
      {"stringArrayToStringConversion", json::array({"read", "Write", " eXecute "}), "4"},
      {"stringArrayToStringConversionEmpty", json::array(), "5"},
      {"stringArrayToStringConversionSpecialChars", json::array({std::string("+<>%\"'\\/\t\r\n")}),
       "3"},
      {"stringArrayToStringConversionUnicode", json::array({std::string("äöüÄÖÜçéèñışğâ¢™✓😀")}),
       "2"},
  };

  std::vector<std::string> failures;
  for (const auto& c : driver) {
    json custom = json::object();
    custom["Custom1"] = c.custom1;
    auto user = makeUser("12345", custom);
    const EvalResult r = evaluate(&config, c.key, json("default"), user.get());
    if (r.value != json(c.expected)) {
      failures.push_back(c.key + ": actual=" + r.value.dump() + " expected=\"" + c.expected + "\"");
    }
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

namespace {

struct TrimCase {
  std::string key;
  std::string expected;
};

std::vector<TrimCase> attributeTrimmingDriver() {
  std::vector<TrimCase> out;
  for (const char* k : {"isoneof",
                        "isnotoneof",
                        "isoneofhashed",
                        "isnotoneofhashed",
                        "equalshashed",
                        "notequalshashed",
                        "arraycontainsanyofhashed",
                        "arraynotcontainsanyofhashed",
                        "equals",
                        "notequals",
                        "startwithanyof",
                        "notstartwithanyof",
                        "endswithanyof",
                        "notendswithanyof",
                        "arraycontainsanyof",
                        "arraynotcontainsanyof",
                        "startwithanyofhashed",
                        "notstartwithanyofhashed",
                        "endswithanyofhashed",
                        "notendswithanyofhashed"}) {
    out.push_back({k, "no trim"});
  }
  out.push_back({"semverisoneof", "4 trim"});
  out.push_back({"semverisnotoneof", "5 trim"});
  out.push_back({"semverless", "6 trim"});
  out.push_back({"semverlessequals", "7 trim"});
  out.push_back({"semvergreater", "8 trim"});
  out.push_back({"semvergreaterequals", "9 trim"});
  out.push_back({"numberequals", "10 trim"});
  out.push_back({"numbernotequals", "11 trim"});
  out.push_back({"numberless", "12 trim"});
  out.push_back({"numberlessequals", "13 trim"});
  out.push_back({"numbergreater", "14 trim"});
  out.push_back({"numbergreaterequals", "15 trim"});
  out.push_back({"datebefore", "18 trim"});
  out.push_back({"dateafter", "19 trim"});
  out.push_back({"containsanyof", "no trim"});
  out.push_back({"notcontainsanyof", "no trim"});
  return out;
}

std::vector<TrimCase> valueTrimmingDriver() {
  std::vector<TrimCase> out;
  for (const char* k : {"isoneof",
                        "isnotoneof",
                        "containsanyof",
                        "notcontainsanyof",
                        "isoneofhashed",
                        "isnotoneofhashed",
                        "equalshashed",
                        "notequalshashed",
                        "arraycontainsanyofhashed",
                        "arraynotcontainsanyofhashed",
                        "equals",
                        "notequals",
                        "startwithanyof",
                        "notstartwithanyof",
                        "endswithanyof",
                        "notendswithanyof",
                        "arraycontainsanyof",
                        "arraynotcontainsanyof",
                        "startwithanyofhashed",
                        "notstartwithanyofhashed",
                        "endswithanyofhashed",
                        "notendswithanyofhashed"}) {
    out.push_back({k, "no trim"});
  }
  out.push_back({"semverisoneof", "4 trim"});
  out.push_back({"semverisnotoneof", "5 trim"});
  out.push_back({"semverless", "6 trim"});
  out.push_back({"semverlessequals", "7 trim"});
  out.push_back({"semvergreater", "8 trim"});
  out.push_back({"semvergreaterequals", "9 trim"});
  return out;
}

}  // namespace

TEST_CASE("upstream corpus — attribute trimming", "[upstream_corpus]") {
  const json config = readJson("comparison_attribute_trimming.json");
  json custom = json::object();
  custom["Version"] = " 1.0.0 ";
  custom["Number"] = " 3 ";
  custom["Date"] = " 1705253400 ";
  auto user = makeUser(" 12345 ", custom);
  user->withCountry("[\" USA \"]");

  std::vector<std::string> failures;
  for (const auto& c : attributeTrimmingDriver()) {
    const EvalResult r = evaluate(&config, c.key, json("default"), user.get());
    if (r.value != json(c.expected)) {
      failures.push_back(c.key + ": actual=" + r.value.dump() + " expected=\"" + c.expected + "\"");
    }
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("upstream corpus — comparison-value trimming", "[upstream_corpus]") {
  const json config = readJson("comparison_value_trimming.json");
  json custom = json::object();
  custom["Version"] = "1.0.0";
  custom["Number"] = "3";
  custom["Date"] = "1705253400";
  auto user = makeUser("12345", custom);
  user->withCountry("[\"USA\"]");

  std::vector<std::string> failures;
  for (const auto& c : valueTrimmingDriver()) {
    const EvalResult r = evaluate(&config, c.key, json("default"), user.get());
    if (r.value != json(c.expected)) {
      failures.push_back(c.key + ": actual=" + r.value.dump() + " expected=\"" + c.expected + "\"");
    }
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

// Native-typed custom attributes must reach the numeric comparator and evaluate
// identically to their string spelling — exercises the conversion path with a
// non-stringified branch beyond the all-string matrix / eval-log cases.
TEST_CASE("upstream corpus — native numeric attr matches string form", "[upstream_corpus]") {
  const json config = json::parse(R"JSON({
    "p": {"u": "", "r": 0, "s": "salt"},
    "s": [],
    "f": {
      "numericGate": {
        "t": 1, "a": "Custom1", "v": {"s": "no-match"}, "i": "ng",
        "r": [{"c": [{"u": {"a": "Custom1", "c": 15, "d": 18.0}}], "s": {"v": {"s": "match"}, "i": "m"}}]
      }
    }
  })JSON");

  struct NCase {
    std::string label;
    json attr;
    std::string expected;
  };
  std::vector<NCase> cases = {
      {"native-int-pass", json(21), "match"},      {"native-float-pass", json(18.0), "match"},
      {"native-int-fail", json(17), "no-match"},   {"native-float-fail", json(17.999), "no-match"},
      {"string-int-pass", json("21"), "match"},    {"string-float-pass", json("18.0"), "match"},
      {"string-int-fail", json("17"), "no-match"},
  };

  std::vector<std::string> failures;
  for (const auto& c : cases) {
    json custom = json::object();
    custom["Custom1"] = c.attr;
    auto user = makeUser("12345", custom);
    const EvalResult r = evaluate(&config, "numericGate", json("default"), user.get());
    if (r.value != json(c.expected)) {
      failures.push_back(c.label + ": actual=" + r.value.dump() + " expected=\"" + c.expected +
                         "\"");
    }
  }
  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());
}

TEST_CASE("evaluationlog — byte-identical trace fidelity (#501)", "[upstream_corpus][trace]") {
  const auto path = confeature::tests::workspaceRoot() / "packages" / "test-fixtures-sdk-parity" /
                    "fixtures" / "parity-evaluationlog.json";
  const json tuples = json::parse(readText(path));
  REQUIRE(tuples.is_array());
  REQUIRE_FALSE(tuples.empty());

  std::unordered_map<std::string, int> seen;
  std::vector<std::string> failures;

  for (const auto& t : tuples) {
    if (!t.contains("expectedTrace") || !t["expectedTrace"].is_string()) {
      continue;
    }
    const std::string scenario = t.value("scenario", std::string());
    if (std::find(kTraceScenarios.begin(), kTraceScenarios.end(), scenario) ==
        kTraceScenarios.end()) {
      continue;
    }

    const std::string key = t.value("key", std::string());
    const json& config = t["config"];
    const int type = settingType(config, key);
    const json def =
        coerceDefault(t.contains("defaultValue") ? t["defaultValue"] : json(nullptr), type);
    const auto user = traceUser(t.contains("user") ? t["user"] : json());

    CaptureSink sink;
    evaluateTraced(&config, key, def, user.get(), &sink);

    std::string actual;
    for (std::size_t i = 0; i < sink.lines.size(); ++i) {
      if (i != 0) {
        actual += "\n";
      }
      actual += sink.lines[i];
    }

    seen[scenario]++;
    const std::string expected = t["expectedTrace"].get<std::string>();
    if (actual != expected) {
      std::ostringstream failure;
      failure << "trace mismatch for " << scenario << "/" << key << "\n--- want ---\n"
              << expected << "\n--- got ---\n"
              << actual;
      failures.push_back(failure.str());
    }
  }

  for (const auto& f : failures) {
    UNSCOPED_INFO(f);
  }
  REQUIRE(failures.empty());

  // Every trace-bearing scenario must have asserted >=1 tuple.
  for (const auto& scenario : kTraceScenarios) {
    INFO("scenario " << scenario);
    REQUIRE(seen[scenario] > 0);
  }
}
