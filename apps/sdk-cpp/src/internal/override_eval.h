// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_OVERRIDE_EVAL_H_
#define CONFEATURE_INTERNAL_OVERRIDE_EVAL_H_

// Synchronous override evaluation — 7-branch decision tree. Port of:
//   - packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync (TS canonical)
//   - apps/sdk-go/internal/overrideeval/eval.go:EvaluateSync
//   - apps/sdk-rust/src/internal/override_eval.rs:evaluate_sync
//   - apps/sdk-python/.../override_eval.py:evaluate_override_sync
//
// Return semantics:
//   - {false, std::nullopt}        → caller falls through to the cache.
//   - {true,  std::optional<json>} → resolved override result (possibly
//     the supplied default — Branches 4-6 honour the LocalOnly contract:
//     never fall through). Branch 7 returns the typed override value.

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <utility>

#include "confeature/flag_overrides.h"
#include "confeature/user.h"

namespace confeature::internal {

// Walks the 7-branch decision tree against `overrides`.
//
// Algorithm — byte-identical to TS / Go / Rust / Python ports:
//   1. overrides == nullptr                            → (false, nullopt)
//   2. behaviour != LocalOnly                          → (false, nullopt)
//   3. dataSource->getOverridesSync() == nullopt       → (false, nullopt)
//   4. key absent                                      → (true, default)
//   5. raw value is null                               → (true, default)
//   6. type(candidate) != type(default), default != null → (true, default)
//   7. happy path                                      → (true, candidate)
std::pair<bool, std::optional<nlohmann::json>> evaluateSync(const FlagOverrides* overrides,
                                                            const std::string& key,
                                                            const nlohmann::json& defaultValue);

// Full-config override resolution — port of the canonical TS
// `evaluateFullConfigOverrideSync` (spec 135 / #437, epic #382, US3),
// mirroring sdk-python's `evaluate_full_config_override_sync` and sdk-dart's
// `evaluateFullConfigOverrideSync`.
//
// When the override source is a `ConfigOverrideDataSource`, resolves `key`
// through the real C++ evaluator so targeting rules / segments / prerequisites
// / percentage options apply offline — the rule-bearing sibling of
// `evaluateSync`'s flat lookup.
//
// Return semantics:
//   - {false, std::nullopt} → overrides absent, behaviour non-LocalOnly, or
//     the source is NOT a full-config source (caller falls through to the
//     flat-map helper / normal eval).
//   - {true,  value}        → the rule-resolved value (LocalOnly contract:
//     never fall through — the evaluator already returns `defaultValue` for
//     any non-clean resolution, preserving the contract).
//
// INV-4: the evaluator receives the FULL config blob (`{p, f, s}`) — salt
// (`p.s`) + segments (`s`), never just `f` (the spec-129 dropped-salt
// regression class).
std::pair<bool, std::optional<nlohmann::json>> evaluateFullConfigSync(
    const FlagOverrides* overrides, const std::string& key, const nlohmann::json& defaultValue,
    const User* user);

// Shared override router — port of the canonical TS `evaluateOverride`
// (spec 135 / #437), mirroring sdk-python's `evaluate_override` and sdk-dart's
// `evaluateOverride`.
//
// Dispatches between the flat-map path and the full-config path so the
// `getValue` call sites change minimally: a `ConfigOverrideDataSource` routes
// through the real evaluator (with `user` threaded); every other source (map /
// custom) keeps the existing byte-identical flat-map resolution
// (`evaluateSync`).
//
// Dispatch is on the source TYPE, not the resolved value, so a full-config
// source whose evaluator returns the default still stays on the rule path
// (never mis-read as value-only).
std::pair<bool, std::optional<nlohmann::json>> evaluateOverride(const FlagOverrides* overrides,
                                                                const std::string& key,
                                                                const nlohmann::json& defaultValue,
                                                                const User* user);

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_OVERRIDE_EVAL_H_
