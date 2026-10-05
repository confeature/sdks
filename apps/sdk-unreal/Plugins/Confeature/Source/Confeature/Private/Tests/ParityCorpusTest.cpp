// SPDX-License-Identifier: MIT

// Cross-language gate: parity-corpus.json + parity-configs.json drive
// every Confeature SDK. Each SDK reconstructs an evaluation against
// the named config and asserts byte-identical output. Diverging here
// breaks Principle II.
//
// The UE port evaluates against an FJsonObject (the parsed
// config_v6.json) via Confeature::Internal::Evaluate. This file drives
// the boolean tuples (58); the typed tuples (13) are driven by the
// sibling Confeature.Parity.CorpusTyped (ParityCorpusTypedTest.cpp).
// Non-boolean tuples in this corpus still pass because the override
// map (when present) echoes the cached value, so Branch 7 of the
// override-eval tree returns the expected payload.

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureParityCorpusTest,
	"Confeature.Parity.Corpus58",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	// Loads a JSON array fixture into the supplied out-array. Returns
	// false (with a logged error) on any parse failure.
	bool LoadJsonArray(
		FAutomationTestBase& Test,
		const FString& Path,
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

	// Builds a TMap<FString, FString> override map from a corpus
	// `overridesMap` object. Values are re-serialised to their JSON
	// representation so OverrideEval can re-parse them via FJsonSerializer
	// — preserving the on-the-wire round-trip the other SDKs use.
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
}

bool FConfeatureParityCorpusTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping ParityCorpusTest: packages/test-fixtures-sdk-parity/fixtures not "
				 "found relative to ProjectDir()."));
		return true;
	}

	TArray<TSharedPtr<FJsonValue>> Corpus;
	TArray<TSharedPtr<FJsonValue>> Configs;
	if (!LoadJsonArray(*this, FPaths::Combine(FixturesDir, TEXT("parity-corpus.json")), Corpus))
	{
		return false;
	}
	if (!LoadJsonArray(*this, FPaths::Combine(FixturesDir, TEXT("parity-configs.json")), Configs))
	{
		return false;
	}

	TestEqual(TEXT("corpus size"), Corpus.Num(), 58);

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

		// Wire up overrides exactly like the canonical TS gate so every
		// tuple exercises the same override-eval branch.
		FConfeatureFlagOverrides Overrides;
		if (const TMap<FString, FString>* MapPtr = OverridesById.Find(ConfigId))
		{
			Overrides = FConfeatureFlagOverrides::MakeLocalOnly(*MapPtr);
		}

		// Evaluate via the override-eval branch first; fall through to
		// the cache-backed evaluator when overrides yield no resolution.
		const FOverrideEvalResult Eval = EvaluateSync(
			Overrides.Map.Num() > 0 ? &Overrides : nullptr, Key, DefaultVal.ToSharedRef());

		TSharedPtr<FJsonValue> Actual;
		if (Eval.bResolved && Eval.Value.IsValid())
		{
			Actual = Eval.Value;
		}
		else
		{
			// Four-type evaluator handles the cached-config path. The
			// boolean parity gate drives only boolean tuples through this
			// branch (the non-boolean ones are corpus-fed via the
			// override path above); the typed-corpus tier (the sibling
			// Confeature.Parity.CorpusTyped) exercises the string / int
			// / double evaluator paths.
			bool DefaultBool = false;
			DefaultVal->TryGetBool(DefaultBool);
			const FEvalResult Result
				= Evaluate(*ConfigPtr, Key, FConfeatureDefaultValue::Bool(DefaultBool));
			Actual = MakeShared<FJsonValueBoolean>(Result.BoolValue);
		}

		FString ActualStr;
		FString ExpectedStr;
		const TSharedRef<TJsonWriter<>> AW = TJsonWriterFactory<>::Create(&ActualStr);
		const TSharedRef<TJsonWriter<>> EW = TJsonWriterFactory<>::Create(&ExpectedStr);
		FJsonSerializer::Serialize(Actual.ToSharedRef(), TEXT(""), AW);
		FJsonSerializer::Serialize(ExpectedVal.ToSharedRef(), TEXT(""), EW);

		if (!TestEqual(FString::Printf(TEXT("tuple: %s"), *Description), ActualStr, ExpectedStr))
		{
			continue;
		}
		++Passed;
	}

	TestEqual(TEXT("tuples passed"), Passed, 58);
	return Passed == 58;
}
