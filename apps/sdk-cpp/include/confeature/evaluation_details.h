// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_EVALUATION_DETAILS_H_
#define CONFEATURE_EVALUATION_DETAILS_H_

// Spec 085 / #266 slice 7/12 — typed evaluation-details envelope.
//
// `EvaluationDetails<T>` mirrors the shape exposed by upstream
// `configcat-cpp` v4 (`configcat::EvaluationDetails<T>`). A migrating
// consumer reads `details.key`, `details.value`, `details.error`, etc.
// off the same field names + types.
//
// v1 surface deliberately keeps `TargetingRule` + `PercentageOption` as
// empty placeholder structs — the v1 evaluator never matches a rule or
// a percentage option, so the matched-* fields are always
// `std::nullopt`. Future work fills these in alongside evaluator
// upgrades (out of #266 scope).

#include <cstdint>
#include <optional>
#include <string>

#include "confeature/user.h"

namespace confeature {

// v1 evaluator never matches a targeting rule. Reserved for the
// targeting-rule follow-on (out of #266 scope) — the field exists so
// migrating consumers can pattern-match without an `#ifdef`.
struct TargetingRule {};

// v1 evaluator never matches a percentage option. Reserved for the
// percentage-option follow-on (out of #266 scope) — see above.
struct PercentageOption {};

// Evaluation envelope returned by `ConfeatureClient::getValueDetails<T>`
// and `Snapshot::getValueDetails<T>`. POD with member initializers — no
// constructor; callers brace-initialise.
//
// Field semantics (mirroring `configcat::EvaluationDetails<T>`):
//   - `key`                          — the flag key requested.
//   - `value`                        — the resolved value, or
//                                       `defaultValue` on any failure.
//   - `variationId`                  — variation ID (`v.i`); always
//                                       `std::nullopt` on v1 fail
//                                       paths and on override hits.
//   - `fetchTimeUnixMillis`          — wall-clock epoch-millis of the
//                                       last successful fetch (or
//                                       cache restore). `0` if the
//                                       client never observed config.
//   - `user`                         — the user supplied to the call,
//                                       or the builder-configured
//                                       default user, or
//                                       `std::nullopt` if neither.
//   - `isDefaultValue`               — `true` whenever the resolver
//                                       fell back to `defaultValue`
//                                       (every error branch, every
//                                       closed-client read, every
//                                       LocalOnly-miss).
//   - `error`                        — error code string (e.g.
//                                       `KEY_NOT_FOUND`,
//                                       `TYPE_MISMATCH`,
//                                       `CLIENT_CLOSED`) or
//                                       `std::nullopt` on success.
//   - `matchedTargetingRule`         — always `std::nullopt` in v1.
//   - `matchedPercentageOption`      — always `std::nullopt` in v1.
template <typename T>
struct EvaluationDetails {
  std::string key;
  T value;
  std::optional<std::string> variationId;
  std::int64_t fetchTimeUnixMillis{};
  std::optional<User> user;
  bool isDefaultValue{};
  std::optional<std::string> error;
  std::optional<TargetingRule> matchedTargetingRule;
  std::optional<PercentageOption> matchedPercentageOption;
};

}  // namespace confeature

#endif  // CONFEATURE_EVALUATION_DETAILS_H_
