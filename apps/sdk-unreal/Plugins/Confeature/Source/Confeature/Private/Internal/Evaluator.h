// SPDX-License-Identifier: MIT
#pragma once

// Four-type flag evaluator — pure function over a parsed `config_v6.json`
// body (an `FJsonObject`).
//
// Port of `apps/sdk-elixir/lib/confeature/internal/evaluator.ex` /
// `apps/sdk-node/src/eval.ts` / `packages/sdk-shared/src/evaluator.ts` /
// `apps/sdk-cpp/src/internal/evaluator.cpp`. Fail-closed semantics: any
// reason a typed value can't be cleanly resolved returns the supplied
// default + an error code.
//
// Semantics — `SettingType × default kind` matrix:
// - key present + setting type matches default's kind → cached value:
//     * t=0 (boolean) → read `v.b`, default kind must be `Bool`.
//     * t=1 (string)  → read `v.s`, default kind must be `String`.
//     * t=2 (int)     → read `v.i`, default kind must be `Int`.
//     * t=3 (double)  → read `v.d`, default kind must be `Double`.
// - key absent                    → default with KEY_NOT_FOUND.
// - default kind mismatches `t`   → default with TYPE_MISMATCH.
// - genuinely unknown `t` (>=4 or
//   negative / non-numeric)        → default with UNSUPPORTED_TYPE.
// - setting value slot malformed   → default with VALUE_NOT_BOOL (t=0)
//                                    or MALFORMED_VALUE (t=1/2/3).
// - config is null                 → default with NO_CONFIG.
// - malformed config               → default with MALFORMED_CONFIG.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Templates/SharedPointer.h"

#include "ConfeatureUser.h"

namespace Confeature::Internal
{
	// Numeric tags for the four `SettingType` discriminators, mirroring
	// `SettingType.{Bool,String,Int,Double}` from
	// `packages/sdk-shared/src/config-json.ts`.
	inline constexpr int32 SettingTypeBool = 0;
	inline constexpr int32 SettingTypeString = 1;
	inline constexpr int32 SettingTypeInt = 2;
	inline constexpr int32 SettingTypeDouble = 3;

	// Sentinel `Kind` for a NULL default — mirrors the C++ port's `json(nullptr)`
	// default (and the TS evaluator's `defaultValue !== null` guard). A null
	// default OPTS OUT of the type-mismatch guard so the served value +
	// variationId resolve regardless of the flag's declared `t` — exactly how
	// `getValueDetails(key, null)` / the variationId corpus matrix is replayed
	// (FR-011). Never passed by the public typed accessors; additive only.
	inline constexpr int32 SettingTypeNull = -1;

	// Typed default — the caller specifies which typed slot it wants the
	// evaluator to resolve. Mirrors the per-language typed-default
	// machinery every other Confeature SDK uses (Elixir's polymorphic
	// `default_value`, Go's `any`, Rust's generic `T`, .NET's typed
	// overloads). The `Kind` discriminator drives the TYPE_MISMATCH check.
	struct FConfeatureDefaultValue
	{
		int32 Kind = SettingTypeBool;
		bool BoolValue = false;
		FString StringValue;
		int32 IntValue = 0;
		double DoubleValue = 0.0;

		static FConfeatureDefaultValue Bool(bool V);
		static FConfeatureDefaultValue String(const FString& V);
		static FConfeatureDefaultValue Int(int32 V);
		static FConfeatureDefaultValue Double(double V);
		// A null/untyped default (opts out of the type-mismatch guard). Used by
		// the variationId corpus replay; not exposed via the public accessors.
		static FConfeatureDefaultValue Null();
	};

	// Tagged-union evaluation result. The active slot is identified by
	// `ResolvedType`; the others carry zero-values. The caller knows the
	// expected type from the default it passed (the UFUNCTION caller
	// side), so it reads the matching slot without runtime
	// type-switching. UE doesn't ship `std::variant`; the tagged-union is
	// the idiomatic UE-C++ equivalent.
	struct FEvalResult
	{
		int32 ResolvedType = SettingTypeBool;
		bool BoolValue = false;
		FString StringValue;
		int32 IntValue = 0;
		double DoubleValue = 0.0;
		FString Error;
		FString VariationId;
		// Matched-rule / matched-option identity (spec 131, FR-011).
		// bHasMatchedRule is true when a targeting rule decided the value;
		// bHasMatchedOption is true when a percentage option decided it. The
		// public EvaluationDetails placeholders are populated from these flags.
		bool bHasMatchedRule = false;
		bool bHasMatchedOption = false;
		// First surfaced condition error (missing user / missing attribute /
		// validation) when evaluation still resolved to a served value
		// (FR-016). Informational — does NOT make the result a default-value
		// fallback (Error stays empty in that case).
		FString EvalError;
	};

	// Evaluates `Key` against `Config` for the optional `User` (nullptr = no
	// user). NEVER throws — every failure path returns the supplied `Default`
	// (slot value) and an error code on the `Error` field.
	//
	// `Config` may be invalid (NO_CONFIG branch). `Default` is the typed
	// fallback returned verbatim on every fail branch — the caller's
	// `Kind` selects the resolved-value slot the evaluator looks at, and
	// the same slot is returned on TYPE_MISMATCH / MALFORMED_VALUE /
	// KEY_NOT_FOUND / NO_CONFIG / MALFORMED_CONFIG / UNSUPPORTED_TYPE /
	// EVAL_ERROR (a detected prerequisite cycle or residual JSON-shape error).
	CONFEATURE_API FEvalResult Evaluate(const TSharedPtr<FJsonObject>& Config, const FString& Key,
		const FConfeatureDefaultValue& Default, const FConfeatureUser* User = nullptr);
}
