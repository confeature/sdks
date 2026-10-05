// SPDX-License-Identifier: MIT

#include "Internal/OverrideEval.h"

#include "Dom/JsonValue.h"
#include "Math/UnrealMathUtility.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/Evaluator.h"

namespace Confeature::Internal
{
	namespace
	{
		// Reports whether two FJsonValues share a kind for the
		// override-eval type-check. Numeric kinds (integer / float)
		// collapse to one kind — matches the canonical TS implementation
		// where `typeof 42 === typeof 42.5 === "number"`.
		bool SameJsonKind(const TSharedRef<FJsonValue>& A, const TSharedRef<FJsonValue>& B)
		{
			const EJson AT = A->Type;
			const EJson BT = B->Type;
			if (AT == BT)
			{
				return true;
			}
			// Number == Number is already covered by AT == BT. Add the
			// historical FJsonValueNumber vs FJsonValueNumberString
			// folding only if it ever surfaces — UE collapses all JSON
			// numbers into `EJson::Number` already.
			return false;
		}

		// Parses a JSON-serialised override value into an FJsonValue.
		// Returns nullptr when the raw payload is itself "null" or
		// fails to parse — Branch 5 in the canonical algorithm.
		TSharedPtr<FJsonValue> ParseOverrideValue(const FString& Raw)
		{
			// FJsonSerializer expects a top-level object/array; wrap
			// the raw value in a synthetic array so primitives parse
			// uniformly.
			const FString Wrapped = FString::Printf(TEXT("[%s]"), *Raw);
			TArray<TSharedPtr<FJsonValue>> Parsed;
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Wrapped);
			if (!FJsonSerializer::Deserialize(Reader, Parsed) || Parsed.Num() != 1)
			{
				return nullptr;
			}
			const TSharedPtr<FJsonValue>& First = Parsed[0];
			if (!First.IsValid() || First->Type == EJson::Null)
			{
				return nullptr;
			}
			return First;
		}
	}

	FOverrideEvalResult EvaluateSync(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue)
	{
		FOverrideEvalResult Out;

		// Branch 1.
		if (Overrides == nullptr)
		{
			return Out;
		}

		// Branch 2.
		if (Overrides->Behaviour != EConfeatureOverrideBehaviour::LocalOnly)
		{
			return Out;
		}

		// Branch 3: the UE override surface is a `TMap<FString, FString>`
		// — an empty map signals "no synchronous data" matching the
		// `nullopt` of the C++ port.
		if (Overrides->Map.Num() == 0)
		{
			return Out;
		}

		// From here we are committed to the LocalOnly contract — never
		// fall through.

		// Branch 4: key absent.
		const FString* Raw = Overrides->Map.Find(Key);
		if (Raw == nullptr)
		{
			Out.bResolved = true;
			Out.Value = DefaultValue;
			return Out;
		}

		// Branch 5: raw value parses to null.
		const TSharedPtr<FJsonValue> Candidate = ParseOverrideValue(*Raw);
		if (!Candidate.IsValid())
		{
			Out.bResolved = true;
			Out.Value = DefaultValue;
			return Out;
		}

		// Branch 6: TYPE_MISMATCH. A null default bypasses the check
		// (matches the TS `defaultValue !== null` semantics).
		if (DefaultValue->Type != EJson::Null && !SameJsonKind(Candidate.ToSharedRef(), DefaultValue))
		{
			Out.bResolved = true;
			Out.Value = DefaultValue;
			return Out;
		}

		// Branch 7: happy path.
		Out.bResolved = true;
		Out.Value = Candidate;
		return Out;
	}

	namespace
	{
		// Maps the caller's `FJsonValue` default to the typed
		// `FConfeatureDefaultValue` the evaluator expects. The full-config
		// router receives the SAME default the public `GetValue*` wrapped
		// (FJsonValueBoolean / String / Number), so the kind is recovered
		// directly from the FJsonValue's `Type` — no expected-value
		// disambiguation is needed (unlike the typed-corpus loader, which has
		// no caller-side type). EJson::Number is split int-vs-double by the
		// presence of a fractional part (FMath::Frac), matching the
		// per-language number disambiguation.
		FConfeatureDefaultValue DefaultFromJson(const TSharedRef<FJsonValue>& DefaultValue)
		{
			switch (DefaultValue->Type)
			{
				case EJson::Boolean:
				{
					bool V = false;
					DefaultValue->TryGetBool(V);
					return FConfeatureDefaultValue::Bool(V);
				}
				case EJson::String:
				{
					FString V;
					DefaultValue->TryGetString(V);
					return FConfeatureDefaultValue::String(V);
				}
				case EJson::Number:
				{
					double V = 0.0;
					DefaultValue->TryGetNumber(V);
					if (FMath::Frac(V) != 0.0)
					{
						return FConfeatureDefaultValue::Double(V);
					}
					return FConfeatureDefaultValue::Int(static_cast<int32>(V));
				}
				default:
					// Null / array / object → null default (opts out of the
					// type-mismatch guard), matching the evaluator's
					// SettingTypeNull path.
					return FConfeatureDefaultValue::Null();
			}
		}

		// Re-wraps a typed FEvalResult as an FJsonValue. On any error the
		// evaluator already returns the caller's default slot — re-wrap the
		// original default JSON directly so the round-trip is byte-symmetric
		// (identical idiom to ParityCorpusTypedTest::WrapResult).
		TSharedPtr<FJsonValue> WrapEvalResult(
			const FEvalResult& Result, const TSharedRef<FJsonValue>& DefaultValue)
		{
			if (!Result.Error.IsEmpty())
			{
				return DefaultValue;
			}
			switch (Result.ResolvedType)
			{
				case SettingTypeBool:
					return MakeShared<FJsonValueBoolean>(Result.BoolValue);
				case SettingTypeString:
					return MakeShared<FJsonValueString>(Result.StringValue);
				case SettingTypeInt:
					return MakeShared<FJsonValueNumber>(static_cast<double>(Result.IntValue));
				case SettingTypeDouble:
					return MakeShared<FJsonValueNumber>(Result.DoubleValue);
				default:
					return DefaultValue;
			}
		}
	}

	FOverrideEvalResult EvaluateFullConfigSync(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue,
		const FConfeatureUser* User)
	{
		FOverrideEvalResult Out;

		// Mirror the C++ guard ladder: absent overrides, non-LocalOnly, or a
		// non-full-config source → unhandled (caller falls through).
		if (Overrides == nullptr)
		{
			return Out;
		}
		if (Overrides->Behaviour != EConfeatureOverrideBehaviour::LocalOnly)
		{
			return Out;
		}
		if (!Overrides->IsFullConfig() || !Overrides->ConfigSource.IsValid())
		{
			return Out;
		}

		// Pass the FULL config blob (salt `p.s` + segments `s` + rule-bearing
		// `f`), never just `f` (INV-4). The evaluator never throws — any
		// failure resolves to the caller's default (re-wrapped below).
		const FConfeatureDefaultValue TypedDefault = DefaultFromJson(DefaultValue);
		const FEvalResult Result
			= Evaluate(Overrides->ConfigSource->Config(), Key, TypedDefault, User);

		Out.bResolved = true;
		Out.Value = WrapEvalResult(Result, DefaultValue);
		// Spec 152 / #475 US2 — propagate the variationId the real evaluator
		// computed for the rule-bearing config into the override result (the
		// #395 gap class). Only on a clean resolution: an error branch already
		// re-wraps the default and carries no variationId, exactly like the
		// sdk-cpp `resolveJsonDetails` full-config branch.
		if (Result.Error.IsEmpty())
		{
			Out.VariationId = Result.VariationId;
		}
		return Out;
	}

	FOverrideEvalResult EvaluateOverride(
		const FConfeatureFlagOverrides* Overrides,
		const FString& Key,
		const TSharedRef<FJsonValue>& DefaultValue,
		const FConfeatureUser* User)
	{
		// Full-config source → ALWAYS resolve through the evaluator; NEVER
		// fall through to the flat-map path (which would mis-read rule-bearing
		// settings as value-only). Dispatch on the source TYPE, not the
		// resolved value — the C++ `dynamic_cast` probe's UE equivalent.
		if (Overrides != nullptr
			&& Overrides->Behaviour == EConfeatureOverrideBehaviour::LocalOnly
			&& Overrides->IsFullConfig())
		{
			return EvaluateFullConfigSync(Overrides, Key, DefaultValue, User);
		}
		// Every other source (the value-only map) keeps the byte-identical
		// flat-map path.
		return EvaluateSync(Overrides, Key, DefaultValue);
	}
}
