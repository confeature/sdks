// SPDX-License-Identifier: MIT

// Targeting-rule parity (spec 135 / #441, epic #382, US3) — the
// `CORPUS_RULES` corpus injected through the full-config offline override.
//
// Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which feed
// a value-only override map via `FConfeatureFlagOverrides::MakeLocalOnly`),
// the rule corpus carries the whole `{p, f, s}` config and is injected via
// `FConfeatureFlagOverrides::MakeFromConfig` + LocalOnly. The SDK then
// resolves targeting rules / segments / % options offline through the real UE
// evaluator, exactly as it would against a CDN-served config — no network
// round-trip.
//
// Runner contract (mirrors apps/sdk-cpp/tests/parity_rules_test.cpp,
// apps/sdk-python/tests/parity/test_parity_rules.py and
// apps/sdk-dart/test/parity_rules_test.dart): every tuple branches on the
// config's `injectionMode`:
//   - "full-config" → capability-probe `MakeFromConfig`. If sdk-unreal
//     exposes it, build the override and assert the PUBLIC
//     `UConfeatureClient::GetValueString` (the public GetValue surface)
//     returns `tuple.expected`. If it does NOT, SKIP with a reason — NEVER
//     fall back to the flat-map path (SC-004: no "full-config" tuple is ever
//     resolved on the map path, and a skip is reported with its reason).
//
// sdk-unreal HAS adopted the full-config path (this US3 change), so every
// loaded rule tuple runs + passes. The corpus is string-typed today (defaultValue
// "default", expected "Cat"/"Dog"), so the public entrypoint is
// `GetValueString`; the harness is value-type-agnostic at the corpus level
// and dispatches on the tuple's `defaultValue` JSON kind so future non-string
// rule tuples route through the matching typed accessor.
//
// AC4: if a tuple fails because of a REAL UE evaluator targeting-rule gap (not
// override wiring), STOP and file a discrete #382 follow-up — never a corpus
// or test workaround.
//
// ENVIRONMENT CAVEAT: this is a real, compilable, runnable FAutomation test,
// but it is NOT executed in the spec-authoring environment (no UE toolchain).
// The corpus run is deferred to a UE-equipped environment, exactly as for the
// spec-131 engine port (#415).

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "ConfeatureClient.h"
#include "ConfeatureEvaluationDetails.h"
#include "ConfeatureFlagOverrides.h"
#include "ConfeatureUser.h"
#include "Internal/Evaluator.h"
#include "Tests/TestPaths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureParityRulesTest, "Confeature.Parity.Rules",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

namespace
{
	// Loads a JSON array fixture into the supplied out-array. Mirrors the
	// loader in ParityCorpusTest.cpp.
	bool LoadJsonArray(
		FAutomationTestBase& Test, const FString& Path, TArray<TSharedPtr<FJsonValue>>& OutEntries)
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

