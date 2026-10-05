// SPDX-License-Identifier: MIT

// Branch-by-branch verification of the 7-branch override-eval tree.
// Each test case targets exactly one branch so a regression points
// directly at the failing limb.

#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"

#include "ConfeatureFlagOverrides.h"
#include "Internal/OverrideEval.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FConfeatureOverrideEvalTest,
	"Confeature.OverrideEval.Branches",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	FConfeatureFlagOverrides MakeLocalOnly(const TMap<FString, FString>& Map)
	{
		return FConfeatureFlagOverrides::MakeLocalOnly(Map);
	}

	bool AsBool(const Confeature::Internal::FOverrideEvalResult& Result, bool Fallback)
	{
		if (!Result.Value.IsValid())
		{
			return Fallback;
		}
		bool Out = Fallback;
		Result.Value->TryGetBool(Out);
		return Out;
	}
}

bool FConfeatureOverrideEvalTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;
	const TSharedRef<FJsonValue> DefaultFalse = MakeShared<FJsonValueBoolean>(false);
	const TSharedRef<FJsonValue> DefaultTrue = MakeShared<FJsonValueBoolean>(true);
	const TSharedRef<FJsonValue> DefaultNull = MakeShared<FJsonValueNull>();

	// Branch 1: nullptr overrides — fall through.
	{
		const FOverrideEvalResult R = EvaluateSync(nullptr, TEXT("k"), DefaultFalse);
		TestFalse(TEXT("Branch 1: bResolved"), R.bResolved);
	}

	// Branch 2: non-LocalOnly behaviour falls through.
	{
		FConfeatureFlagOverrides Overrides;
		Overrides.Behaviour = EConfeatureOverrideBehaviour::LocalOverRemote;
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultFalse);
		TestFalse(TEXT("Branch 2: bResolved"), R.bResolved);
	}

	// Branch 3: empty map — no synchronous data — falls through.
	{
		FConfeatureFlagOverrides Overrides = MakeLocalOnly({});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultFalse);
		TestFalse(TEXT("Branch 3: bResolved"), R.bResolved);
	}

	// Branch 4: absent key — returns default.
	{
		FConfeatureFlagOverrides Overrides = MakeLocalOnly({{TEXT("other"), TEXT("true")}});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("missing"), DefaultFalse);
		TestTrue(TEXT("Branch 4: bResolved"), R.bResolved);
		TestEqual(TEXT("Branch 4: value == default"), AsBool(R, true), false);
	}

	// Branch 5: null override — returns default.
	{
		FConfeatureFlagOverrides Overrides = MakeLocalOnly({{TEXT("k"), TEXT("null")}});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultTrue);
		TestTrue(TEXT("Branch 5: bResolved"), R.bResolved);
		TestEqual(TEXT("Branch 5: value == default"), AsBool(R, false), true);
	}

	// Branch 6: type mismatch — returns default.
	{
		FConfeatureFlagOverrides Overrides =
			MakeLocalOnly({{TEXT("k"), TEXT("\"string-value\"")}});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultTrue);
		TestTrue(TEXT("Branch 6: bResolved"), R.bResolved);
		TestEqual(TEXT("Branch 6: value == default"), AsBool(R, false), true);
	}

	// Branch 6 escape: null default bypasses the type check.
	{
		FConfeatureFlagOverrides Overrides =
			MakeLocalOnly({{TEXT("k"), TEXT("\"string-value\"")}});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultNull);
		TestTrue(TEXT("Branch 6 escape: bResolved"), R.bResolved);
		TestTrue(TEXT("Branch 6 escape: value carries string"), R.Value.IsValid());
		FString Out;
		if (R.Value.IsValid())
		{
			R.Value->TryGetString(Out);
		}
		TestEqual(TEXT("Branch 6 escape: value == 'string-value'"), Out, TEXT("string-value"));
	}

	// Branch 7: happy path.
	{
		FConfeatureFlagOverrides Overrides = MakeLocalOnly({{TEXT("k"), TEXT("true")}});
		const FOverrideEvalResult R = EvaluateSync(&Overrides, TEXT("k"), DefaultFalse);
		TestTrue(TEXT("Branch 7: bResolved"), R.bResolved);
		TestEqual(TEXT("Branch 7: value == override"), AsBool(R, false), true);
	}

	return true;
}
