// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_EVALUATOR_H_
#define CONFEATURE_INTERNAL_EVALUATOR_H_

// ConfigCat-parity flag evaluator over a parsed `config_v6.json` body
// (spec 130). Ports the spec-117 decision engine
// (`packages/sdk-shared/src/evaluator.ts` + comparators / semver / hash /
// segments / prerequisites) to C++.
//
// Fail-closed semantics (the pre-existing contract, preserved + extended to the
// targeting path): NEVER throws. Any reason a value can't be cleanly resolved —
// including a residual nlohmann type error or a detected prerequisite cycle —
// returns the supplied default + a tier-0 error code.
//
// Supported SettingType discriminators (matching
// `packages/sdk-shared/src/config-json.ts`):
//   - t = 0 Bool   → reads v.b, expects a json boolean default.
//   - t = 1 String → reads v.s, expects a json string default.
//   - t = 2 Int    → reads v.i, expects a json integer default.
//   - t = 3 Double → reads v.d, expects a json number default (int or float).
//
// Tier-0 error codes (preserved from the v1 evaluator, SC-006):
//   NO_CONFIG / MALFORMED_CONFIG / KEY_NOT_FOUND / TYPE_MISMATCH /
//   MALFORMED_VALUE / VALUE_NOT_BOOL / UNSUPPORTED_TYPE / EVAL_ERROR.

#include <nlohmann/json.hpp>
#include <string>

#include "confeature/user.h"
#include "internal/eval_log.h"

namespace confeature::internal {

// Numeric tags for the four `SettingType` discriminators, mirroring
// `packages/sdk-shared/src/config-json.ts`.
inline constexpr int kSettingTypeBool = 0;
inline constexpr int kSettingTypeString = 1;
inline constexpr int kSettingTypeInt = 2;
inline constexpr int kSettingTypeDouble = 3;

struct EvalResult {
  nlohmann::json value;
  std::string error;
  std::string variationId;
  // Matched-rule / matched-option identity (spec 130, FR-011). `hasMatchedRule`
  // is true when a targeting rule decided the value; `hasMatchedOption` is true
  // when a percentage option decided it. The public `EvaluationDetails`
  // placeholders are populated from these flags.
  bool hasMatchedRule{false};
  bool hasMatchedOption{false};
  // First surfaced condition error (missing user / missing attribute /
  // validation) when evaluation still resolved to a served value (FR-016).
  // Informational — does NOT make the result a default-value fallback.
  std::string evalError;
};

// Evaluates `key` against `config` for the optional `user` (nullptr = no user).
// NEVER throws — every failure path returns the supplied `defaultValue`.
//
// `config` may be `nullptr` (NO_CONFIG branch). `defaultValue` is returned
// verbatim on every fail branch.
EvalResult evaluate(const nlohmann::json* config, const std::string& key,
                    const nlohmann::json& defaultValue, const User* user = nullptr);

// `evaluate` with an optional eval-log trace sink (ADR 0003 / epic #494, #501).
// When the sink is INFO-enabled it drives the ConfigCat byte-identical
// evaluation-log trace: the WARN 3001/3003/3004 + ERROR 1002 lines emitted
// during the walk, and the final INFO 5000 multi-line indented trace. A
// `nullptr` sink (the hot path) is zero-cost — identical behaviour to
// `evaluate`.
EvalResult evaluateTraced(const nlohmann::json* config, const std::string& key,
                          const nlohmann::json& defaultValue, const User* user,
                          EvalTraceSink* sink);

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_EVALUATOR_H_
