// SPDX-License-Identifier: MIT

// ConfigCat conformance gate (spec 131, SC-001) — the UE engine replays the
// vendored upstream evaluation matrix. Mirrors the spec-117 TS reference suite
// and the merged C++ port's `apps/sdk-cpp/tests/evaluator_upstream_corpus_test.cpp`
// (the direct template). The corpus
// (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
// `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is
// the oracle: each `(config, key, user) -> expected` tuple is checked against
// `Confeature::Internal::Evaluate(...)`.
//
// VERIFICATION CAVEAT (spec 131): this harness is delivered runnable in a UE
// environment but is NOT executed in CI or by the local Dagger gate — Unreal
// has no Dagger module (`daggerFn: null`) and no UE toolchain in the dev
// environment. Run it with:
//   "$UE_PATH/.../UnrealEditor" -ExecCmds="Automation RunTests Confeature.Upstream" -Unattended
//
// Per FR-018 only structured value / variationId / matched-rule|option
// identity is asserted — never a textual trace.
//
// The loaders port the upstream `upstream-corpus.ts` faithfully — most
// critically the Go `csv.Reader` LazyQuotes semantics (a `"` only opens a
// quoted field at the field start), without which every JSON-array attribute
// cell is corrupted.

#include <initializer_list>

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include "ConfeatureUser.h"
#include "Internal/Evaluator.h"
#include "Tests/TestPaths.h"

namespace
{
	using namespace Confeature::Internal;

	// `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob
	// was NOT captured by the spec-117 vendoring (known DATA gap #401, not an
	// engine gap). The multilevel-prerequisite path IS exercised by the
	// reconstructed chain test below + the circular_dep chain. Excluded LOUDLY
	// (the same marker the TS / Python / Ruby / PHP / C++ references use).
	const TCHAR* const kUnvendoredEvalLogKey = TEXT("dependentFeatureMultipleLevels");  // #401

	const FString kPkd = TEXT("configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/");
	const FString kJcp = TEXT("configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/");

	// The null-token used by the matrix loaders for an absent user.
	const TCHAR* const kNullToken = TEXT("##null##");

	// ── file readers ──────────────────────────────────────────────────────────

	FString ReadText(const FString& Path)
	{
		FString Raw;
		FFileHelper::LoadFileToString(Raw, *Path);
		return Raw;
	}

	TSharedPtr<FJsonObject> ReadJsonObject(const FString& UpstreamDir, const FString& Relative)
	{
		const FString Raw = ReadText(FPaths::Combine(UpstreamDir, Relative));
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		TSharedPtr<FJsonObject> Obj;
		FJsonSerializer::Deserialize(Reader, Obj);
		return Obj;
	}

	// ── canonical user-attribute stringification ──────────────────────────────
	//
	// Ports `comparators.ts::userAttributeValueToString` + numberToCanonicalString
	// (the ECMAScript Number.toString shape). NaN / +/-Infinity / exponential
	// magnitudes must format exactly as JS.

	FString NumberToCanonicalString(double Value)
	{
		if (FMath::IsNaN(Value))
		{
			return TEXT("NaN");
		}
		if (!FMath::IsFinite(Value))
		{
			return Value > 0 ? TEXT("Infinity") : TEXT("-Infinity");
		}
		if (Value == 0.0)
		{
			return TEXT("0");
		}

		const FString Sign = Value < 0 ? TEXT("-") : TEXT("");
		const double Av = FMath::Abs(Value);

		// UE's "%.17g" gives a round-tripping decimal; we then reshape into the
		// ECMAScript Number.toString form via the [digits, point] decomposition.
		// Use a shortest-round-trip search like the other ports' dtoa: try
		// increasing precision until the parse round-trips.
		FString Shortest;
		for (int32 Prec = 1; Prec <= 17; ++Prec)
		{
			Shortest = FString::Printf(TEXT("%.*g"), Prec, Av);
			if (FCString::Atod(*Shortest) == Av)
			{
				break;
			}
		}

		FString Mant = Shortest;
		int64 ExpVal = 0;
		int32 EPos = INDEX_NONE;
		if (Shortest.FindChar(TEXT('e'), EPos) || Shortest.FindChar(TEXT('E'), EPos))
		{
			Mant = Shortest.Left(EPos);
			ExpVal = FCString::Atoi64(*Shortest.Mid(EPos + 1));
		}

		FString IntPart;
		FString FracPart;
		int32 DotPos = INDEX_NONE;
		if (Mant.FindChar(TEXT('.'), DotPos))
		{
			IntPart = Mant.Left(DotPos);
			FracPart = Mant.Mid(DotPos + 1);
		}
		else
		{
			IntPart = Mant;
		}

		FString Raw = IntPart + FracPart;
		int64 Point = static_cast<int64>(IntPart.Len()) + ExpVal;

		// Strip leading zeros (adjusting point), then trailing zeros.
		int32 Lead = 0;
		while (Lead + 1 < Raw.Len() && Raw[Lead] == TEXT('0'))
		{
			++Lead;
			--Point;
		}
		Raw = Raw.Mid(Lead);
		while (Raw.Len() > 1 && Raw[Raw.Len() - 1] == TEXT('0'))
		{
			Raw = Raw.Left(Raw.Len() - 1);
		}
		if (Raw == TEXT("0"))
		{
			return TEXT("0");
		}

		const int64 K = static_cast<int64>(Raw.Len());
		const int64 N = Point;

		if (N >= K && N <= 21)
		{
			return Sign + Raw
				+ FString::ChrN(static_cast<int32>(N - K), TEXT('0'));
		}
		if (N > 0 && N <= 21)
		{
			return Sign + Raw.Left(static_cast<int32>(N)) + TEXT(".")
				+ Raw.Mid(static_cast<int32>(N));
		}
		if (N > -6 && N <= 0)
		{
			return Sign + TEXT("0.") + FString::ChrN(static_cast<int32>(-N), TEXT('0')) + Raw;
		}
		const int64 E = N - 1;
		const FString ExpSign = E >= 0 ? TEXT("+") : TEXT("-");
		const FString MantOut = (K == 1) ? Raw : (Raw.Left(1) + TEXT(".") + Raw.Mid(1));
		return Sign + MantOut + TEXT("e") + ExpSign + FString::Printf(TEXT("%lld"), FMath::Abs(E));
	}

