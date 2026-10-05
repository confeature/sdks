// SPDX-License-Identifier: MIT

#include "Internal/Evaluator.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Internal/Comparators.h"
#include "Internal/Hashing.h"
#include "Internal/Semver.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

// ConfigCat-parity flag evaluator over a parsed `config_v6.json` body
// (spec 131). Re-ports the corpus-verified C++ engine
// (`apps/sdk-cpp/src/internal/evaluator.cpp`), which ports the spec-117 TS
// decision engine (`packages/sdk-shared/src/evaluator.ts` + comparators /
// semver / hash / segments / prerequisites).
//
// Fail-closed semantics (the pre-existing contract, preserved + extended to
// the targeting path): NEVER throws. Any reason a value can't be cleanly
// resolved — including a residual JSON-shape error or a detected prerequisite
// cycle — returns the supplied default + a tier-0 error code. Because the UE
// module compiles with exceptions disabled, the cycle / shape-error boundary
// uses an error-SENTINEL discipline (a `bHadFatalError` flag threaded through
// the eval context) rather than a C++ try/catch.

namespace Confeature::Internal
{
	namespace
	{
		const TCHAR* const MissingUserError = TEXT("cannot evaluate, User Object is missing");

		FString MissingAttributeError(const FString& Attr)
		{
			return FString::Printf(
				TEXT("cannot evaluate, the User.%s attribute is missing"), *Attr);
		}

		FString InvalidSemVerError(const FString& Attr, const FString& Value)
		{
			return FString::Printf(
				TEXT("cannot evaluate, the User.%s attribute is invalid ('%s' is not a valid "
					 "semantic version)"),
				*Attr, *Value);
		}

		// Three-valued condition outcome: match / no-match / error.
		enum class EOutcomeKind : uint8
		{
			True,
			False,
			Error,
		};

		struct FOutcome
		{
			EOutcomeKind Kind = EOutcomeKind::True;
			FString Error;

			static FOutcome T() { return FOutcome{ EOutcomeKind::True, FString() }; }
			static FOutcome F() { return FOutcome{ EOutcomeKind::False, FString() }; }
			static FOutcome Of(bool bMatch) { return bMatch ? T() : F(); }
			static FOutcome E(FString Msg) { return FOutcome{ EOutcomeKind::Error, MoveTemp(Msg) }; }
			bool IsTrue() const { return Kind == EOutcomeKind::True; }
		};

		// Per-evaluation context threaded through rule / condition /
		// prerequisite resolution. `VisitedFlags` is the shared cycle-detection
		// stack; `bHadFatalError` is the error sentinel that the evaluate()
		// boundary converts to a fail-closed default + EVAL_ERROR.
		struct FEvalContext
		{
			const TSharedPtr<FJsonObject>* Settings = nullptr;  // config["f"]
			const TArray<TSharedPtr<FJsonValue>>* Segments = nullptr;  // config["s"] (may be null)
			FString ConfigSalt;  // config["p"]["s"]
			const FConfeatureUser* User = nullptr;  // optional
			TArray<FString> VisitedFlags;  // cycle-detection stack
			FString EvalError;  // first surfaced (non-fatal) condition error
			bool bHadFatalError = false;  // cycle / malformed-shape sentinel
		};

		// The resolved value envelope + matched-rule/option identity.
		struct FSettingResult
		{
			TSharedPtr<FJsonObject> Value;  // the resolved `v` envelope ({b}/{s}/{i}/{d})
			FString VariationId;
			bool bMatchedRule = false;
			bool bMatchedOption = false;
		};

		// ── JSON helpers (every access type-guarded) ─────────────────────────

		FString GetString(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key)
		{
			FString Out;
			if (Obj.IsValid())
			{
				Obj->TryGetStringField(Key, Out);
			}
			return Out;
		}

		TArray<FString> GetStringList(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Key)
		{
			TArray<FString> Out;
			const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
			if (Obj.IsValid() && Obj->TryGetArrayField(Key, Arr) && Arr)
			{
				for (const TSharedPtr<FJsonValue>& E : *Arr)
				{
					if (E.IsValid() && E->Type == EJson::String)
					{
						Out.Add(E->AsString());
					}
				}
			}
			return Out;
		}

		// Selects the typed JS-primitive-equivalent from a `v` envelope by
		// SettingType, as an FJsonValue, or null when absent / wrong-typed.
		TSharedPtr<FJsonValue> SelectSettingValue(const TSharedPtr<FJsonObject>& Value, int32 Type)
		{
			if (!Value.IsValid())
			{
				return nullptr;
			}
			const TCHAR* Slot = nullptr;
			switch (Type)
			{
				case SettingTypeBool:
					Slot = TEXT("b");
					break;
				case SettingTypeString:
					Slot = TEXT("s");
					break;
				case SettingTypeInt:
					Slot = TEXT("i");
					break;
				case SettingTypeDouble:
					Slot = TEXT("d");
					break;
				default:
					return nullptr;
			}
			return Value->TryGetField(Slot);
		}

