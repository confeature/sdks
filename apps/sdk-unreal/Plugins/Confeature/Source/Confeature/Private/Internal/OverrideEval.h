// SPDX-License-Identifier: MIT
#pragma once

// Synchronous override evaluation — 7-branch decision tree. Port of:
//   - packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync (TS canonical)
//   - apps/sdk-go/internal/overrideeval/eval.go:EvaluateSync
//   - apps/sdk-rust/src/internal/override_eval.rs:evaluate_sync
//   - apps/sdk-python/.../override_eval.py:evaluate_override_sync
//   - apps/sdk-cpp/src/internal/override_eval.cpp:evaluateSync
//
// Return semantics:
//   - {bResolved=false, Value=invalid} → caller falls through to the cache.
//   - {bResolved=true,  Value=...}     → resolved override result. The
//     LocalOnly contract guarantees the caller does NOT consult the
//     cache after Branch 4+ — the default value (Branches 4-6) or the
//     typed override (Branch 7) is what `GetValue*` returns.
//
// JSON encoding: override values arrive as JSON-serialised strings
// (e.g. `"true"`, `"42"`, `"hello"`). The evaluator parses each entry
// to an `FJsonValue` on demand so the same 7-branch tree the other
// 13 languages use applies byte-for-byte.

#include "CoreMinimal.h"
#include "Dom/JsonValue.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureFlagOverrides.h"
#include "ConfeatureUser.h"

namespace Confeature::Internal
{
	struct FOverrideEvalResult
	{
		bool bResolved = false;
		// The resolved value as an FJsonValue. The caller converts it
		// to the concrete primitive (bool / FString / int / float) via
		// the same type-check ladder the evaluator uses for cache hits.
		// Invalid (nullptr) when bResolved is false.
		TSharedPtr<FJsonValue> Value;

		// Spec 152 / #475 US2 — variationId propagation through the
		// override path (the #395 gap class). Empty on the flat-map
		// (value-only LocalOnly) path — upstream parity: the value-only
		// override surface carries no variationId. POPULATED on the
		// full-config path: the real evaluator computes the variationId
		// for the rule-bearing config, and the details surface MUST see
		// it. Mirrors the sdk-cpp `Snapshot::resolveJsonDetails`
		// full-config branch (apps/sdk-cpp/src/snapshot.cpp), itself the
		// #395-class fix applied across the federation.
		FString VariationId;
	};

	// Walks the 7-branch decision tree against `Overrides`.
	//
	// Algorithm — byte-identical to TS / Go / Rust / Python / C++ ports:
	//   1. Overrides == nullptr                            → (false, null)
	//   2. Behaviour != LocalOnly                          → (false, null)
	//   3. Map is empty (no synchronous data)              → (false, null)
	//   4. Key absent                                      → (true,  default)
	//   5. Raw value parses to null                        → (true,  default)
	//   6. type(candidate) != type(default), default != null → (true, default)
	//   7. Happy path                                      → (true,  candidate)
	CONFEATURE_API FOverrideEvalResult EvaluateSync(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue);

	// Full-config override resolution — port of the corpus-verified C++ #437
	// `evaluateFullConfigSync` (apps/sdk-cpp/src/internal/override_eval.cpp),
	// itself a port of the canonical TS `evaluateFullConfigOverrideSync`
	// (spec 135 / #441, epic #382, US3).
	//
	// When the override bundle carries a full-config source
	// (`FConfeatureFlagOverrides::IsFullConfig()`), resolves `Key` through the
	// real UE evaluator so targeting rules / segments / prerequisites /
	// percentage options apply offline — the rule-bearing sibling of
	// `EvaluateSync`'s flat lookup. `DefaultValue` (an `FJsonValue`) is mapped
	// to the typed `FConfeatureDefaultValue` the evaluator expects, and the
	// typed result is re-wrapped to an `FJsonValue` for the caller.
	//
	// Return semantics (mirror the C++ pair<bool, optional>):
	//   - {bResolved=false, Value=invalid} → overrides absent, behaviour
	//     non-LocalOnly, or the source is NOT a full-config source (caller
	//     falls through to the flat-map helper / normal eval).
	//   - {bResolved=true,  Value=...}     → the rule-resolved value
	//     (LocalOnly contract: the evaluator already returns the default for
	//     any non-clean resolution, preserving the contract).
	//
	// INV-4: the evaluator receives the FULL config blob (`{p, f, s}`) — salt
	// (`p.s`) + segments (`s`), never just `f` (the spec-129 dropped-salt
	// regression class).
	CONFEATURE_API FOverrideEvalResult EvaluateFullConfigSync(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue,
		const FConfeatureUser* User);

	// Shared override router — port of the corpus-verified C++ #437
	// `evaluateOverride` (apps/sdk-cpp/src/internal/override_eval.cpp), itself
	// a port of the canonical TS `evaluateOverride` (spec 135 / #441).
	//
	// Dispatches between the flat-map path and the full-config path so the
	// `GetValue*` call sites change minimally: a full-config source routes
	// through the real evaluator (with `User` threaded); every other source
	// (the value-only map) keeps the existing byte-identical flat-map
	// resolution (`EvaluateSync`).
	//
	// Dispatch is on the source TYPE (`IsFullConfig()`), not the resolved
	// value, so a full-config source whose evaluator returns the default still
	// stays on the rule path (never mis-read as value-only). Mirrors the C++
	// `dynamic_cast<const ConfigOverrideDataSource*>` type probe.
	CONFEATURE_API FOverrideEvalResult EvaluateOverride(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue,
		const FConfeatureUser* User);
}