	// Mirrors userAttributeValueToString for the JSON-decoded native values the
	// conversion driver supplies.
	FString UserAttributeValueToString(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return FString();
		}
		switch (Value->Type)
		{
			case EJson::String:
				return Value->AsString();
			case EJson::Boolean:
				return Value->AsBool() ? TEXT("true") : TEXT("false");
			case EJson::Number:
				return NumberToCanonicalString(Value->AsNumber());
			case EJson::Array:
			{
				// JSON.stringify of a string array — compact, no spaces.
				FString Out = TEXT("[");
				bool bFirst = true;
				for (const TSharedPtr<FJsonValue>& E : Value->AsArray())
				{
					if (!bFirst)
					{
						Out += TEXT(",");
					}
					bFirst = false;
					// Element is a string → quote it; serialize via writer to
					// get correct escaping (matches JSON.stringify of strings).
					FString ElemStr;
					const TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&ElemStr);
					FJsonSerializer::Serialize(E.ToSharedRef(), TEXT(""), W);
					ElemStr = ElemStr.TrimStartAndEnd();
					Out += ElemStr;
				}
				Out += TEXT("]");
				return Out;
			}
			default:
				return FString();
		}
	}

	// ── corpus user ────────────────────────────────────────────────────────────

	FConfeatureUser MakeUser(const FString& Identifier, const TSharedPtr<FJsonObject>& Custom)
	{
		FConfeatureUser User;
		User.Identifier = Identifier;
		if (Custom.IsValid())
		{
			for (const auto& Pair : Custom->Values)
			{
				const FString Str = UserAttributeValueToString(Pair.Value);
				if (Pair.Key == TEXT("Email"))
				{
					User.Email = Str;
				}
				else if (Pair.Key == TEXT("Country"))
				{
					User.Country = Str;
				}
				else
				{
					User.Custom.Add(Pair.Key, Str);
				}
			}
		}
		return User;
	}

	// ── LazyQuotes CSV reader (Go csv.Reader, Comma=';', LazyQuotes=true) ──────

	TArray<FString> ParseCsvLine(const FString& Line)
	{
		TArray<FString> Fields;
		FString Field;
		bool bInQuotes = false;
		bool bFieldStart = true;
		const int32 N = Line.Len();
		for (int32 i = 0; i < N; ++i)
		{
			const TCHAR Ch = Line[i];
			if (bInQuotes && Ch == TEXT('"') && i + 1 < N && Line[i + 1] == TEXT('"'))
			{
				Field += TEXT('"');
				++i;
			}
			else if (bInQuotes && Ch == TEXT('"'))
			{
				bInQuotes = false;
			}
			else if (bInQuotes)
			{
				Field += Ch;
			}
			else if (Ch == TEXT('"') && bFieldStart)
			{
				bInQuotes = true;
				bFieldStart = false;
			}
			else if (Ch == TEXT(';'))
			{
				Fields.Add(Field);
				Field.Reset();
				bFieldStart = true;
			}
			else
			{
				Field += Ch;
				bFieldStart = false;
			}
		}
		Fields.Add(Field);
		return Fields;
	}

	TArray<FString> SplitLines(const FString& Text)
	{
		TArray<FString> Lines;
		FString Cur;
		for (const TCHAR Ch : Text)
		{
			if (Ch == TEXT('\n'))
			{
				if (Cur.Len() > 0 && Cur[Cur.Len() - 1] == TEXT('\r'))
				{
					Cur = Cur.Left(Cur.Len() - 1);
				}
				if (!Cur.IsEmpty())
				{
					Lines.Add(Cur);
				}
				Cur.Reset();
			}
			else
			{
				Cur += Ch;
			}
		}
		if (Cur.Len() > 0 && Cur[Cur.Len() - 1] == TEXT('\r'))
		{
			Cur = Cur.Left(Cur.Len() - 1);
		}
		if (!Cur.IsEmpty())
		{
			Lines.Add(Cur);
		}
		return Lines;
	}

	// Parse a CSV cell to a JSON primitive (mirrors upstream parseCell).
	TSharedPtr<FJsonValue> ParseCell(const FString& S)
	{
		// Integer (within the 2^53 safe range, exact round-trip).
		if (!S.IsEmpty())
		{
			bool bAllDigits = true;
			int32 Start = (S[0] == TEXT('-')) ? 1 : 0;
			if (Start == S.Len())
			{
				bAllDigits = false;
			}
			for (int32 i = Start; i < S.Len() && bAllDigits; ++i)
			{
				if (S[i] < TEXT('0') || S[i] > TEXT('9'))
				{
					bAllDigits = false;
				}
			}
			if (bAllDigits)
			{
				const int64 N = FCString::Atoi64(*S);
				if (FMath::Abs(N) <= 9007199254740991LL
					&& FString::Printf(TEXT("%lld"), N) == S)
				{
					return MakeShared<FJsonValueNumber>(static_cast<double>(N));
				}
			}
		}
		// Float.
		{
			bool bLooksFloat = !S.IsEmpty();
			bool bSawDigit = false;
			bool bSawDot = false;
			bool bSawExp = false;
			for (int32 i = 0; i < S.Len() && bLooksFloat; ++i)
			{
				const TCHAR C = S[i];
				if (C >= TEXT('0') && C <= TEXT('9'))
				{
					bSawDigit = true;
				}
				else if (C == TEXT('-') || C == TEXT('+'))
				{
				}
				else if (C == TEXT('.'))
				{
					bSawDot = true;
				}
				else if (C == TEXT('e') || C == TEXT('E'))
				{
					bSawExp = true;
				}
				else
				{
					bLooksFloat = false;
				}
			}
			if (bLooksFloat && bSawDigit && (bSawDot || bSawExp))
			{
				return MakeShared<FJsonValueNumber>(FCString::Atod(*S));
			}
		}
		if (S == TEXT("True"))
		{
			return MakeShared<FJsonValueBoolean>(true);
		}
		if (S == TEXT("False"))
		{
			return MakeShared<FJsonValueBoolean>(false);
		}
		return MakeShared<FJsonValueString>(S);
	}

	// ── matrix → sdkKey mapping (verbatim from upstream-corpus.ts) ─────────────

	struct FMatrixEntry
	{
		FString SdkKey;
		bool bVariation = false;
	};

	bool MatrixEntry(const FString& Matrix, FMatrixEntry& Out)
	{
		static const TMap<FString, FMatrixEntry> Map = {
			{ TEXT("testmatrix.csv"), { kPkd + TEXT("AG6C1ngVb0CvM07un6JisQ"), false } },
			{ TEXT("testmatrix_semantic.csv"), { kPkd + TEXT("iV8vH2MBakKxkFZylxHmTg"), false } },
			{ TEXT("testmatrix_number.csv"), { kPkd + TEXT("FCWN-k1dV0iBf8QZrDgjdw"), false } },
			{ TEXT("testmatrix_semantic_2.csv"), { kPkd + TEXT("U8nt3zEhDEO5S2ulubCopA"), false } },
			{ TEXT("testmatrix_sensitive.csv"), { kPkd + TEXT("-0YmVOUNgEGKkgRF-rU65g"), false } },
			{ TEXT("testmatrix_segments_old.csv"),
				{ kPkd + TEXT("y_ZB7o-Xb0Swxth-ZlMSeA"), false } },
			{ TEXT("testmatrix_and_or.csv"), { kJcp + TEXT("ByMO9yZNn02kXcm72lnY1A"), false } },
			{ TEXT("testmatrix_comparators_v6.csv"),
				{ kJcp + TEXT("OfQqcTjfFUGBwMKqtyEOrQ"), false } },
			{ TEXT("testmatrix_prerequisite_flag.csv"),
				{ kJcp + TEXT("JoGwdqJZQ0K2xDy7LnbyOg"), false } },
			{ TEXT("testmatrix_segments.csv"), { kJcp + TEXT("h99HYXWWNE2bH8eWyLAVMA"), false } },
			{ TEXT("testmatrix_unicode.csv"), { kJcp + TEXT("Da6w8dBbmUeMUBhh0iEeQQ"), false } },
			{ TEXT("testmatrix_variationId.csv"),
				{ kPkd + TEXT("spQnkRTIPEWVivZkWM84lQ"), true } },
		};
		const FMatrixEntry* Found = Map.Find(Matrix);
		if (Found == nullptr)
		{
			return false;
		}
		Out = *Found;
		return true;
	}

	// ── type-aware default + value equality ───────────────────────────────────

	int32 SettingTypeOf(const TSharedPtr<FJsonObject>& Config, const FString& Key)
	{
		if (!Config.IsValid())
		{
			return -1;
		}
		const TSharedPtr<FJsonObject>* F = nullptr;
		if (!Config->TryGetObjectField(TEXT("f"), F) || !F)
		{
			return -1;
		}
		const TSharedPtr<FJsonObject>* S = nullptr;
		if (!(*F)->TryGetObjectField(Key, S) || !S || !S->IsValid())
		{
			return -1;
		}
		double T = 0.0;
		if (!(*S)->TryGetNumberField(TEXT("t"), T))
		{
			return -1;
		}
		return static_cast<int32>(T);
	}

	// A typed default matching the resolved primitive type.
	FConfeatureDefaultValue DefaultFor(const TSharedPtr<FJsonValue>& Expected, int32 Type)
	{
		if (Expected.IsValid() && Expected->Type == EJson::Boolean)
		{
			return FConfeatureDefaultValue::Bool(false);
		}
		if (Expected.IsValid() && Expected->Type == EJson::Number)
		{
			return Type == SettingTypeDouble ? FConfeatureDefaultValue::Double(0.0)
											 : FConfeatureDefaultValue::Int(0);
		}
		return FConfeatureDefaultValue::String(TEXT("__default__"));
	}

	// Build a typed default from a JSON-decoded eval-log defaultValue + the `t`.
	FConfeatureDefaultValue CoerceDefault(const TSharedPtr<FJsonValue>& Def, int32 Type)
	{
		if (!Def.IsValid() || Def->Type == EJson::Null)
		{
			// No explicit default → fall back to the type-shaped default.
			switch (Type)
			{
				case SettingTypeBool:
					return FConfeatureDefaultValue::Bool(false);
				case SettingTypeInt:
					return FConfeatureDefaultValue::Int(0);
				case SettingTypeDouble:
					return FConfeatureDefaultValue::Double(0.0);
				default:
					return FConfeatureDefaultValue::String(TEXT("__default__"));
			}
		}
		if (Def->Type == EJson::Boolean)
		{
			return FConfeatureDefaultValue::Bool(Def->AsBool());
		}
		if (Def->Type == EJson::Number)
		{
			return Type == SettingTypeDouble
				? FConfeatureDefaultValue::Double(Def->AsNumber())
				: FConfeatureDefaultValue::Int(static_cast<int32>(Def->AsNumber()));
		}
		return FConfeatureDefaultValue::String(Def->AsString());
	}

	// Extract the resolved value from an FEvalResult as an FJsonValue for
	// comparison against the expected JSON cell.
	TSharedPtr<FJsonValue> ResultAsJson(const FEvalResult& R)
	{
		switch (R.ResolvedType)
		{
			case SettingTypeBool:
				return MakeShared<FJsonValueBoolean>(R.BoolValue);
			case SettingTypeString:
				return MakeShared<FJsonValueString>(R.StringValue);
			case SettingTypeInt:
				return MakeShared<FJsonValueNumber>(static_cast<double>(R.IntValue));
			case SettingTypeDouble:
				return MakeShared<FJsonValueNumber>(R.DoubleValue);
			default:
				return MakeShared<FJsonValueNull>();
		}
	}

	// Numeric-tolerant equality (5 == 5.0); booleans never equate with numbers.
	bool ValueEqual(const TSharedPtr<FJsonValue>& Actual, const TSharedPtr<FJsonValue>& Expected)
	{
		if (!Expected.IsValid())
		{
			return !Actual.IsValid();
		}
		if (Expected->Type == EJson::Number)
		{
			if (!Actual.IsValid() || Actual->Type != EJson::Number)
			{
				return false;
			}
			return Actual->AsNumber() == Expected->AsNumber();
		}
		if (Expected->Type == EJson::Boolean)
		{
			return Actual.IsValid() && Actual->Type == EJson::Boolean
				&& Actual->AsBool() == Expected->AsBool();
		}
		if (Expected->Type == EJson::String)
		{
			return Actual.IsValid() && Actual->Type == EJson::String
				&& Actual->AsString().Equals(Expected->AsString(), ESearchCase::CaseSensitive);
		}
		return false;
	}

	FString JsonToStr(const TSharedPtr<FJsonValue>& V)
	{
		if (!V.IsValid())
		{
			return TEXT("<null>");
		}
		FString Out;
		const TSharedRef<TJsonWriter<>> W = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(V.ToSharedRef(), TEXT(""), W);
		return Out.TrimStartAndEnd();
	}

	// ── matrix tuple collection ────────────────────────────────────────────────

	struct FMatrixTuple
	{
		FString Label;
		FString Key;
		FConfeatureUser User;
		bool bHasUser = false;
		bool bVariation = false;
		TSharedPtr<FJsonValue> Expected;
		TSharedPtr<FJsonObject> Config;
	};

	bool UserFromRow(const TArray<FString>& Cols, const FString& CustomKey, FConfeatureUser& Out)
	{
		if (Cols.Num() == 0 || Cols[0] == kNullToken)
		{
			return false;  // no user
		}
		auto SetOrNull = [](const FString& V) -> bool { return !(V.IsEmpty() || V == kNullToken); };
		Out.Identifier = !Cols[0].IsEmpty() ? Cols[0] : FString();
		if (Cols.Num() > 1 && SetOrNull(Cols[1]))
		{
			Out.Email = Cols[1];
		}
		if (Cols.Num() > 2 && SetOrNull(Cols[2]))
		{
			Out.Country = Cols[2];
		}
		if (Cols.Num() > 3 && SetOrNull(Cols[3]))
		{
			Out.Custom.Add(CustomKey, Cols[3]);
		}
		return true;
	}

	TArray<FMatrixTuple> LoadMatrix(FAutomationTestBase& Test, const FString& UpstreamDir,
		const TSharedPtr<FJsonObject>& ContentByKey, const FString& Matrix)
	{
		TArray<FMatrixTuple> Out;
		FMatrixEntry Entry;
		if (!MatrixEntry(Matrix, Entry))
		{
			Test.AddError(FString::Printf(TEXT("Unknown matrix %s"), *Matrix));
			return Out;
		}
		const TSharedPtr<FJsonObject>* ConfigPtr = nullptr;
		if (!ContentByKey.IsValid()
			|| !ContentByKey->TryGetObjectField(Entry.SdkKey, ConfigPtr) || !ConfigPtr)
		{
			Test.AddError(FString::Printf(TEXT("No config for sdkKey %s"), *Entry.SdkKey));
			return Out;
		}
		const TSharedPtr<FJsonObject> Config = *ConfigPtr;

		const TArray<FString> Lines = SplitLines(ReadText(FPaths::Combine(UpstreamDir, Matrix)));
		if (Lines.Num() <= 1)
		{
			Test.AddError(FString::Printf(TEXT("Empty matrix %s"), *Matrix));
			return Out;
		}
		const TArray<FString> Header = ParseCsvLine(Lines[0]);
		const FString CustomKey = Header.Num() > 3 ? Header[3] : TEXT("Custom1");
		TArray<FString> SettingKeys;
		for (int32 i = 4; i < Header.Num(); ++i)
		{
			SettingKeys.Add(Header[i]);
		}

		for (int32 r = 1; r < Lines.Num(); ++r)
		{
			const TArray<FString> Cols = ParseCsvLine(Lines[r]);
			FConfeatureUser User;
			const bool bHasUser = UserFromRow(Cols, CustomKey, User);
			for (int32 c = 0; c < SettingKeys.Num(); ++c)
			{
				const FString Raw = (c + 4) < Cols.Num() ? Cols[c + 4] : FString();
				FMatrixTuple T;
				T.Key = SettingKeys[c];
				T.User = User;
				T.bHasUser = bHasUser;
				T.bVariation = Entry.bVariation;
				T.Expected =
					Entry.bVariation ? MakeShared<FJsonValueString>(Raw) : ParseCell(Raw);
				T.Config = Config;
				T.Label = FString::Printf(TEXT("%s %s id=%s"), *Matrix, *T.Key,
					bHasUser ? *User.Identifier : TEXT("<none>"));
				Out.Add(MoveTemp(T));
			}
		}
		return Out;
	}

	void AssertMatrixTuple(FAutomationTestBase& Test, const FMatrixTuple& T, int32& Failures)
	{
		const FConfeatureUser* UserPtr = T.bHasUser ? &T.User : nullptr;
		if (T.bVariation)
		{
			// Variation matrix carries no per-row default; ConfigCat resolves the
			// variationId via a NULL default, which opts out of the type guard so
			// the served value + id resolve regardless of the flag's declared type
			// (mirrors the C++ port's `json(nullptr)`).
			const FEvalResult R =
				Evaluate(T.Config, T.Key, FConfeatureDefaultValue::Null(), UserPtr);
			const FString ExpectedId = T.Expected->AsString();
			if (R.VariationId != ExpectedId)
			{
				++Failures;
				Test.AddError(FString::Printf(TEXT("%s: variationId actual=%s expected=%s"),
					*T.Label, *R.VariationId, *ExpectedId));
			}
			return;
		}
		const FConfeatureDefaultValue Def =
			DefaultFor(T.Expected, SettingTypeOf(T.Config, T.Key));
		const FEvalResult R = Evaluate(T.Config, T.Key, Def, UserPtr);
		const TSharedPtr<FJsonValue> Actual = ResultAsJson(R);
		if (!ValueEqual(Actual, T.Expected))
		{
			++Failures;
			Test.AddError(FString::Printf(TEXT("%s: actual=%s expected=%s"), *T.Label,
				*JsonToStr(Actual), *JsonToStr(T.Expected)));
		}
	}

	// ── eval-log scenario loading ──────────────────────────────────────────────

	struct FEvalLogTuple
	{
		FString Label;
		FString Key;
		TSharedPtr<FJsonValue> DefaultValue;  // null when absent
		FConfeatureUser User;
		bool bHasUser = false;
		TSharedPtr<FJsonValue> Expected;
		TSharedPtr<FJsonObject> Config;
	};

	FConfeatureUser EvalLogUser(const TSharedPtr<FJsonObject>& Raw, bool& bHasUser)
	{
		FConfeatureUser User;
		bHasUser = false;
		if (!Raw.IsValid() || Raw->Values.Num() == 0)
		{
			return User;
		}
		bHasUser = true;
		TSharedPtr<FJsonObject> Custom = MakeShared<FJsonObject>();
		FString Email;
		FString Country;
		bool bHasEmail = false;
		bool bHasCountry = false;
		for (const auto& Pair : Raw->Values)
		{
			if (Pair.Key == TEXT("Identifier"))
			{
				User.Identifier = Pair.Value.IsValid() && Pair.Value->Type == EJson::String
					? Pair.Value->AsString()
					: UserAttributeValueToString(Pair.Value);
			}
			else if (Pair.Key == TEXT("Email"))
			{
				Email = Pair.Value.IsValid() && Pair.Value->Type == EJson::String
					? Pair.Value->AsString()
					: UserAttributeValueToString(Pair.Value);
				bHasEmail = true;
			}
			else if (Pair.Key == TEXT("Country"))
			{
				Country = Pair.Value.IsValid() && Pair.Value->Type == EJson::String
					? Pair.Value->AsString()
					: UserAttributeValueToString(Pair.Value);
				bHasCountry = true;
			}
			else
			{
				Custom->SetField(Pair.Key, Pair.Value);
			}
		}
		User = MakeUser(User.Identifier, Custom);
		if (bHasEmail)
		{
			User.Email = Email;
		}
		if (bHasCountry)
		{
			User.Country = Country;
		}
		return User;
	}

	TSharedPtr<FJsonObject> EvalLogConfig(FAutomationTestBase& Test, const FString& UpstreamDir,
		const TSharedPtr<FJsonObject>& ContentByKey, const TSharedPtr<FJsonObject>& EvalLogConfigs,
		const TSharedPtr<FJsonObject>& Suite)
	{
		FString Override;
		if (Suite->TryGetStringField(TEXT("jsonOverride"), Override) && !Override.IsEmpty())
		{
			return ReadJsonObject(
				UpstreamDir, FPaths::Combine(TEXT("evaluationlog"), TEXT("_overrides"), Override));
		}
		FString SdkKey;
		if (Suite->TryGetStringField(TEXT("sdkKey"), SdkKey) && !SdkKey.IsEmpty())
		{
			const TSharedPtr<FJsonObject>* Cfg = nullptr;
			if (ContentByKey.IsValid() && ContentByKey->TryGetObjectField(SdkKey, Cfg) && Cfg)
			{
				return *Cfg;
			}
			if (EvalLogConfigs.IsValid() && EvalLogConfigs->TryGetObjectField(SdkKey, Cfg) && Cfg)
			{
				return *Cfg;
			}
			Test.AddError(FString::Printf(TEXT("No config for eval-log sdkKey %s"), *SdkKey));
			return nullptr;
		}
		Test.AddError(TEXT("Eval-log suite has neither jsonOverride nor sdkKey"));
		return nullptr;
	}

	TArray<FEvalLogTuple> LoadEvalLog(FAutomationTestBase& Test, const FString& UpstreamDir,
		const TSharedPtr<FJsonObject>& ContentByKey, const TSharedPtr<FJsonObject>& EvalLogConfigs,
		const FString& Scenario)
	{
		TArray<FEvalLogTuple> Out;
		const TSharedPtr<FJsonObject> Suite = ReadJsonObject(
			UpstreamDir, FPaths::Combine(TEXT("evaluationlog"), Scenario + TEXT(".json")));
		if (!Suite.IsValid())
		{
			Test.AddError(FString::Printf(TEXT("Missing eval-log scenario %s"), *Scenario));
			return Out;
		}
		const TSharedPtr<FJsonObject> Config =
			EvalLogConfig(Test, UpstreamDir, ContentByKey, EvalLogConfigs, Suite);
		const TArray<TSharedPtr<FJsonValue>>* Tests = nullptr;
		if (!Suite->TryGetArrayField(TEXT("tests"), Tests) || !Tests)
		{
			return Out;
		}
		for (const TSharedPtr<FJsonValue>& TV : *Tests)
		{
			if (!TV.IsValid() || TV->Type != EJson::Object)
			{
				continue;
			}
			const TSharedPtr<FJsonObject> T = TV->AsObject();
			FEvalLogTuple E;
			T->TryGetStringField(TEXT("key"), E.Key);
			E.DefaultValue = T->TryGetField(TEXT("defaultValue"));
			const TSharedPtr<FJsonObject>* UserObj = nullptr;
			if (T->TryGetObjectField(TEXT("user"), UserObj) && UserObj)
			{
				E.User = EvalLogUser(*UserObj, E.bHasUser);
			}
			E.Expected = T->TryGetField(TEXT("returnValue"));
			E.Config = Config;
			E.Label = FString::Printf(TEXT("%s %s id=%s"), *Scenario, *E.Key,
				E.bHasUser ? *E.User.Identifier : TEXT("<none>"));
			Out.Add(MoveTemp(E));
		}
		return Out;
	}

	void AssertEvalLogTuple(FAutomationTestBase& Test, const FEvalLogTuple& T, int32& Failures)
	{
		const int32 Type = SettingTypeOf(T.Config, T.Key);
		const FConfeatureDefaultValue Def =
			(!T.DefaultValue.IsValid() || T.DefaultValue->Type == EJson::Null)
			? DefaultFor(T.Expected, Type)
			: CoerceDefault(T.DefaultValue, Type);
		const FConfeatureUser* UserPtr = T.bHasUser ? &T.User : nullptr;
		const FEvalResult R = Evaluate(T.Config, T.Key, Def, UserPtr);
		const TSharedPtr<FJsonValue> Actual = ResultAsJson(R);
		if (!ValueEqual(Actual, T.Expected))
		{
			++Failures;
			Test.AddError(FString::Printf(TEXT("%s: actual=%s expected=%s"), *T.Label,
				*JsonToStr(Actual), *JsonToStr(T.Expected)));
		}
	}

	// ── comparison_*.json conversion / trimming drivers (US5) ───────────────────

	double Inf() { return TNumericLimits<double>::Max() * 2.0; }
	double NegInf() { return -Inf(); }
	double Nan() { return FMath::Sqrt(-1.0); }

	void DriveConversion(FAutomationTestBase& Test, const TSharedPtr<FJsonObject>& Config,
		const FString& Key, const TSharedPtr<FJsonValue>& Custom1, const FString& Expected,
		int32& Failures)
	{
		FConfeatureUser User;
		User.Identifier = TEXT("12345");
		User.Custom.Add(TEXT("Custom1"), UserAttributeValueToString(Custom1));
		const FEvalResult R = Evaluate(
			Config, Key, FConfeatureDefaultValue::String(TEXT("default")), &User);
		if (R.StringValue != Expected)
		{
			++Failures;
			Test.AddError(FString::Printf(TEXT("conversion %s: actual=%s expected=%s"), *Key,
				*R.StringValue, *Expected));
		}
	}

	// Drives the attribute-trimming / value-trimming comparison configs. The
	// two share the same "no trim" key set; the value driver omits the two
	// contains keys. Mirrors the C++ test's attributeTrimmingDriver /
	// valueTrimmingDriver tables.
	void RunTrimDriver(FAutomationTestBase& Test, const TSharedPtr<FJsonObject>& Config,
		const FConfeatureUser& User, bool bValueDriver, int32& Failures)
	{
		TArray<TPair<FString, FString>> Cases;
		const TCHAR* NoTrimKeys[] = { TEXT("isoneof"), TEXT("isnotoneof"), TEXT("isoneofhashed"),
			TEXT("isnotoneofhashed"), TEXT("equalshashed"), TEXT("notequalshashed"),
			TEXT("arraycontainsanyofhashed"), TEXT("arraynotcontainsanyofhashed"), TEXT("equals"),
			TEXT("notequals"), TEXT("startwithanyof"), TEXT("notstartwithanyof"),
			TEXT("endswithanyof"), TEXT("notendswithanyof"), TEXT("arraycontainsanyof"),
			TEXT("arraynotcontainsanyof"), TEXT("startwithanyofhashed"),
			TEXT("notstartwithanyofhashed"), TEXT("endswithanyofhashed"),
			TEXT("notendswithanyofhashed") };
		for (const TCHAR* K : NoTrimKeys)
		{
			Cases.Add({ K, TEXT("no trim") });
		}
		if (bValueDriver)
		{
			Cases.Add({ TEXT("containsanyof"), TEXT("no trim") });
			Cases.Add({ TEXT("notcontainsanyof"), TEXT("no trim") });
		}
		Cases.Add({ TEXT("semverisoneof"), TEXT("4 trim") });
		Cases.Add({ TEXT("semverisnotoneof"), TEXT("5 trim") });
		Cases.Add({ TEXT("semverless"), TEXT("6 trim") });
		Cases.Add({ TEXT("semverlessequals"), TEXT("7 trim") });
		Cases.Add({ TEXT("semvergreater"), TEXT("8 trim") });
		Cases.Add({ TEXT("semvergreaterequals"), TEXT("9 trim") });
		if (!bValueDriver)
		{
			Cases.Add({ TEXT("numberequals"), TEXT("10 trim") });
			Cases.Add({ TEXT("numbernotequals"), TEXT("11 trim") });
			Cases.Add({ TEXT("numberless"), TEXT("12 trim") });
			Cases.Add({ TEXT("numberlessequals"), TEXT("13 trim") });
			Cases.Add({ TEXT("numbergreater"), TEXT("14 trim") });
			Cases.Add({ TEXT("numbergreaterequals"), TEXT("15 trim") });
			Cases.Add({ TEXT("datebefore"), TEXT("18 trim") });
			Cases.Add({ TEXT("dateafter"), TEXT("19 trim") });
			Cases.Add({ TEXT("containsanyof"), TEXT("no trim") });
			Cases.Add({ TEXT("notcontainsanyof"), TEXT("no trim") });
		}

		for (const TPair<FString, FString>& C : Cases)
		{
			const FEvalResult R = Evaluate(
				Config, C.Key, FConfeatureDefaultValue::String(TEXT("default")), &User);
			if (R.StringValue != C.Value)
			{
				++Failures;
				Test.AddError(FString::Printf(TEXT("trim %s: actual=%s expected=%s"), *C.Key,
					*R.StringValue, *C.Value));
			}
		}
	}

	void RunComparisonDrivers(
		FAutomationTestBase& Test, const FString& UpstreamDir, int32& Failures)
	{
		// — attribute conversion (NaN / Inf / exp / array) —
		{
			const TSharedPtr<FJsonObject> Config =
				ReadJsonObject(UpstreamDir, TEXT("comparison_attribute_conversion.json"));
			auto Num = [](double V) -> TSharedPtr<FJsonValue> {
				return MakeShared<FJsonValueNumber>(V);
			};
			auto Arr = [](std::initializer_list<const TCHAR*> Items) -> TSharedPtr<FJsonValue> {
				TArray<TSharedPtr<FJsonValue>> A;
				for (const TCHAR* I : Items)
				{
					A.Add(MakeShared<FJsonValueString>(FString(I)));
				}
				return MakeShared<FJsonValueArray>(A);
			};
			DriveConversion(Test, Config, TEXT("numberToStringConversion"), Num(0.12345), TEXT("1"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionInt"), Num(125), TEXT("4"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionPositiveExp"), Num(-1.23456789e96), TEXT("2"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionNegativeExp"), Num(-1.23456789e-96), TEXT("4"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionNaN"), Num(Nan()), TEXT("3"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionPositiveInf"), Num(Inf()), TEXT("4"), Failures);
			DriveConversion(Test, Config, TEXT("numberToStringConversionNegativeInf"), Num(NegInf()), TEXT("3"), Failures);
			DriveConversion(Test, Config, TEXT("dateToStringConversion"), Num(1680307199.999), TEXT("3"), Failures);
			DriveConversion(Test, Config, TEXT("dateToStringConversionNaN"), Num(Nan()), TEXT("3"), Failures);
			DriveConversion(Test, Config, TEXT("dateToStringConversionPositiveInf"), Num(Inf()), TEXT("1"), Failures);
			DriveConversion(Test, Config, TEXT("dateToStringConversionNegativeInf"), Num(NegInf()), TEXT("5"), Failures);
			DriveConversion(Test, Config, TEXT("stringArrayToStringConversion"), Arr({ TEXT("read"), TEXT("Write"), TEXT(" eXecute ") }), TEXT("4"), Failures);
			DriveConversion(Test, Config, TEXT("stringArrayToStringConversionEmpty"), Arr({}), TEXT("5"), Failures);
			DriveConversion(Test, Config, TEXT("stringArrayToStringConversionSpecialChars"), Arr({ TEXT("+<>%\"'\\/\t\r\n") }), TEXT("3"), Failures);
			DriveConversion(Test, Config, TEXT("stringArrayToStringConversionUnicode"), Arr({ TEXT("äöüÄÖÜçéèñışğâ¢™✓😀") }), TEXT("2"), Failures);
		}

		// — attribute trimming —
		{
			const TSharedPtr<FJsonObject> Config =
				ReadJsonObject(UpstreamDir, TEXT("comparison_attribute_trimming.json"));
			FConfeatureUser User;
			User.Identifier = TEXT(" 12345 ");
			User.Country = TEXT("[\" USA \"]");
			User.Custom.Add(TEXT("Version"), TEXT(" 1.0.0 "));
			User.Custom.Add(TEXT("Number"), TEXT(" 3 "));
			User.Custom.Add(TEXT("Date"), TEXT(" 1705253400 "));
			RunTrimDriver(Test, Config, User, /*bValueDriver=*/false, Failures);
		}

		// — comparison-value trimming —
		{
			const TSharedPtr<FJsonObject> Config =
				ReadJsonObject(UpstreamDir, TEXT("comparison_value_trimming.json"));
			FConfeatureUser User;
			User.Identifier = TEXT("12345");
			User.Country = TEXT("[\"USA\"]");
			User.Custom.Add(TEXT("Version"), TEXT("1.0.0"));
			User.Custom.Add(TEXT("Number"), TEXT("3"));
			User.Custom.Add(TEXT("Date"), TEXT("1705253400"));
			RunTrimDriver(Test, Config, User, /*bValueDriver=*/true, Failures);
		}
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FConfeatureUpstreamCorpusTest, "Confeature.Upstream.Corpus",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext
		| EAutomationTestFlags::ServerContext | EAutomationTestFlags::CommandletContext
		| EAutomationTestFlags::EngineFilter)

bool FConfeatureUpstreamCorpusTest::RunTest(const FString& /*Parameters*/)
{
	using namespace Confeature::Internal;

	const FString UpstreamDir = Confeature::Tests::FindUpstreamFixturesDirectory();
	if (UpstreamDir.IsEmpty())
	{
		AddWarning(TEXT("Skipping EvaluatorUpstreamCorpusTest: "
						"packages/test-fixtures-sdk-parity/fixtures/upstream not found."));
		return true;
	}

	const TSharedPtr<FJsonObject> ContentByKey = ReadJsonObject(UpstreamDir, TEXT("content-by-key.json"));
	const TSharedPtr<FJsonObject> EvalLogConfigs = ReadJsonObject(
		UpstreamDir, FPaths::Combine(TEXT("evaluationlog"), TEXT("_configs-by-key.json")));
	if (!ContentByKey.IsValid())
	{
		AddError(TEXT("Failed to load content-by-key.json"));
		return false;
	}

	int32 Failures = 0;
	int32 Total = 0;

	// ── value + comparator matrices (US1 / US2) ────────────────────────────────
	for (const FString& Matrix : { TEXT("testmatrix.csv"), TEXT("testmatrix_comparators_v6.csv"),
			 TEXT("testmatrix_semantic.csv"), TEXT("testmatrix_semantic_2.csv"),
			 TEXT("testmatrix_number.csv"), TEXT("testmatrix_sensitive.csv"),
			 TEXT("testmatrix_unicode.csv") })
	{
		const TArray<FMatrixTuple> Tuples = LoadMatrix(*this, UpstreamDir, ContentByKey, Matrix);
		TestTrue(FString::Printf(TEXT("%s non-empty"), *Matrix), Tuples.Num() > 0);
		for (const FMatrixTuple& T : Tuples)
		{
			AssertMatrixTuple(*this, T, Failures);
			++Total;
		}
	}

	// ── segment / prerequisite / and-or matrices (US4) ─────────────────────────
	for (const FString& Matrix :
		{ TEXT("testmatrix_and_or.csv"), TEXT("testmatrix_segments.csv"),
			TEXT("testmatrix_segments_old.csv"), TEXT("testmatrix_prerequisite_flag.csv") })
	{
		const TArray<FMatrixTuple> Tuples = LoadMatrix(*this, UpstreamDir, ContentByKey, Matrix);
		TestTrue(FString::Printf(TEXT("%s non-empty"), *Matrix), Tuples.Num() > 0);
		for (const FMatrixTuple& T : Tuples)
		{
			AssertMatrixTuple(*this, T, Failures);
			++Total;
		}
	}

	// ── variationId matrix (US5, FR-011) ───────────────────────────────────────
	{
		const TArray<FMatrixTuple> Tuples =
			LoadMatrix(*this, UpstreamDir, ContentByKey, TEXT("testmatrix_variationId.csv"));
		TestTrue(TEXT("variationId matrix non-empty"), Tuples.Num() > 0);
		for (const FMatrixTuple& T : Tuples)
		{
			AssertMatrixTuple(*this, T, Failures);
			++Total;
		}
	}

	// ── eval-log scenarios ──────────────────────────────────────────────────────
	auto RunScenarios = [&](std::initializer_list<const TCHAR*> Scenarios)
	{
		for (const TCHAR* Scenario : Scenarios)
		{
			for (const FEvalLogTuple& T :
				LoadEvalLog(*this, UpstreamDir, ContentByKey, EvalLogConfigs, Scenario))
			{
				// #401: the multilevel-prerequisite config blob was not
				// vendored — covered by the reconstructed-chain test below.
				if (T.Key == kUnvendoredEvalLogKey)
				{
					continue;
				}
				AssertEvalLogTuple(*this, T, Failures);
				++Total;
			}
		}
	};

	// US1 — targeting-rule scenarios.
	RunScenarios({ TEXT("1_targeting_rule"), TEXT("2_targeting_rules"), TEXT("simple_value") });
	// US3 — percentage scenarios.
	RunScenarios({ TEXT("options_based_on_user_id"), TEXT("options_based_on_custom_attr"),
		TEXT("options_after_targeting_rule"), TEXT("options_within_targeting_rule") });
	// US4 — segment / prerequisite / and-rule scenarios.
	RunScenarios({ TEXT("segment"), TEXT("prerequisite_flag"), TEXT("and_rules") });
	// US5 — validation + list-truncation scenarios.
	RunScenarios({ TEXT("semver_validation"), TEXT("number_validation"),
		TEXT("epoch_date_validation"), TEXT("list_truncation") });

	TestTrue(TEXT("corpus is non-vacuous"), Total > 0);
	TestEqual(TEXT("corpus drift count"), Failures, 0);

	// ── focused identity + determinism + bounded-cycle assertions ──────────────

	// US1 — matched-rule identity + no-user fallback (FR-017).
	{
		const TArray<FEvalLogTuple> Cases =
			LoadEvalLog(*this, UpstreamDir, ContentByKey, EvalLogConfigs, TEXT("1_targeting_rule"));
		const FEvalLogTuple* Matching = nullptr;
		const FEvalLogTuple* NoUser = nullptr;
		for (const FEvalLogTuple& C : Cases)
		{
			if (C.Expected.IsValid() && C.Expected->Type == EJson::String
				&& C.Expected->AsString() == TEXT("Dog"))
			{
				Matching = &C;
			}
			if (!C.bHasUser)
			{
				NoUser = &C;
			}
		}
		if (Matching && NoUser)
		{
			const FEvalResult M = Evaluate(Matching->Config, Matching->Key,
				FConfeatureDefaultValue::String(TEXT("default")), &Matching->User);
			TestEqual(TEXT("matched rule value"), M.StringValue, TEXT("Dog"));
			TestTrue(TEXT("matched rule flag"), M.bHasMatchedRule);
			TestFalse(TEXT("matched rule not option"), M.bHasMatchedOption);
			TestTrue(TEXT("matched rule no error"), M.Error.IsEmpty());

			const FEvalResult N = Evaluate(NoUser->Config, NoUser->Key,
				FConfeatureDefaultValue::String(TEXT("default")), nullptr);
			TestEqual(TEXT("no-user fallback value"), N.StringValue, TEXT("Cat"));
			TestTrue(TEXT("no-user clean resolve"), N.Error.IsEmpty());
			TestFalse(TEXT("no-user surfaced eval error"), N.EvalError.IsEmpty());
			TestTrue(TEXT("no-user error mentions missing user"),
				N.EvalError.Contains(TEXT("User Object is missing")));
			TestFalse(TEXT("no-user not matched rule"), N.bHasMatchedRule);
		}
		else
		{
			AddError(TEXT("1_targeting_rule: missing matching / no-user case"));
		}
	}

	// US3 — percentage determinism (repeat-invariance, FR-005).
	{
		const TArray<FEvalLogTuple> Cases = LoadEvalLog(
			*this, UpstreamDir, ContentByKey, EvalLogConfigs, TEXT("options_based_on_user_id"));
		const FEvalLogTuple* WithUser = nullptr;
		for (const FEvalLogTuple& C : Cases)
		{
			if (C.bHasUser)
			{
				WithUser = &C;
				break;
			}
		}
		if (WithUser)
		{
			const int32 Type = SettingTypeOf(WithUser->Config, WithUser->Key);
			const FConfeatureDefaultValue Def =
				(!WithUser->DefaultValue.IsValid() || WithUser->DefaultValue->Type == EJson::Null)
				? DefaultFor(WithUser->Expected, Type)
				: CoerceDefault(WithUser->DefaultValue, Type);
			const FEvalResult First = Evaluate(WithUser->Config, WithUser->Key, Def, &WithUser->User);
			bool bStable = true;
			for (int32 i = 0; i < 20; ++i)
			{
				const FEvalResult Again =
					Evaluate(WithUser->Config, WithUser->Key, Def, &WithUser->User);
				if (Again.VariationId != First.VariationId
					|| !ValueEqual(ResultAsJson(Again), ResultAsJson(First)))
				{
					bStable = false;
					break;
				}
			}
			TestTrue(TEXT("percentage bucketing is repeat-invariant"), bStable);
			TestTrue(TEXT("percentage matched option"), First.bHasMatchedOption);
		}
	}

	// US3 — in-rule percentage option reports rule+option+variationId (the bug
	// the C++ corpus caught; isolated here from the hash via a 100%-weighted
	// option so the variationId source is deterministic).
	{
		const FString Raw = TEXT("{")
			TEXT("\"p\": {\"u\": \"\", \"r\": 0, \"s\": \"salt\"},")
			TEXT("\"s\": [],")
			TEXT("\"f\": {")
			TEXT("\"inRulePct\": {")
			TEXT("\"t\": 1, \"a\": \"Identifier\", \"v\": {\"s\": \"off\"}, \"i\": \"setLevel\",")
			TEXT("\"r\": [{")
			TEXT("\"c\": [{\"u\": {\"a\": \"Email\", \"c\": 2, \"l\": [\"@configcat.com\"]}}],")
			TEXT("\"p\": [{\"p\": 100, \"v\": {\"s\": \"on\"}, \"i\": \"optHit\"}]")
			TEXT("}]}}}");
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		TSharedPtr<FJsonObject> Config;
		FJsonSerializer::Deserialize(Reader, Config);
		FConfeatureUser MatchUser;
		MatchUser.Identifier = TEXT("12345");
		MatchUser.Email = TEXT("joe@configcat.com");
		const FEvalResult RR = Evaluate(
			Config, TEXT("inRulePct"), FConfeatureDefaultValue::String(TEXT("default")), &MatchUser);
		TestEqual(TEXT("in-rule option value"), RR.StringValue, TEXT("on"));
		TestTrue(TEXT("in-rule matched rule"), RR.bHasMatchedRule);
		TestTrue(TEXT("in-rule matched option"), RR.bHasMatchedOption);
		TestEqual(TEXT("in-rule variationId is option-level"), RR.VariationId, TEXT("optHit"));
	}

	// US4 — multilevel prerequisite chain (#401 reconstructed: A->B->C).
	{
		const FString Raw = TEXT("{")
			TEXT("\"p\": {\"u\": \"\", \"r\": 0, \"s\": \"salt\"}, \"s\": [],")
			TEXT("\"f\": {")
			TEXT("\"mainFeatureWithoutUserCondition\": {\"t\": 0, \"v\": {\"b\": true}, \"i\": \"main\", \"r\": []},")
			TEXT("\"intermediateFeature\": {\"t\": 0, \"v\": {\"b\": false}, \"i\": \"inter\",")
			TEXT("\"r\": [{\"c\": [")
			TEXT("{\"p\": {\"f\": \"mainFeatureWithoutUserCondition\", \"c\": 0, \"v\": {\"b\": true}}},")
			TEXT("{\"p\": {\"f\": \"mainFeatureWithoutUserCondition\", \"c\": 0, \"v\": {\"b\": true}}}")
			TEXT("], \"s\": {\"v\": {\"b\": true}, \"i\": \"interT\"}}]},")
			TEXT("\"dependentFeatureMultipleLevels\": {\"t\": 1, \"v\": {\"s\": \"Cat\"}, \"i\": \"dep\",")
			TEXT("\"r\": [{\"c\": [{\"p\": {\"f\": \"intermediateFeature\", \"c\": 0, \"v\": {\"b\": true}}}],")
			TEXT("\"s\": {\"v\": {\"s\": \"Dog\"}, \"i\": \"depDog\"}}]}}}");
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		TSharedPtr<FJsonObject> Config;
		FJsonSerializer::Deserialize(Reader, Config);
		const FEvalResult R = Evaluate(Config, kUnvendoredEvalLogKey,
			FConfeatureDefaultValue::String(TEXT("default")), nullptr);
		TestEqual(TEXT("multilevel prereq value"), R.StringValue, TEXT("Dog"));
		TestTrue(TEXT("multilevel prereq matched rule"), R.bHasMatchedRule);
	}

	// US4 — circular dependency is bounded + fail-closed (SC-004).
	{
		const double Start = FPlatformTime::Seconds();
		bool bCycleOk = true;
		for (const FEvalLogTuple& T :
			LoadEvalLog(*this, UpstreamDir, ContentByKey, EvalLogConfigs, TEXT("circular_dep")))
		{
			const double T0 = FPlatformTime::Seconds();
			const FEvalResult R = Evaluate(T.Config, T.Key,
				CoerceDefault(T.DefaultValue, SettingTypeOf(T.Config, T.Key)),
				T.bHasUser ? &T.User : nullptr);
			const double Elapsed = FPlatformTime::Seconds() - T0;
			if (Elapsed >= 1.0)
			{
				bCycleOk = false;
				AddError(FString::Printf(TEXT("%s: cycle not bounded (%.3fs)"), *T.Key, Elapsed));
			}
			// circular_dep expects the fail-closed default + an error code.
			if (R.Error.IsEmpty())
			{
				bCycleOk = false;
				AddError(FString::Printf(TEXT("%s: resolved with no error code"), *T.Key));
			}
		}
		TestTrue(TEXT("circular dependency bounded + fail-closed"), bCycleOk);
		(void) Start;
	}

	// US4 — direct two-flag cycle terminates fail-closed.
	{
		const FString Raw = TEXT("{")
			TEXT("\"p\": {\"u\": \"\", \"r\": 0, \"s\": \"salt\"}, \"s\": [],")
			TEXT("\"f\": {")
			TEXT("\"flagA\": {\"t\": 1, \"v\": {\"s\": \"A\"}, \"i\": \"a\",")
			TEXT("\"r\": [{\"c\": [{\"p\": {\"f\": \"flagB\", \"c\": 0, \"v\": {\"b\": true}}}], \"s\": {\"v\": {\"s\": \"AA\"}, \"i\": \"aa\"}}]},")
			TEXT("\"flagB\": {\"t\": 1, \"v\": {\"s\": \"B\"}, \"i\": \"b\",")
			TEXT("\"r\": [{\"c\": [{\"p\": {\"f\": \"flagA\", \"c\": 0, \"v\": {\"b\": true}}}], \"s\": {\"v\": {\"s\": \"BB\"}, \"i\": \"bb\"}}]}}}");
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		TSharedPtr<FJsonObject> Config;
		FJsonSerializer::Deserialize(Reader, Config);
		const double T0 = FPlatformTime::Seconds();
		const FEvalResult R = Evaluate(
			Config, TEXT("flagA"), FConfeatureDefaultValue::String(TEXT("default")), nullptr);
		const double Elapsed = FPlatformTime::Seconds() - T0;
		TestTrue(TEXT("two-flag cycle terminates quickly"), Elapsed < 1.0);
		TestEqual(TEXT("two-flag cycle fail-closed value"), R.StringValue, TEXT("default"));
		TestFalse(TEXT("two-flag cycle has error code"), R.Error.IsEmpty());
	}

	// ── comparison_*.json conversion / trimming drivers (US5) ───────────────────
	RunComparisonDrivers(*this, UpstreamDir, Failures);

	// US2 — native-typed numeric attr matches its string form (exercises the
	// comparator conversion path with a non-stringified branch beyond the
	// all-string matrix / eval-log cases; mirrors the C++ port's regression).
	{
		const FString Raw = TEXT("{")
			TEXT("\"p\": {\"u\": \"\", \"r\": 0, \"s\": \"salt\"}, \"s\": [],")
			TEXT("\"f\": {\"numericGate\": {")
			TEXT("\"t\": 1, \"a\": \"Custom1\", \"v\": {\"s\": \"no-match\"}, \"i\": \"ng\",")
			TEXT("\"r\": [{\"c\": [{\"u\": {\"a\": \"Custom1\", \"c\": 15, \"d\": 18.0}}],")
			TEXT("\"s\": {\"v\": {\"s\": \"match\"}, \"i\": \"m\"}}]}}}");
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
		TSharedPtr<FJsonObject> Config;
		FJsonSerializer::Deserialize(Reader, Config);
		struct FNCase
		{
			const TCHAR* Label;
			const TCHAR* Attr;
			const TCHAR* Expected;
		};
		const FNCase Cases[] = {
			{ TEXT("native-int-pass"), TEXT("21"), TEXT("match") },
			{ TEXT("native-float-pass"), TEXT("18.0"), TEXT("match") },
			{ TEXT("native-int-fail"), TEXT("17"), TEXT("no-match") },
			{ TEXT("native-float-fail"), TEXT("17.999"), TEXT("no-match") },
			{ TEXT("string-int-pass"), TEXT("21"), TEXT("match") },
			{ TEXT("string-float-pass"), TEXT("18.0"), TEXT("match") },
			{ TEXT("string-int-fail"), TEXT("17"), TEXT("no-match") },
		};
		for (const FNCase& C : Cases)
		{
			FConfeatureUser User;
			User.Identifier = TEXT("12345");
			User.Custom.Add(TEXT("Custom1"), C.Attr);
			const FEvalResult R = Evaluate(
				Config, TEXT("numericGate"), FConfeatureDefaultValue::String(TEXT("default")), &User);
			TestEqual(FString::Printf(TEXT("numeric attr %s"), C.Label), R.StringValue,
				FString(C.Expected));
		}
	}

	return Failures == 0 && !HasAnyErrors();
}