	// Builds a FConfeatureUser from a parity-corpus user object. `bHasUser` is
	// false when the tuple's `user` is null (no targeting attributes). Mirrors
	// the C++ runner's buildUser + the upstream-corpus MakeUser idiom.
	FConfeatureUser BuildUser(const TSharedPtr<FJsonValue>& UserVal, bool& bHasUser)
	{
		FConfeatureUser User;
		bHasUser = false;
		if (!UserVal.IsValid() || UserVal->Type != EJson::Object)
		{
			return User;
		}
		const TSharedPtr<FJsonObject> UserObj = UserVal->AsObject();
		if (!UserObj.IsValid())
		{
			return User;
		}
		bHasUser = true;
		UserObj->TryGetStringField(TEXT("identifier"), User.Identifier);
		UserObj->TryGetStringField(TEXT("email"), User.Email);
		UserObj->TryGetStringField(TEXT("country"), User.Country);
		const TSharedPtr<FJsonObject>* CustomObj = nullptr;
		if (UserObj->TryGetObjectField(TEXT("custom"), CustomObj) && CustomObj
			&& CustomObj->IsValid())
		{
			for (const auto& Pair : (*CustomObj)->Values)
			{
				const TSharedPtr<FJsonValue>& Val = Pair.Value;
				if (!Val.IsValid())
				{
					continue;
				}
				// Typed-attribute corpus encoding (contract): value by NATURAL
				// JSON type. Mirrors apps/sdk-cpp/tests/parity_rules_test.cpp
				// `buildUser`:
				//   string                       → SetCustomString
				//   number                       → SetCustomNumber (double)
				//   array                        → SetCustomStringArray
				//   { "$date": <epoch-seconds> } → SetCustomDateTimeFromEpochSeconds
				//   { "$num": "NaN"|"Infinity"|"-Infinity" }
				//                                → SetCustomNumber with the
				//                                  corresponding non-finite double
				//                                  (#479 — `JSON.stringify` collapses
				//                                  NaN/±Inf to a lossy `null`, so the
				//                                  corpus tags them explicitly,
				//                                  mirroring `{"$date"}`). This wires
				//                                  the 6 numberToStringConversion /
				//                                  dateToStringConversion NaN/±Inf
				//                                  tuples to RUN (no longer the #468
				//                                  null-skip descope).
				//   bool                         → upstream JS string "true"/"false"
				//   null                         → skip (no attribute)
				// The evaluator then canonicalises each non-string attr
				// ConfigCat-exactly (number → invariant decimal, NaN/±Inf →
				// "NaN"/"Infinity"/"-Infinity", date → epoch seconds, array → JSON).
				switch (Val->Type)
				{
					case EJson::String:
						User.SetCustomString(Pair.Key, Val->AsString());
						break;
					case EJson::Object:
					{
						const TSharedPtr<FJsonObject> Obj = Val->AsObject();
						if (!Obj.IsValid())
						{
							break;
						}
						double Seconds = 0.0;
						FString NumTag;
						if (Obj->TryGetNumberField(TEXT("$date"), Seconds))
						{
							User.SetCustomDateTimeFromEpochSeconds(Pair.Key, Seconds);
						}
						else if (Obj->TryGetStringField(TEXT("$num"), NumTag))
						{
							// Non-finite number tag → the corresponding double,
							// built with UE-native idioms (no <limits>, matching the
							// sibling EvaluatorUpstreamCorpusTest helpers): NaN via
							// FMath::Sqrt(-1.0), ±Inf via TNumericLimits<double>::Max()
							// * ±2.0. The evaluator's NumberToCanonicalString renders
							// these to the exact "NaN"/"Infinity"/"-Infinity" strings
							// the corpus expects — same shape as the JS `value + ""`.
							if (NumTag == TEXT("NaN"))
							{
								User.SetCustomNumber(Pair.Key, FMath::Sqrt(-1.0));
							}
							else if (NumTag == TEXT("Infinity"))
							{
								User.SetCustomNumber(
									Pair.Key, TNumericLimits<double>::Max() * 2.0);
							}
							else if (NumTag == TEXT("-Infinity"))
							{
								User.SetCustomNumber(
									Pair.Key, TNumericLimits<double>::Max() * -2.0);
							}
							// An unknown $num tag falls through with no attribute set;
							// the per-tuple TestEqual then surfaces the mismatch
							// loudly rather than silently passing.
						}
						break;
					}
					case EJson::Number:
						User.SetCustomNumber(Pair.Key, Val->AsNumber());
						break;
					case EJson::Array:
					{
						TArray<FString> Elements;
						for (const TSharedPtr<FJsonValue>& E : Val->AsArray())
						{
							FString ElemStr;
							if (E.IsValid() && E->TryGetString(ElemStr))
							{
								Elements.Add(ElemStr);
							}
						}
						User.SetCustomStringArray(Pair.Key, Elements);
						break;
					}
					case EJson::Boolean:
						// Upstream treats a bool attr as its JS string form.
						User.SetCustomString(
							Pair.Key, Val->AsBool() ? TEXT("true") : TEXT("false"));
						break;
					case EJson::Null:
					default:
						// null / unsupported → skip (no attribute set).
						break;
				}
			}
		}
		return User;
	}
}

