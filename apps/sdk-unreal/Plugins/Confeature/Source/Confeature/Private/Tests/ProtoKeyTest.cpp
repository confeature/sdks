// SPDX-License-Identifier: MIT

// #826 — ConfigCat reserves no setting key, so the api serves `__proto__` as
// an ordinary key of config_v6 `f`. A JS SDK once dropped it by copying
// settings into a plain object; this holds the Unreal SDK to keeping it from
// the served bytes (parsed exactly as the client parses a fetched body) and
// from a local override, through the two paths GetValue resolves with.
//
// unverified: no UE env. No Unreal Engine runtime exists in this environment
// or in CI, so this automation test has never been compiled or run.

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "ConfeatureFlagOverrides.h"
#include "Internal/Evaluator.h"
#include "Internal/OverrideEval.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureProtoKeyTest, "Confeature.ProtoKey",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureProtoKeyTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	// The served config_v6 flag keyed __proto__ resolves to its served value.
	{
		TSharedPtr<FJsonObject> Cfg;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(TEXT(
			"{\"p\":{\"u\":\"\",\"r\":0,\"s\":\"salt\"},"
			"\"f\":{\"__proto__\":{\"t\":0,\"v\":{\"b\":true},\"i\":\"v-proto\",\"r\":[]}},\"s\":[]}"));
		TestTrue(TEXT("served config parsed"), FJsonSerializer::Deserialize(Reader, Cfg));
		const FEvalResult R = Evaluate(Cfg, TEXT("__proto__"), FConfeatureDefaultValue::Bool(false));
		TestEqual(TEXT("served: value"), R.BoolValue, true);
		TestEqual(TEXT("served: variation id"), R.VariationId, TEXT("v-proto"));
		TestEqual(TEXT("served: no error"), R.Error, FString());
	}

	// A LocalOnly override keyed __proto__ resolves to the override.
	{
		FConfeatureFlagOverrides Overrides =
			FConfeatureFlagOverrides::MakeLocalOnly({{TEXT("__proto__"), TEXT("true")}});
		const TSharedRef<FJsonValue> DefaultFalse = MakeShared<FJsonValueBoolean>(false);
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("__proto__"), DefaultFalse);
		TestTrue(TEXT("override: bResolved"), R.bResolved);
		bool Value = false;
		TestTrue(TEXT("override: value is a bool"), R.Value.IsValid() && R.Value->TryGetBool(Value));
		TestEqual(TEXT("override: value"), Value, true);
	}

	return true;
}
