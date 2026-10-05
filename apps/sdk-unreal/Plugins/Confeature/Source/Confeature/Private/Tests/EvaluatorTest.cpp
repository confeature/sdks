// SPDX-License-Identifier: MIT

// Unit-level guard rails for the four-type evaluator. Every fail branch
// is exercised so any regression points directly at the offending code
// path. The boolean tier is byte-stable (FR-010 / SC-004): the one
// deliberate reshape is the `UNSUPPORTED_TYPE` boundary — the
// pre-existing "UNSUPPORTED_TYPE for t:1" assertion is reshaped to
// assert `UNSUPPORTED_TYPE` only for a TRULY unknown `t` (e.g. `t = 99`)
// because `t = 1` is now a legitimate `string` setting type (FR-003).

#include "Dom/JsonObject.h"
#include "Misc/AutomationTest.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "Internal/Evaluator.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureEvaluatorTest, "Confeature.Evaluator.Typed",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	TSharedPtr<FJsonObject> ParseConfig(const FString& Json)
	{
		TSharedPtr<FJsonObject> Out;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
		FJsonSerializer::Deserialize(Reader, Out);
		return Out;
	}

	TSharedPtr<FJsonObject> SampleConfig()
	{
		// Settings spanning all four types plus a genuinely unknown
		// discriminator:
		//   - feature.on        → boolean true.
		//   - feature.off       → boolean false, with variation id "v-off".
		//   - feature.string    → string "hello".
		//   - feature.int       → int 5.
		//   - feature.double    → double 0.25.
		//   - feature.precision → double 0.30000000000000004 (IEEE-754).
		//   - feature.unknown   → t = 99 (UNSUPPORTED_TYPE branch).
		const FString Body = TEXT(
			"{\"f\":{"
			"\"feature.on\":{\"t\":0,\"v\":{\"b\":true}},"
			"\"feature.off\":{\"t\":0,\"v\":{\"b\":false},\"i\":\"v-off\"},"
			"\"feature.string\":{\"t\":1,\"v\":{\"s\":\"hello\"}},"
			"\"feature.empty\":{\"t\":1,\"v\":{\"s\":\"\"}},"
			"\"feature.int\":{\"t\":2,\"v\":{\"i\":5}},"
			"\"feature.zero\":{\"t\":2,\"v\":{\"i\":0}},"
			"\"feature.double\":{\"t\":3,\"v\":{\"d\":0.25}},"
			"\"feature.precision\":{\"t\":3,\"v\":{\"d\":0.30000000000000004}},"
			"\"feature.unknown\":{\"t\":99,\"v\":{\"b\":true}}"
			"}}");
		return ParseConfig(Body);
	}
}

bool FConfeatureEvaluatorTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const TSharedPtr<FJsonObject> Cfg = SampleConfig();
	TestTrue(TEXT("sample config parsed"), Cfg.IsValid());

	// Boolean — happy path: true. Behaviour-equivalent to the
	// pre-#261 EvaluateBool entrypoint (FR-010 / FR-009).
	{
		const FEvalResult R = Evaluate(Cfg, TEXT("feature.on"), FConfeatureDefaultValue::Bool(false));
		TestEqual(TEXT("happy true: ResolvedType"), R.ResolvedType, SettingTypeBool);
		TestEqual(TEXT("happy true: value"), R.BoolValue, true);
		TestEqual(TEXT("happy true: no error"), R.Error, FString());
	}

	// Boolean — variation id is captured.
	{
		const FEvalResult R = Evaluate(Cfg, TEXT("feature.off"), FConfeatureDefaultValue::Bool(true));
		TestEqual(TEXT("variation id"), R.VariationId, TEXT("v-off"));
		TestEqual(TEXT("happy false: value"), R.BoolValue, false);
		TestEqual(TEXT("happy false: no error"), R.Error, FString());
	}

	// String — happy path.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.string"), FConfeatureDefaultValue::String(TEXT("fallback")));
		TestEqual(TEXT("string: ResolvedType"), R.ResolvedType, SettingTypeString);
		TestEqual(TEXT("string: value"), R.StringValue, TEXT("hello"));
		TestEqual(TEXT("string: no error"), R.Error, FString());
	}

	// String — empty string is a real value (FR-001 edge case).
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.empty"), FConfeatureDefaultValue::String(TEXT("fallback")));
		TestEqual(TEXT("empty string: value"), R.StringValue, FString());
		TestEqual(TEXT("empty string: no error"), R.Error, FString());
	}

	// Int — happy path.
	{
		const FEvalResult R = Evaluate(Cfg, TEXT("feature.int"), FConfeatureDefaultValue::Int(-1));
		TestEqual(TEXT("int: ResolvedType"), R.ResolvedType, SettingTypeInt);
		TestEqual(TEXT("int: value"), R.IntValue, 5);
		TestEqual(TEXT("int: no error"), R.Error, FString());
	}

	// Int — zero is a real value.
	{
		const FEvalResult R = Evaluate(Cfg, TEXT("feature.zero"), FConfeatureDefaultValue::Int(-1));
		TestEqual(TEXT("zero int: value"), R.IntValue, 0);
		TestEqual(TEXT("zero int: no error"), R.Error, FString());
	}

	// Double — happy path.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.double"), FConfeatureDefaultValue::Double(0.0));
		TestEqual(TEXT("double: ResolvedType"), R.ResolvedType, SettingTypeDouble);
		TestEqual(TEXT("double: value"), R.DoubleValue, 0.25);
		TestEqual(TEXT("double: no error"), R.Error, FString());
	}

	// Double — precision-sensitive IEEE-754 round-trip.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.precision"), FConfeatureDefaultValue::Double(0.0));
		TestEqual(TEXT("precision double: value"), R.DoubleValue, 0.30000000000000004);
		TestEqual(TEXT("precision double: no error"), R.Error, FString());
	}

	// TYPE_MISMATCH — string setting read with an int default.
	{
		const FEvalResult R = Evaluate(Cfg, TEXT("feature.string"), FConfeatureDefaultValue::Int(0));
		TestEqual(TEXT("string-vs-int error"), R.Error, TEXT("TYPE_MISMATCH"));
		TestEqual(TEXT("string-vs-int fallback"), R.IntValue, 0);
	}

	// TYPE_MISMATCH — int setting read with a string default.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.int"), FConfeatureDefaultValue::String(TEXT("not-a-number")));
		TestEqual(TEXT("int-vs-string error"), R.Error, TEXT("TYPE_MISMATCH"));
		TestEqual(TEXT("int-vs-string fallback"), R.StringValue, TEXT("not-a-number"));
	}

	// TYPE_MISMATCH — double setting read with a bool default.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.double"), FConfeatureDefaultValue::Bool(true));
		TestEqual(TEXT("double-vs-bool error"), R.Error, TEXT("TYPE_MISMATCH"));
		TestEqual(TEXT("double-vs-bool fallback"), R.BoolValue, true);
	}

	// TYPE_MISMATCH — int default against a double setting (strict: an
	// integer-valued double is not coerced into an int default).
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.double"), FConfeatureDefaultValue::Int(42));
		TestEqual(TEXT("double-vs-int error"), R.Error, TEXT("TYPE_MISMATCH"));
		TestEqual(TEXT("double-vs-int fallback"), R.IntValue, 42);
	}

	// KEY_NOT_FOUND — missing key returns default for every typed kind.
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.absent"), FConfeatureDefaultValue::Bool(true));
		TestEqual(TEXT("absent value"), R.BoolValue, true);
		TestEqual(TEXT("absent error"), R.Error, TEXT("KEY_NOT_FOUND"));
	}
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.absent"), FConfeatureDefaultValue::String(TEXT("fb")));
		TestEqual(TEXT("absent string value"), R.StringValue, TEXT("fb"));
		TestEqual(TEXT("absent string error"), R.Error, TEXT("KEY_NOT_FOUND"));
	}

	// UNSUPPORTED_TYPE — only for a truly unknown `t` discriminator.
	// Pre-#261 this branch fired for `t = 1`; #261 reshapes it to fire
	// for `t = 99` (FR-003).
	{
		const FEvalResult R = Evaluate(
			Cfg, TEXT("feature.unknown"), FConfeatureDefaultValue::Bool(false));
		TestEqual(TEXT("unknown t: value"), R.BoolValue, false);
		TestEqual(TEXT("unknown t: error"), R.Error, TEXT("UNSUPPORTED_TYPE"));
	}

	// NO_CONFIG — invalid config pointer.
	{
		const FEvalResult R = Evaluate(nullptr, TEXT("x"), FConfeatureDefaultValue::Bool(false));
		TestEqual(TEXT("no config value"), R.BoolValue, false);
		TestEqual(TEXT("no config error"), R.Error, TEXT("NO_CONFIG"));
	}

	// MALFORMED_CONFIG — empty object — no `f`.
	{
		const TSharedPtr<FJsonObject> Empty = MakeShared<FJsonObject>();
		const FEvalResult R = Evaluate(Empty, TEXT("x"), FConfeatureDefaultValue::Bool(false));
		TestEqual(TEXT("malformed error"), R.Error, TEXT("MALFORMED_CONFIG"));
	}

	return true;
}