bool FConfeatureParityRulesTest::RunTest(const FString& /*Parameters*/)
{
	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(
			TEXT("Skipping ParityRulesTest: packages/test-fixtures-sdk-parity/fixtures not found "
				 "relative to ProjectDir()."));
		return true;
	}

	TArray<TSharedPtr<FJsonValue>> Corpus;
	TArray<TSharedPtr<FJsonValue>> Configs;
	if (!LoadJsonArray(
			*this, FPaths::Combine(FixturesDir, TEXT("parity-corpus-rules.json")), Corpus))
	{
		return false;
	}
	if (!LoadJsonArray(
			*this, FPaths::Combine(FixturesDir, TEXT("parity-configs-rules.json")), Configs))
	{
		return false;
	}

	// Growth-tolerant non-empty floor. CORPUS_RULES is append-only (the 8
	// foundational #383 tuples are never removed) and grows with every
	// comparator spec, so we assert only that the fixture actually loaded — not a
	// hardcoded total that re-trips on every growth. Per-tuple correctness is
	// covered by the per-tuple TestEqual below (+ `Passed == Corpus.Num()`), and
	// JSON↔TS sync is owned by the central `check:exports` gate, so this guard is
	// purely a non-empty smoke and never needs a per-spec bump. If it fails, the
	// fixture looks empty/truncated — regenerate via `pnpm run export:corpus` in
	// packages/test-fixtures-sdk-parity/.
	TestTrue(TEXT("corpus is non-empty (append-only floor: >= 8)"), Corpus.Num() >= 8);

	// Build a configId → (full config FJsonObject, injectionMode) index. The
	// FULL `{p, f, s}` config is retained (salt `p.s` + segments `s`), never
	// just `f` — INV-4.
	TMap<FString, TSharedPtr<FJsonObject>> ConfigById;
	TMap<FString, FString> InjectionModeById;
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
		FString Mode;
		(*Obj)->TryGetStringField(TEXT("injectionMode"), Mode);
		InjectionModeById.Add(Id, Mode);
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

		// SC-004: the rule corpus is full-config only. A non-full-config mode
		// here would be a corpus regression — never a silent flat-map
		// fallback.
		const FString* Mode = InjectionModeById.Find(ConfigId);
		if (Mode == nullptr || *Mode != TEXT("full-config"))
		{
			AddError(FString::Printf(
				TEXT("SC-004 violation: rule tuple '%s' has injectionMode '%s' (expected "
					 "'full-config'); refusing to resolve a rule tuple on the flat-map path."),
				*Description, Mode != nullptr ? **Mode : TEXT("<none>")));
			continue;
		}

		// Capability probe: sdk-unreal HAS adopted the full-config path
		// (FConfeatureFlagOverrides::MakeFromConfig + the full-config router),
		// so the override is built and the PUBLIC GetValue surface is asserted
		// — never the flat-map path. The SKIP branch in the sibling runners
		// maps to "this file fails to compile" here (MakeFromConfig must be
		// part of the public surface), an even louder signal than a runtime
		// skip.
		const FConfeatureFlagOverrides Overrides
			= FConfeatureFlagOverrides::MakeFromConfig(*ConfigPtr, EConfeatureOverrideBehaviour::LocalOnly);

		// Drive the REAL public client (LocalOnly never polls / fetches). The
		// override router resolves targeting rules / segments / % options
		// offline through the real evaluator with the full {p, f, s} + User.
		UConfeatureClient* Client = UConfeatureClient::Builder(TEXT("test-sdk-key"))
										.FlagOverrides(Overrides)
										.Build();
		if (Client == nullptr)
		{
			AddError(FString::Printf(TEXT("Failed to build client for tuple: %s"), *Description));
			continue;
		}

		bool bHasUser = false;
		const FConfeatureUser User
			= BuildUser((*TupleObj)->TryGetField(TEXT("user")), bHasUser);

		// Dispatch on the tuple's default JSON kind so the public typed
		// accessor matches the corpus value type. The rule corpus is
		// string-typed today; the boolean / numeric branches future-proof
		// non-string rule tuples without ever touching the flat-map path.
		TSharedPtr<FJsonValue> Actual;
		switch (DefaultVal->Type)
		{
			case EJson::String:
			{
				FString Def;
				DefaultVal->TryGetString(Def);
				const FString Got = Client->GetValueString(Key, Def, User);
				Actual = MakeShared<FJsonValueString>(Got);
				break;
			}
			case EJson::Boolean:
			{
				bool Def = false;
				DefaultVal->TryGetBool(Def);
				const bool Got = Client->GetValueBool(Key, Def, User);
				Actual = MakeShared<FJsonValueBoolean>(Got);
				break;
			}
			case EJson::Number:
			{
				double Def = 0.0;
				DefaultVal->TryGetNumber(Def);
				if (FMath::Frac(Def) != 0.0
					|| (ExpectedVal->Type == EJson::Number
						&& [&] {
							   double E = 0.0;
							   ExpectedVal->TryGetNumber(E);
							   return FMath::Frac(E) != 0.0;
						   }()))
				{
					const double Got = Client->GetValueDouble(Key, Def, User);
					Actual = MakeShared<FJsonValueNumber>(Got);
				}
				else
				{
					const int32 Got = Client->GetValueInt(Key, static_cast<int32>(Def), User);
					Actual = MakeShared<FJsonValueNumber>(static_cast<double>(Got));
				}
				break;
			}
			default:
				AddError(FString::Printf(
					TEXT("Unsupported default kind for tuple: %s"), *Description));
				Client->Close();
				continue;
		}

		// Spec 152 / #475 US2 — when a tuple carries `expectedVariationId`,
		// assert the PUBLIC `UConfeatureClient::GetValueDetails*().VariationId`
		// (the configcat-cpp details surface) in ADDITION to the value. The
		// variationId MUST propagate through the full-config override path (the
		// #395 gap class — see the EvaluateFullConfigSync fix). Dispatch the
		// typed accessor on the SETTING TYPE (`f[key].t`), NOT the value kind: a
		// Double setting (`t==3`) can carry an int-encoded expected (`0` / `1`)
		// whose default `-1` is int-shaped — passing an int default would trip
		// the int-vs-double TYPE_MISMATCH guard. The setting type is the
		// authoritative discriminator, so we pass a DOUBLE default for t==3
		// (mirrors apps/sdk-cpp/tests/parity_rules_test.cpp).
		FString ExpectedVid;
		if ((*TupleObj)->TryGetStringField(TEXT("expectedVariationId"), ExpectedVid))
		{
			// Resolve the setting's declared type from the full config's `f[key].t`.
			int32 SettingType = Confeature::Internal::SettingTypeString;
			const TSharedPtr<FJsonObject>* FObj = nullptr;
			if ((*ConfigPtr)->TryGetObjectField(TEXT("f"), FObj) && FObj && FObj->IsValid())
			{
				const TSharedPtr<FJsonObject>* SettingObj = nullptr;
				if ((*FObj)->TryGetObjectField(Key, SettingObj) && SettingObj
					&& SettingObj->IsValid())
				{
					int32 TVal = 0;
					if ((*SettingObj)->TryGetNumberField(TEXT("t"), TVal))
					{
						SettingType = TVal;
					}
				}
			}

			FConfeatureEvaluationDetails Details;
			switch (SettingType)
			{
				case Confeature::Internal::SettingTypeBool:
				{
					bool Def = false;
					DefaultVal->TryGetBool(Def);
					Details = Client->GetValueDetailsBool(Key, Def, User);
					break;
				}
				case Confeature::Internal::SettingTypeInt:
				{
					double Def = 0.0;
					DefaultVal->TryGetNumber(Def);
					Details = Client->GetValueDetailsInt(Key, static_cast<int32>(Def), User);
					break;
				}
				case Confeature::Internal::SettingTypeDouble:
				{
					// DOUBLE setting — pass a DOUBLE default so the int-vs-double
					// TYPE_MISMATCH guard is satisfied even when the corpus default
					// `-1` is int-shaped JSON.
					double Def = 0.0;
					DefaultVal->TryGetNumber(Def);
					Details = Client->GetValueDetailsDouble(Key, Def, User);
					break;
				}
				case Confeature::Internal::SettingTypeString:
				default:
				{
					FString Def;
					DefaultVal->TryGetString(Def);
					Details = Client->GetValueDetailsString(Key, Def, User);
					break;
				}
			}

			// The variationId MUST be present (the #395 gap class is a propagation
			// bug, not an evaluator gap) and equal to the corpus expectation.
			if (!TestTrue(
					FString::Printf(TEXT("variationId present for tuple: %s"), *Description),
					Details.bHasVariationId))
			{
				Client->Close();
				continue;
			}
			if (!TestEqual(FString::Printf(TEXT("variationId for tuple: %s"), *Description),
					Details.VariationId, ExpectedVid))
			{
				Client->Close();
				continue;
			}
		}

		Client->Close();

		FString ActualStr;
		FString ExpectedStr;
		const TSharedRef<TJsonWriter<>> AW = TJsonWriterFactory<>::Create(&ActualStr);
		const TSharedRef<TJsonWriter<>> EW = TJsonWriterFactory<>::Create(&ExpectedStr);
		FJsonSerializer::Serialize(Actual.ToSharedRef(), TEXT(""), AW);
		FJsonSerializer::Serialize(ExpectedVal.ToSharedRef(), TEXT(""), EW);

		// Principle II NON-NEGOTIABLE — investigate the evaluator / override
		// router, do NOT mutate the corpus. A real UE targeting-rule engine
		// gap (not an override-wiring bug) is a discrete #382 follow-up, never
		// a corpus or test workaround (AC4).
		if (!TestEqual(FString::Printf(TEXT("tuple: %s"), *Description), ActualStr, ExpectedStr))
		{
			continue;
		}
		++Passed;
	}

	// Growth-tolerant: every LOADED tuple must have passed (stronger than a fixed
	// number, and never needs a per-spec bump as the corpus grows).
	TestEqual(TEXT("all loaded tuples passed"), Passed, Corpus.Num());
	return Passed == Corpus.Num();
}