		// Reads a setting's `v` envelope object (may be absent).
		TSharedPtr<FJsonObject> GetValueObject(const TSharedPtr<FJsonObject>& Setting)
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			if (Setting.IsValid() && Setting->TryGetObjectField(TEXT("v"), Obj) && Obj)
			{
				return *Obj;
			}
			return nullptr;
		}

		// ── canonical user-attribute stringification (spec 151 / #468 US2) ────
		//
		// Ports `apps/sdk-cpp/src/internal/evaluator.cpp::numberToCanonicalString`
		// + `userAttributeValueToString` (ECMAScript `Number.toString` shape).
		// A string attribute is used verbatim; a non-string TYPED custom
		// attribute is canonicalised here ConfigCat-exactly so the comparators
		// (string-only by contract) see the same text the upstream SDK produces.
		//
		// This is a 1:1 re-port of the already corpus-verified
		// `NumberToCanonicalString` in EvaluatorUpstreamCorpusTest.cpp; it now
		// lives in production so the evaluator (not just the test driver)
		// canonicalises typed attributes.

		// Render a finite double exactly as ECMAScript `Number.toString`: the
		// shortest round-tripping digit sequence, fixed-point unless the
		// magnitude warrants exponential. UE has no shortest-dtoa, so we search
		// increasing "%.*g" precision until the parse round-trips, then reshape
		// into the ECMAScript [digits, point] form. (The corpus carries no
		// NaN/Inf; they are handled for completeness / parity with the TS port.)
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
				return Sign + Raw + FString::ChrN(static_cast<int32>(N - K), TEXT('0'));
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
			return Sign + MantOut + TEXT("e") + ExpSign
				+ FString::Printf(TEXT("%lld"), FMath::Abs(E));
		}

		// Compact `JSON.stringify` of a single string element (quoted, escapes
		// matching JS, no surrounding whitespace). Used to build the string-array
		// canonical form element-by-element.
		//
		// PARITY NOTE (load-bearing): UE's `TJsonWriter` escapes the forward
		// slash as `\/`, but JS `JSON.stringify` (and nlohmann's `dump()` in the
		// sdk-cpp port) leave `/` bare. To stay byte-identical with the rest of
		// the federation — and to match the `s` operand the conversion corpus
		// stores (e.g. `["+<>%\"'\\/\t\r\n"]`, a BARE slash) — we un-escape
		// `\/` → `/` after serialization. (`\\/` for an actual backslash followed
		// by a slash is preserved: we only collapse the writer's slash escape.)
		FString JsonStringifyStringElement(const FString& Element)
		{
			const TSharedPtr<FJsonValue> Val = MakeShared<FJsonValueString>(Element);
			FString Out;
			const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
			FJsonSerializer::Serialize(Val.ToSharedRef(), TEXT(""), Writer);
			Out = Out.TrimStartAndEnd();
			// Collapse UE's `\/` slash-escape to a bare `/` (JS/nlohmann parity).
			// A literal backslash is already emitted as `\\`, so a `\/` here is
			// always the writer's slash escape, never `\` + `/`.
			Out.ReplaceInline(TEXT("\\/"), TEXT("/"), ESearchCase::CaseSensitive);
			return Out;
		}

		// Stringify a typed `FConfeatureUserAttribute`: string verbatim;
		// DateTime → Unix **seconds** (fractional); string array → compact
		// `JSON.stringify`; number → ECMAScript canonical string. Mirrors
		// apps/sdk-cpp `userAttributeValueToString`.
		FString UserAttributeValueToString(const FConfeatureUserAttribute& Attr)
		{
			switch (Attr.Kind)
			{
				case EConfeatureUserAttributeKind::String:
					return Attr.StringValue;
				case EConfeatureUserAttributeKind::Number:
					return NumberToCanonicalString(Attr.NumberValue);
				case EConfeatureUserAttributeKind::DateTime:
					// ConfigCat compares dates as Unix epoch SECONDS (fractional).
					return NumberToCanonicalString(Attr.DateTimeEpochSeconds);
				case EConfeatureUserAttributeKind::StringArray:
				{
					FString Out = TEXT("[");
					bool bFirst = true;
					for (const FString& Element : Attr.StringArrayValue)
					{
						if (!bFirst)
						{
							Out += TEXT(",");
						}
						bFirst = false;
						Out += JsonStringifyStringElement(Element);
					}
					Out += TEXT("]");
					return Out;
				}
				default:
					return FString();
			}
		}

		// Look up a user attribute by name. Returns true + the canonical string
		// value when set, false when absent. Mirrors the C++ getUserAttribute
		// over the public typed User: well-known attrs are always strings; custom
		// attrs route through the TYPED store (`TypedCustom`) and are
		// canonicalised ConfigCat-exactly, falling back to the legacy `Custom`
		// string map for any string-only entry not in the typed store.
		bool GetUserAttribute(const FConfeatureUser& User, const FString& Name, FString& Out)
		{
			if (Name == TEXT("Identifier"))
			{
				Out = User.Identifier;
				return true;
			}
			if (Name == TEXT("Email"))
			{
				if (User.Email.IsEmpty())
				{
					return false;
				}
				Out = User.Email;
				return true;
			}
			if (Name == TEXT("Country"))
			{
				if (User.Country.IsEmpty())
				{
					return false;
				}
				Out = User.Country;
				return true;
			}
			if (const FConfeatureUserAttribute* Typed = User.TypedCustom.Find(Name))
			{
				Out = UserAttributeValueToString(*Typed);
				return true;
			}
			const FString* Found = User.Custom.Find(Name);
			if (Found == nullptr)
			{
				return false;
			}
			Out = *Found;
			return true;
		}

		void SurfaceMissingUser(FEvalContext& Ctx)
		{
			if (Ctx.EvalError.IsEmpty())
			{
				Ctx.EvalError = MissingUserError;
			}
		}

		// Byte-stable equality on two resolved `v` envelopes read through the
		// prereq's declared type. nlohmann compared full json values; here we
		// compare the typed slot pulled by SelectSettingValue.
		bool JsonValueEquals(const TSharedPtr<FJsonValue>& A, const TSharedPtr<FJsonValue>& B)
		{
			if (!A.IsValid() || !B.IsValid())
			{
				return A.IsValid() == B.IsValid();
			}
			if (A->Type != B->Type)
			{
				return false;
			}
			switch (A->Type)
			{
				case EJson::Boolean:
					return A->AsBool() == B->AsBool();
				case EJson::Number:
					return A->AsNumber() == B->AsNumber();
				case EJson::String:
					return A->AsString().Equals(B->AsString(), ESearchCase::CaseSensitive);
				case EJson::Null:
					return true;
				default:
					return false;
			}
		}

		// ── forward declarations ─────────────────────────────────────────────

		FSettingResult EvaluateSetting(
			FEvalContext& Ctx, const FString& Key, const TSharedPtr<FJsonObject>& Setting);

		FOutcome EvaluateConditions(FEvalContext& Ctx,
			const TArray<TSharedPtr<FJsonValue>>* Conditions, const FString& ContextSalt,
			const FString& SettingKey);

		// ── user-condition dispatch (US2) ────────────────────────────────────

		FOutcome EvaluateUserCondition(
			FEvalContext& Ctx, const TSharedPtr<FJsonObject>& Condition, const FString& ContextSalt)
		{
			if (Ctx.User == nullptr)
			{
				SurfaceMissingUser(Ctx);
				return FOutcome::E(MissingUserError);
			}
			const FString AttrName = GetString(Condition, TEXT("a"));
			FString AttrValue;
			const bool bHas = GetUserAttribute(*Ctx.User, AttrName, AttrValue);
			if (!bHas || AttrValue.IsEmpty())
			{
				const FString Msg = MissingAttributeError(AttrName);
				if (Ctx.EvalError.IsEmpty())
				{
					Ctx.EvalError = Msg;
				}
				return FOutcome::E(Msg);
			}

			double CmpValue = 0.0;
			if (!Condition->TryGetNumberField(TEXT("c"), CmpValue))
			{
				return FOutcome::E(TEXT("malformed condition"));
			}
			const int32 Cmp = static_cast<int32>(CmpValue);
			const TArray<FString> List = GetStringList(Condition, TEXT("l"));
			const FString Sv = GetString(Condition, TEXT("s"));
			double Dv = 0.0;
			Condition->TryGetNumberField(TEXT("d"), Dv);
			const FString& Salt = Ctx.ConfigSalt;

			bool bMatched = false;
			switch (Cmp)
			{
				case ComparatorTextEquals:
				case ComparatorTextNotEquals:
					bMatched = TextEquals(AttrValue, Sv, Cmp == ComparatorTextNotEquals);
					break;
				case ComparatorSensitiveTextEquals:
				case ComparatorSensitiveTextNotEquals:
					bMatched = SensitiveTextEquals(
						AttrValue, Sv, Salt, ContextSalt, Cmp == ComparatorSensitiveTextNotEquals);
					break;
				case ComparatorTextIsOneOf:
				case ComparatorTextIsNotOneOf:
					bMatched = TextIsOneOf(AttrValue, List, Cmp == ComparatorTextIsNotOneOf);
					break;
				case ComparatorSensitiveTextIsOneOf:
				case ComparatorSensitiveTextIsNotOneOf:
					bMatched = SensitiveTextIsOneOf(AttrValue, List, Salt, ContextSalt,
						Cmp == ComparatorSensitiveTextIsNotOneOf);
					break;
				case ComparatorTextStartsWithAnyOf:
				case ComparatorTextNotStartsWithAnyOf:
					bMatched = TextSliceEqualsAnyOf(
						AttrValue, List, true, Cmp == ComparatorTextNotStartsWithAnyOf);
					break;
				case ComparatorSensitiveTextStartsWithAnyOf:
				case ComparatorSensitiveTextNotStartsWithAnyOf:
					bMatched = SensitiveTextSliceEqualsAnyOf(AttrValue, List, Salt, ContextSalt, true,
						Cmp == ComparatorSensitiveTextNotStartsWithAnyOf);
					break;
				case ComparatorTextEndsWithAnyOf:
				case ComparatorTextNotEndsWithAnyOf:
					bMatched = TextSliceEqualsAnyOf(
						AttrValue, List, false, Cmp == ComparatorTextNotEndsWithAnyOf);
					break;
				case ComparatorSensitiveTextEndsWithAnyOf:
				case ComparatorSensitiveTextNotEndsWithAnyOf:
					bMatched = SensitiveTextSliceEqualsAnyOf(AttrValue, List, Salt, ContextSalt,
						false, Cmp == ComparatorSensitiveTextNotEndsWithAnyOf);
					break;
				case ComparatorTextContainsAnyOf:
				case ComparatorTextNotContainsAnyOf:
					bMatched =
						TextContainsAnyOf(AttrValue, List, Cmp == ComparatorTextNotContainsAnyOf);
					break;
				case ComparatorSemVerIsOneOf:
				case ComparatorSemVerIsNotOneOf:
				{
					const FSemVer V = FSemVer::Parse(AttrValue);
					if (!V.IsValid())
					{
						return FOutcome::E(InvalidSemVerError(AttrName, AttrValue));
					}
					bMatched =
						SemVerIsOneOf(AttrValue, List, Cmp == ComparatorSemVerIsNotOneOf);
					break;
				}
				case ComparatorSemVerLess:
				case ComparatorSemVerLessOrEquals:
				case ComparatorSemVerGreater:
				case ComparatorSemVerGreaterOrEquals:
				{
					const FSemVer V = FSemVer::Parse(AttrValue);
					if (!V.IsValid())
					{
						return FOutcome::E(InvalidSemVerError(AttrName, AttrValue));
					}
					bMatched = SemVerRelation(AttrValue, Cmp, Sv);
					break;
				}
				case ComparatorNumberEquals:
				case ComparatorNumberNotEquals:
				case ComparatorNumberLess:
				case ComparatorNumberLessOrEquals:
				case ComparatorNumberGreater:
				case ComparatorNumberGreaterOrEquals:
				{
					const FNumberConvert R = AttributeAsNumber(AttrName, AttrValue);
					if (!R.bOk)
					{
						return FOutcome::E(R.Error);
					}
					bMatched = NumberRelation(R.Value, Cmp, Dv);
					break;
				}
				case ComparatorDateTimeBefore:
				case ComparatorDateTimeAfter:
				{
					const FNumberConvert R = AttributeAsUnixTimeSeconds(AttrName, AttrValue);
					if (!R.bOk)
					{
						return FOutcome::E(R.Error);
					}
					bMatched = DateTimeRelation(R.Value, Dv, Cmp == ComparatorDateTimeBefore);
					break;
				}
				case ComparatorArrayContainsAnyOf:
				case ComparatorArrayNotContainsAnyOf:
				{
					const FArrayConvert R = AttributeAsStringArray(AttrName, AttrValue);
					if (!R.bOk)
					{
						return FOutcome::E(R.Error);
					}
					bMatched =
						ArrayContainsAnyOf(R.Value, List, Cmp == ComparatorArrayNotContainsAnyOf);
					break;
				}
				case ComparatorSensitiveArrayContainsAnyOf:
				case ComparatorSensitiveArrayNotContainsAnyOf:
				{
					const FArrayConvert R = AttributeAsStringArray(AttrName, AttrValue);
					if (!R.bOk)
					{
						return FOutcome::E(R.Error);
					}
					bMatched = SensitiveArrayContainsAnyOf(R.Value, List, Salt, ContextSalt,
						Cmp == ComparatorSensitiveArrayNotContainsAnyOf);
					break;
				}
				default:
					return FOutcome::E(
						FString::Printf(TEXT("unknown comparator %d"), Cmp));
			}
			return FOutcome::Of(bMatched);
		}

		// ── segment condition (US4) ──────────────────────────────────────────

		FOutcome EvaluateSegmentCondition(
			FEvalContext& Ctx, const TSharedPtr<FJsonObject>& Condition)
		{
			if (Ctx.User == nullptr)
			{
				SurfaceMissingUser(Ctx);
				return FOutcome::E(MissingUserError);
			}
			double IdxValue = 0.0;
			if (!Condition->TryGetNumberField(TEXT("s"), IdxValue))
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Segment reference is invalid."));
			}
			const int32 Index = static_cast<int32>(IdxValue);
			if (Ctx.Segments == nullptr || Index < 0 || Index >= Ctx.Segments->Num())
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Segment reference is invalid."));
			}
			const TSharedPtr<FJsonValue>& SegVal = (*Ctx.Segments)[Index];
			TSharedPtr<FJsonObject> Segment =
				(SegVal.IsValid() && SegVal->Type == EJson::Object) ? SegVal->AsObject() : nullptr;
			if (!Segment.IsValid())
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Segment reference is invalid."));
			}
			const FString SegmentName = GetString(Segment, TEXT("n"));
			if (SegmentName.IsEmpty())
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Segment name is missing."));
			}

			// The segment's `r[]` is an AND-group of BARE user conditions; the
			// context salt is the segment NAME. Short-circuit on first
			// non-match / error.
			FOutcome InSegment = FOutcome::T();
			const TArray<TSharedPtr<FJsonValue>>* Rules = nullptr;
			if (Segment->TryGetArrayField(TEXT("r"), Rules) && Rules)
			{
				for (const TSharedPtr<FJsonValue>& Uc : *Rules)
				{
					if (!Uc.IsValid() || Uc->Type != EJson::Object)
					{
						continue;
					}
					InSegment = EvaluateUserCondition(Ctx, Uc->AsObject(), SegmentName);
					if (!InSegment.IsTrue())
					{
						break;
					}
				}
			}

			// An error is returned un-negated — IsNotIn never converts an error
			// to a match.
			if (InSegment.Kind == EOutcomeKind::Error)
			{
				return InSegment;
			}
			double SegCmpValue = 0.0;
			Condition->TryGetNumberField(TEXT("c"), SegCmpValue);
			const int32 SegCmp = static_cast<int32>(SegCmpValue);
			const bool bIsIn = InSegment.IsTrue();
			// SegmentComparator: 0 = IsIn, 1 = IsNotIn.
			const bool bResult = (SegCmp == 1) ? !bIsIn : bIsIn;
			return FOutcome::Of(bResult);
		}

		// ── prerequisite condition (US4) ─────────────────────────────────────

		FOutcome EvaluatePrerequisiteCondition(
			FEvalContext& Ctx, const TSharedPtr<FJsonObject>& Condition, const FString& CurrentKey)
		{
			const FString PrereqKey = GetString(Condition, TEXT("f"));
			if (PrereqKey.IsEmpty())
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Prerequisite flag key is missing or invalid."));
			}
			const TSharedPtr<FJsonObject>* PrereqSettingPtr = nullptr;
			if (!(*Ctx.Settings)->TryGetObjectField(PrereqKey, PrereqSettingPtr)
				|| !PrereqSettingPtr || !PrereqSettingPtr->IsValid())
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Prerequisite flag is missing or invalid."));
			}
			const TSharedPtr<FJsonObject> PrereqSetting = *PrereqSettingPtr;
			double TypeValue = 0.0;
			if (!PrereqSetting->TryGetNumberField(TEXT("t"), TypeValue))
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Prerequisite flag is missing or invalid."));
			}
			const int32 DeclaredType = static_cast<int32>(TypeValue);

			// The expected comparison value `v`, read through the prereq flag's
			// type.
			const TSharedPtr<FJsonObject>* CondVObj = nullptr;
			TSharedPtr<FJsonObject> ComparisonEnvelope;
			if (Condition->TryGetObjectField(TEXT("v"), CondVObj) && CondVObj)
			{
				ComparisonEnvelope = *CondVObj;
			}
			const TSharedPtr<FJsonValue> ComparisonValue =
				SelectSettingValue(ComparisonEnvelope, DeclaredType);

			// Cycle detection: push current key, detect a revisit BEFORE
			// recursing.
			Ctx.VisitedFlags.Add(CurrentKey);
			for (const FString& F : Ctx.VisitedFlags)
			{
				if (F == PrereqKey)
				{
					Ctx.bHadFatalError = true;
					return FOutcome::E(TEXT("Circular dependency detected."));
				}
			}

			const FSettingResult Resolved = EvaluateSetting(Ctx, PrereqKey, PrereqSetting);
			// Restore the stack for sibling prerequisites.
			Ctx.VisitedFlags.Pop();

			if (Ctx.bHadFatalError)
			{
				return FOutcome::E(TEXT("Prerequisite evaluation failed."));
			}

			const TSharedPtr<FJsonValue> ResolvedValue =
				SelectSettingValue(Resolved.Value, DeclaredType);

			double PrereqCmpValue = 0.0;
			if (!Condition->TryGetNumberField(TEXT("c"), PrereqCmpValue))
			{
				Ctx.bHadFatalError = true;
				return FOutcome::E(TEXT("Comparison operator is missing or invalid."));
			}
			const int32 PrereqCmp = static_cast<int32>(PrereqCmpValue);
			// PrerequisiteFlagComparator: 0 = Equals, 1 = NotEquals.
			if (PrereqCmp == 0)
			{
				return FOutcome::Of(JsonValueEquals(ResolvedValue, ComparisonValue));
			}
			if (PrereqCmp == 1)
			{
				return FOutcome::Of(!JsonValueEquals(ResolvedValue, ComparisonValue));
			}
			Ctx.bHadFatalError = true;
			return FOutcome::E(TEXT("Comparison operator is missing or invalid."));
		}

		// ── condition group (AND) ────────────────────────────────────────────

		FOutcome EvaluateConditions(FEvalContext& Ctx,
			const TArray<TSharedPtr<FJsonValue>>* Conditions, const FString& ContextSalt,
			const FString& SettingKey)
		{
			FOutcome Result = FOutcome::T();
			if (Conditions == nullptr)
			{
				return Result;
			}
			for (const TSharedPtr<FJsonValue>& CondVal : *Conditions)
			{
				if (!CondVal.IsValid() || CondVal->Type != EJson::Object)
				{
					Result = FOutcome::E(TEXT("empty condition"));
					break;
				}
				const TSharedPtr<FJsonObject> Condition = CondVal->AsObject();
				const TSharedPtr<FJsonObject>* U = nullptr;
				const TSharedPtr<FJsonObject>* P = nullptr;
				const TSharedPtr<FJsonObject>* S = nullptr;
				if (Condition->TryGetObjectField(TEXT("u"), U) && U)
				{
					Result = EvaluateUserCondition(Ctx, *U, ContextSalt);
				}
				else if (Condition->TryGetObjectField(TEXT("p"), P) && P)
				{
					Result = EvaluatePrerequisiteCondition(Ctx, *P, SettingKey);
				}
				else if (Condition->TryGetObjectField(TEXT("s"), S) && S)
				{
					Result = EvaluateSegmentCondition(Ctx, *S);
				}
				else
				{
					Result = FOutcome::E(TEXT("empty condition"));
				}
				if (Ctx.bHadFatalError || !Result.IsTrue())
				{
					break;
				}
			}
			return Result;
		}

		// ── percentage options (US3) ─────────────────────────────────────────

		// Returns true + fills `Out` when an option decides the value; false to
		// skip (no user / missing keying attribute / malformed <100% sum). The
		// C++ port threw on a <100% sum; here we set the fatal sentinel.
		bool EvaluatePercentageOptions(FEvalContext& Ctx,
			const TArray<TSharedPtr<FJsonValue>>* Options, const FString& SettingKey,
			const TSharedPtr<FJsonObject>& SettingObj, bool bMatchedRule, FSettingResult* Out)
		{
			if (Ctx.User == nullptr)
			{
				SurfaceMissingUser(Ctx);
				return false;
			}
			FString AttrName = GetString(SettingObj, TEXT("a"));
			FString AttrValue;
			if (AttrName.IsEmpty())
			{
				AttrName = TEXT("Identifier");
				AttrValue = Ctx.User->Identifier;
			}
			else if (!GetUserAttribute(*Ctx.User, AttrName, AttrValue))
			{
				if (Ctx.EvalError.IsEmpty())
				{
					Ctx.EvalError = MissingAttributeError(AttrName);
				}
				return false;
			}

			const int32 HashValue = PercentageBucket(SettingKey, AttrValue);
			int32 Bucket = 0;
			if (Options != nullptr)
			{
				for (const TSharedPtr<FJsonValue>& OptVal : *Options)
				{
					if (!OptVal.IsValid() || OptVal->Type != EJson::Object)
					{
						continue;
					}
					const TSharedPtr<FJsonObject> Option = OptVal->AsObject();
					double Width = 0.0;
					Option->TryGetNumberField(TEXT("p"), Width);
					Bucket += static_cast<int32>(Width);
					if (HashValue < Bucket)
					{
						Out->Value = GetValueObject(Option);
						Out->VariationId = GetString(Option, TEXT("i"));
						Out->bMatchedRule = bMatchedRule;
						Out->bMatchedOption = true;
						return true;
					}
				}
			}
			// Sum of percentage option percentages is less than 100 — malformed.
			Ctx.bHadFatalError = true;
			return false;
		}

		// ── targeting-rule walk (US1) ────────────────────────────────────────

		bool EvaluateTargetingRules(FEvalContext& Ctx,
			const TArray<TSharedPtr<FJsonValue>>* Rules, const FString& SettingKey,
			const TSharedPtr<FJsonObject>& SettingObj, FSettingResult* Out)
		{
			if (Rules == nullptr)
			{
				return false;
			}
			for (const TSharedPtr<FJsonValue>& RuleVal : *Rules)
			{
				if (!RuleVal.IsValid() || RuleVal->Type != EJson::Object)
				{
					continue;
				}
				const TSharedPtr<FJsonObject> Rule = RuleVal->AsObject();
				const TArray<TSharedPtr<FJsonValue>>* Conditions = nullptr;
				Rule->TryGetArrayField(TEXT("c"), Conditions);
				const FOutcome Outcome =
					EvaluateConditions(Ctx, Conditions, SettingKey, SettingKey);
				if (Ctx.bHadFatalError)
				{
					return false;
				}
				if (!Outcome.IsTrue())
				{
					continue;
				}
				// A rule serves a fixed value (`s`) or percentage options (`p`).
				const TSharedPtr<FJsonObject>* Served = nullptr;
				if (Rule->TryGetObjectField(TEXT("s"), Served) && Served && Served->IsValid())
				{
					Out->Value = GetValueObject(*Served);
					Out->VariationId = GetString(*Served, TEXT("i"));
					Out->bMatchedRule = true;
					Out->bMatchedOption = false;
					return true;
				}
				const TArray<TSharedPtr<FJsonValue>>* Options = nullptr;
				if (Rule->TryGetArrayField(TEXT("p"), Options) && Options)
				{
					if (EvaluatePercentageOptions(
							Ctx, Options, SettingKey, SettingObj, true, Out))
					{
						return true;
					}
					if (Ctx.bHadFatalError)
					{
						return false;
					}
				}
				// % options weren't resolvable (no user / missing attr) →
				// continue to the next rule.
			}
			return false;
		}

		// ── setting resolution ───────────────────────────────────────────────

		FSettingResult EvaluateSetting(
			FEvalContext& Ctx, const FString& Key, const TSharedPtr<FJsonObject>& Setting)
		{
			FSettingResult Result;

			// 1. Targeting rules — first-match-wins (US1).
			const TArray<TSharedPtr<FJsonValue>>* Rules = nullptr;
			if (Setting->TryGetArrayField(TEXT("r"), Rules) && Rules && Rules->Num() > 0)
			{
				if (EvaluateTargetingRules(Ctx, Rules, Key, Setting, &Result))
				{
					return Result;
				}
				if (Ctx.bHadFatalError)
				{
					return Result;
				}
			}

			// 2. Setting-level percentage options (US3).
			const TArray<TSharedPtr<FJsonValue>>* Options = nullptr;
			if (Setting->TryGetArrayField(TEXT("p"), Options) && Options && Options->Num() > 0)
			{
				if (EvaluatePercentageOptions(Ctx, Options, Key, Setting, false, &Result))
				{
					return Result;
				}
				if (Ctx.bHadFatalError)
				{
					return Result;
				}
			}

			// 3. Served fallback `setting.v`.
			Result.Value = GetValueObject(Setting);
			Result.VariationId = GetString(Setting, TEXT("i"));
			Result.bMatchedRule = false;
			Result.bMatchedOption = false;
			return Result;
		}

		// ── typed resolution of the final envelope ───────────────────────────

		FEvalResult Fail(const FConfeatureDefaultValue& Default, FString Code)
		{
			FEvalResult Out;
			Out.ResolvedType = Default.Kind;
			Out.BoolValue = Default.BoolValue;
			Out.StringValue = Default.StringValue;
			Out.IntValue = Default.IntValue;
			Out.DoubleValue = Default.DoubleValue;
			Out.Error = MoveTemp(Code);
			return Out;
		}
	}

	FConfeatureDefaultValue FConfeatureDefaultValue::Bool(bool V)
	{
		FConfeatureDefaultValue Out;
		Out.Kind = SettingTypeBool;
		Out.BoolValue = V;
		return Out;
	}

	FConfeatureDefaultValue FConfeatureDefaultValue::String(const FString& V)
	{
		FConfeatureDefaultValue Out;
		Out.Kind = SettingTypeString;
		Out.StringValue = V;
		return Out;
	}

	FConfeatureDefaultValue FConfeatureDefaultValue::Int(int32 V)
	{
		FConfeatureDefaultValue Out;
		Out.Kind = SettingTypeInt;
		Out.IntValue = V;
		return Out;
	}

	FConfeatureDefaultValue FConfeatureDefaultValue::Double(double V)
	{
		FConfeatureDefaultValue Out;
		Out.Kind = SettingTypeDouble;
		Out.DoubleValue = V;
		return Out;
	}

	FConfeatureDefaultValue FConfeatureDefaultValue::Null()
	{
		FConfeatureDefaultValue Out;
		Out.Kind = SettingTypeNull;
		return Out;
	}

	FEvalResult Evaluate(const TSharedPtr<FJsonObject>& Config, const FString& Key,
		const FConfeatureDefaultValue& Default, const FConfeatureUser* User)
	{
		if (!Config.IsValid())
		{
			return Fail(Default, TEXT("NO_CONFIG"));
		}

		const TSharedPtr<FJsonObject>* FlagsObj = nullptr;
		if (!Config->TryGetObjectField(TEXT("f"), FlagsObj) || !FlagsObj || !FlagsObj->IsValid())
		{
			return Fail(Default, TEXT("MALFORMED_CONFIG"));
		}

		const TSharedPtr<FJsonObject>* SettingObj = nullptr;
		if (!(*FlagsObj)->TryGetObjectField(Key, SettingObj))
		{
			return Fail(Default, TEXT("KEY_NOT_FOUND"));
		}
		if (!SettingObj || !SettingObj->IsValid())
		{
			return Fail(Default, TEXT("MALFORMED_CONFIG"));
		}
		const TSharedPtr<FJsonObject> Setting = *SettingObj;

		double TypeValue = 0.0;
		if (!Setting->TryGetNumberField(TEXT("t"), TypeValue))
		{
			return Fail(Default, TEXT("MALFORMED_CONFIG"));
		}
		const int32 SettingType = static_cast<int32>(TypeValue);

		// Default-type guard, mirroring the pre-existing tier-0 contract
		// (SC-006). The typed-default `Kind` selects the expected slot. A NULL
		// default OPTS OUT of the type check (matching the C++ port's
		// `defaultValue.is_null()` branch + the TS evaluator's `defaultValue
		// !== null` guard): this is how the variationId matrix resolves the
		// served value + variationId regardless of the flag's declared type
		// (FR-011). The four typed slots are still validated below, after
		// resolution.
		if (Default.Kind != SettingTypeNull)
		{
			switch (SettingType)
			{
				case SettingTypeBool:
					if (Default.Kind != SettingTypeBool)
					{
						return Fail(Default, TEXT("TYPE_MISMATCH"));
					}
					break;
				case SettingTypeString:
					if (Default.Kind != SettingTypeString)
					{
						return Fail(Default, TEXT("TYPE_MISMATCH"));
					}
					break;
				case SettingTypeInt:
					if (Default.Kind != SettingTypeInt)
					{
						return Fail(Default, TEXT("TYPE_MISMATCH"));
					}
					break;
				case SettingTypeDouble:
					if (Default.Kind != SettingTypeDouble)
					{
						return Fail(Default, TEXT("TYPE_MISMATCH"));
					}
					break;
				default:
					return Fail(Default, TEXT("UNSUPPORTED_TYPE"));
			}
		}
		else if (SettingType != SettingTypeBool && SettingType != SettingTypeString
			&& SettingType != SettingTypeInt && SettingType != SettingTypeDouble)
		{
			return Fail(Default, TEXT("UNSUPPORTED_TYPE"));
		}

		// Evaluation core. A detected prerequisite cycle / malformed shape sets
		// the fatal sentinel → fail-closed default + EVAL_ERROR (FR-012,
		// SC-004).
		FEvalContext Ctx;
		Ctx.Settings = FlagsObj;
		Ctx.User = User;
		const TArray<TSharedPtr<FJsonValue>>* SegArr = nullptr;
		if (Config->TryGetArrayField(TEXT("s"), SegArr) && SegArr)
		{
			Ctx.Segments = SegArr;
		}
		const TSharedPtr<FJsonObject>* PObj = nullptr;
		if (Config->TryGetObjectField(TEXT("p"), PObj) && PObj && PObj->IsValid())
		{
			(*PObj)->TryGetStringField(TEXT("s"), Ctx.ConfigSalt);
		}

		const FSettingResult Resolved = EvaluateSetting(Ctx, Key, Setting);
		if (Ctx.bHadFatalError)
		{
			return Fail(Default, TEXT("EVAL_ERROR"));
		}

		// Select the typed value by `t`; an absent / wrong-typed slot is a
		// malformed value (preserving the differentiated boolean code).
		const TSharedPtr<FJsonValue> Value = SelectSettingValue(Resolved.Value, SettingType);

		FEvalResult Out;
		Out.VariationId = Resolved.VariationId;
		Out.bHasMatchedRule = Resolved.bMatchedRule;
		Out.bHasMatchedOption = Resolved.bMatchedOption;
		Out.EvalError = Ctx.EvalError;

		switch (SettingType)
		{
			case SettingTypeBool:
			{
				if (!Value.IsValid() || Value->Type != EJson::Boolean)
				{
					return Fail(Default, TEXT("VALUE_NOT_BOOL"));
				}
				Out.ResolvedType = SettingTypeBool;
				Out.BoolValue = Value->AsBool();
				return Out;
			}
			case SettingTypeString:
			{
				if (!Value.IsValid() || Value->Type != EJson::String)
				{
					return Fail(Default, TEXT("MALFORMED_VALUE"));
				}
				Out.ResolvedType = SettingTypeString;
				Out.StringValue = Value->AsString();
				return Out;
			}
			case SettingTypeInt:
			{
				if (!Value.IsValid() || Value->Type != EJson::Number)
				{
					return Fail(Default, TEXT("MALFORMED_VALUE"));
				}
				const double Num = Value->AsNumber();
				if (FMath::Frac(Num) != 0.0)
				{
					return Fail(Default, TEXT("MALFORMED_VALUE"));
				}
				Out.ResolvedType = SettingTypeInt;
				Out.IntValue = static_cast<int32>(Num);
				return Out;
			}
			case SettingTypeDouble:
			{
				if (!Value.IsValid() || Value->Type != EJson::Number)
				{
					return Fail(Default, TEXT("MALFORMED_VALUE"));
				}
				Out.ResolvedType = SettingTypeDouble;
				Out.DoubleValue = Value->AsNumber();
				return Out;
			}
			default:
				return Fail(Default, TEXT("UNSUPPORTED_TYPE"));
		}
	}
}
