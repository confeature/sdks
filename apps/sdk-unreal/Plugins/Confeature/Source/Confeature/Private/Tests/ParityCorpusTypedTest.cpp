// SPDX-License-Identifier: MIT

// Cross-language gate — typed tier: parity-corpus-typed.json (13 typed
// tuples) + parity-configs-typed.json drive every Confeature SDK's typed
// evaluator. Each SDK reconstructs an evaluation against the named
// typed config and asserts byte-identical output across the four
// `SettingType` slots (string / int / double — plus boolean, which is
// re-covered by the sibling Confeature.Parity.Corpus58 over the larger
// 58-tuple boolean corpus). Diverging here breaks Principle II.
//
// The UE port evaluates against an FJsonObject (the parsed
// config_v6.typed.json) via the four-type Confeature::Internal::Evaluate
// — the same entrypoint the typed UFUNCTIONs call. Boolean tuples in
// the typed corpus (none today; the typed corpus covers string / int /
// double / TYPE_MISMATCH tuples only — A16) would still pass via the
// override path's Branch 7.
//
// Tuple-by-tuple classification — the typed corpus has no `kind` field;
// the loader inspects the tuple's `defaultValue` and `expected` JSON
// kinds to pick the typed default the evaluator receives. String
// defaults → FConfeatureDefaultValue::String. Number defaults: if the
// expected value carries a fractional part or `defaultValue` does
// (after parsing) → ::Double; otherwise → ::Int. Boolean defaults →
// ::Bool. The classification matches the per-language corpus loader
// pattern (sdk-rust's tuple.classify, sdk-go's switch on
// reflect.TypeOf(defaultValue)).

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "ConfeatureFlagOverrides.h"
#include "Internal/Evaluator.h"
#include "Internal/OverrideEval.h"
#include "Tests/TestPaths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureParityCorpusTypedTest, "Confeature.Parity.CorpusTyped",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	// Loads a JSON array fixture into the supplied out-array. Returns
	// false (with a logged error) on any parse failure. Mirrors the
	// boolean-tier loader in ParityCorpusTest.cpp.
	bool LoadJsonArray(FAutomationTestBase& Test, const FString& Path,
		TArray<TSharedPtr<FJsonValue>>& OutEntries)
	{
		FString Raw;
		if (!FFileHelper::LoadFileToString(Raw, *Path))
		{
			Test.AddError(FString::Printf(TEXT("Failed to read fixture file at %s"), *Path));
			return false;
		}
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		if (!FJsonSerializer::Deserialize(Reader, OutEntries))
		{
			Test.AddError(FString::Printf(TEXT("Failed to parse %s as JSON array"), *Path));
			return false;
		}
		return true;
	}

	// Re-serialises every override value to its JSON representation so
	// OverrideEval can re-parse it via FJsonSerializer — preserving the
	// on-the-wire round-trip the other SDKs use.
	TMap<FString, FString> BuildOverrideMap(const TSharedPtr<FJsonObject>& Source)
	{
		TMap<FString, FString> Out;
		if (!Source.IsValid())
		{
			return Out;
		}
		for (const auto& Pair : Source->Values)
		{
			FString Serialised;
			const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Serialised);
			FJsonSerializer::Serialize(Pair.Value.ToSharedRef(), TEXT(""), Writer);
			Out.Add(Pair.Key, Serialised);
		}
		return Out;
	}

	// Classifies a tuple's `defaultValue` + `expected` into the typed
	// default kind the evaluator should receive. UE's FJsonValue has
	// `EJson::Boolean`, `EJson::String`, and a single `EJson::Number`
	// for both int and double — the int-vs-double disambiguation uses
	// the textual presence of a fractional part in the original JSON
	// (preserved via FJsonValue::TryGetNumber + FMath::Frac inspection).
	Confeature::Internal::FConfeatureDefaultValue BuildTypedDefault(
		const TSharedPtr<FJsonValue>& DefaultVal, const TSharedPtr<FJsonValue>& ExpectedVal)
	{
		using namespace Confeature::Internal;
		if (!DefaultVal.IsValid())
		{
			return FConfeatureDefaultValue::Bool(false);
		}
		if (DefaultVal->Type == EJson::Boolean)
		{
			bool V = false;
			DefaultVal->TryGetBool(V);
			return FConfeatureDefaultValue::Bool(V);
		}
		if (DefaultVal->Type == EJson::String)
		{
			FString V;
			DefaultVal->TryGetString(V);
			return FConfeatureDefaultValue::String(V);
		}
		if (DefaultVal->Type == EJson::Number)
		{
			double V = 0.0;
			DefaultVal->TryGetNumber(V);
			// Use the EXPECTED value's number-kind to disambiguate the
			// caller's intent — a `defaultValue: 0` paired with
			// `expected: 0.25` means the caller is asking for a double
			// (matching the per-language corpus pattern); a
			// `defaultValue: -1` paired with `expected: 5` means int.
			bool ExpectFractional = false;
			if (ExpectedVal.IsValid() && ExpectedVal->Type == EJson::Number)
			{
				double E = 0.0;
				ExpectedVal->TryGetNumber(E);
				ExpectFractional = FMath::Frac(E) != 0.0;
			}
			if (ExpectFractional || FMath::Frac(V) != 0.0)
			{
				return FConfeatureDefaultValue::Double(V);
			}
			return FConfeatureDefaultValue::Int(static_cast<int32>(V));
		}
		// Null or array/object — treat as bool false; the corpus does
		// not exercise these paths.
		return FConfeatureDefaultValue::Bool(false);
	}

	// Re-wraps a resolved typed FEvalResult as an FJsonValue so it can be
	// compared byte-stable against the corpus's `expected` field via the
	// JSON serializer (same idiom as ParityCorpusTest.cpp).
	TSharedRef<FJsonValue> WrapResult(
		const Confeature::Internal::FEvalResult& Result, const TSharedPtr<FJsonValue>& DefaultVal)
	{
		using namespace Confeature::Internal;
		// On any error (TYPE_MISMATCH / MALFORMED_VALUE / KEY_NOT_FOUND
		// / NO_CONFIG / MALFORMED_CONFIG / UNSUPPORTED_TYPE), the
		// evaluator returns the caller's default — re-wrap the default
		// JSON value directly so the byte-comparison is symmetric.
		if (!Result.Error.IsEmpty())
		{
			return DefaultVal.IsValid() ? DefaultVal.ToSharedRef()
										: StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueNull>());
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
				return MakeShared<FJsonValueNull>();
		}
	}
}

bool FConfeatureParityCorpusTypedTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping ParityCorpusTypedTest: packages/test-fixtures-sdk-parity/fixtures not "
				 "found relative to ProjectDir()."));
		return true;
	}

	TArray<TSharedPtr<FJsonValue>> Corpus;
	TArray<TSharedPtr<FJsonValue>> Configs;
	if (!LoadJsonArray(
			*this, FPaths::Combine(FixturesDir, TEXT("parity-corpus-typed.json")), Corpus))
	{
		return false;
	}
	if (!LoadJsonArray(
			*this, FPaths::Combine(FixturesDir, TEXT("parity-configs-typed.json")), Configs))
	{
		return false;
	}

	TestEqual(TEXT("corpus size"), Corpus.Num(), 13);

	// Build a configId → (config FJsonObject, overrides map) index.
	TMap<FString, TSharedPtr<FJsonObject>> ConfigById;
	TMap<FString, TMap<FString, FString>> OverridesById;
	for (const TSharedPtr<FJsonValue>& Entry : Configs)
	{
		const TSharedPtr<FJsonObject>* Obj = nullptr;
		if (!Entry.IsValid() || !Entry->TryGetObject(Obj))
		{
			continue;
		}
		FString Id;
		(*Obj)->TryGetStringField(TEXT("id"), Id);
		const TSharedPtr<FJsonObject>* ConfigObj = nullptr;
		if ((*Obj)->TryGetObjectField(TEXT("config"), ConfigObj))
		{
			ConfigById.Add(Id, *ConfigObj);
		}
		const TSharedPtr<FJsonObject>* OverridesObj = nullptr;
		if ((*Obj)->TryGetObjectField(TEXT("overridesMap"), OverridesObj))
		{
			OverridesById.Add(Id, BuildOverrideMap(*OverridesObj));
		}
	}

	int32 Passed = 0;
	for (const TSharedPtr<FJsonValue>& TupleVal : Corpus)
	{
		const TSharedPtr<FJsonObject>* TupleObj = nullptr;
		if (!TupleVal.IsValid() || !TupleVal->TryGetObject(TupleObj))
		{
			continue;
		}
		FString ConfigId;
		FString Key;
		FString Description;
		(*TupleObj)->TryGetStringField(TEXT("configId"), ConfigId);
		(*TupleObj)->TryGetStringField(TEXT("key"), Key);
		(*TupleObj)->TryGetStringField(TEXT("description"), Description);

		const TSharedPtr<FJsonValue> DefaultVal = (*TupleObj)->TryGetField(TEXT("defaultValue"));
		const TSharedPtr<FJsonValue> ExpectedVal = (*TupleObj)->TryGetField(TEXT("expected"));
		if (!DefaultVal.IsValid() || !ExpectedVal.IsValid())
		{
			AddError(FString::Printf(TEXT("Tuple missing default/expected: %s"), *Description));
			continue;
		}

		const TSharedPtr<FJsonObject>* ConfigPtr = ConfigById.Find(ConfigId);
		if (ConfigPtr == nullptr || !ConfigPtr->IsValid())
		{
			AddError(FString::Printf(TEXT("Unknown configId: %s"), *ConfigId));
			continue;
		}

		FConfeatureFlagOverrides Overrides;
		if (const TMap<FString, FString>* MapPtr = OverridesById.Find(ConfigId))
		{
			Overrides = FConfeatureFlagOverrides::MakeLocalOnly(*MapPtr);
		}

		// Override-eval first; on no resolution, fall through to the
		// typed evaluator path against the parsed config.
		const FOverrideEvalResult Eval = EvaluateSync(
			Overrides.Map.Num() > 0 ? &Overrides : nullptr, Key, DefaultVal.ToSharedRef());

		TSharedRef<FJsonValue> Actual = MakeShared<FJsonValueNull>();
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			Actual = Eval.Value.ToSharedRef();
		}
		else
		{
			const FConfeatureDefaultValue TypedDefault = BuildTypedDefault(DefaultVal, ExpectedVal);
			const FEvalResult Result = Evaluate(*ConfigPtr, Key, TypedDefault);
			Actual = WrapResult(Result, DefaultVal);
		}

		FString ActualStr;
		FString ExpectedStr;
		const TSharedRef<TJsonWriter<>> AW = TJsonWriterFactory<>::Create(&ActualStr);
		const TSharedRef<TJsonWriter<>> EW = TJsonWriterFactory<>::Create(&ExpectedStr);
		FJsonSerializer::Serialize(Actual, TEXT(""), AW);
		FJsonSerializer::Serialize(ExpectedVal.ToSharedRef(), TEXT(""), EW);

		if (!TestEqual(FString::Printf(TEXT("tuple: %s"), *Description), ActualStr, ExpectedStr))
		{
			continue;
		}
		++Passed;
	}

	TestEqual(TEXT("tuples passed"), Passed, 13);
	return Passed == 13;
}