// Sanity: the full-config override source carries the WHOLE `{p, f, s}` blob
// (INV-4 — salt `p.s` + segments `s`, not just `f`), and exposes the flat base
// values for key enumeration without ever routing rule resolution through
// them. Mirrors the C++ "ConfigOverrideDataSource retains the full config"
// case.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureConfigOverrideSourceTest,
	"Confeature.Parity.ConfigOverrideSource",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::SmokeFilter)

bool FConfeatureConfigOverrideSourceTest::RunTest(const FString& /*Parameters*/)
{
	const FString FixturesDir = Confeature::Tests::FindFixturesDirectory();
	if (FixturesDir.IsEmpty())
	{
		AddWarning(TEXT("Skipping ConfigOverrideSourceTest: fixtures not found."));
		return true;
	}

	TArray<TSharedPtr<FJsonValue>> Configs;
	if (!LoadJsonArray(
			*this, FPaths::Combine(FixturesDir, TEXT("parity-configs-rules.json")), Configs))
	{
		return false;
	}
	if (Configs.Num() == 0)
	{
		AddError(TEXT("parity-configs-rules.json is empty"));
		return false;
	}

	const TSharedPtr<FJsonObject>* Entry = nullptr;
	if (!Configs[0].IsValid() || !Configs[0]->TryGetObject(Entry))
	{
		AddError(TEXT("First config entry is not an object"));
		return false;
	}
	const TSharedPtr<FJsonObject>* ConfigObj = nullptr;
	if (!(*Entry)->TryGetObjectField(TEXT("config"), ConfigObj) || ConfigObj == nullptr
		|| !ConfigObj->IsValid())
	{
		AddError(TEXT("First config entry has no `config`"));
		return false;
	}

	FConfeatureConfigOverrideDataSource Source(*ConfigObj);

	// Full `{p, f, s}` retained verbatim.
	TestTrue(TEXT("config retained"), Source.Config().IsValid());
	TestTrue(TEXT("salt p retained"), Source.Config()->HasField(TEXT("p")));
	TestTrue(TEXT("segments s retained"), Source.Config()->HasField(TEXT("s")));

	// GetOverridesSync exposes the rule-bearing settings map (`f`) so key
	// enumeration works.
	const TMap<FString, TSharedPtr<FJsonValue>>& Base = Source.GetOverridesSync();
	const TSharedPtr<FJsonObject>* F = nullptr;
	if ((*ConfigObj)->TryGetObjectField(TEXT("f"), F) && F && F->IsValid())
	{
		for (const auto& Pair : (*F)->Values)
		{
			TestTrue(FString::Printf(TEXT("base value present for key %s"), *Pair.Key),
				Base.Contains(Pair.Key));
		}
	}
	return true;
}
