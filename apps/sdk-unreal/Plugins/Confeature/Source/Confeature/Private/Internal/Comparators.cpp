// SPDX-License-Identifier: MIT

#include "Internal/Comparators.h"

#include "Dom/JsonValue.h"
#include "Internal/Hashing.h"
#include "Internal/Semver.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace Confeature::Internal
{
	namespace
	{
		FString Trim(const FString& S) { return S.TrimStartAndEnd(); }

		FString InvalidAttr(const FString& Attr, const FString& Reason)
		{
			return FString::Printf(
				TEXT("cannot evaluate, the User.%s attribute is invalid (%s)"), *Attr, *Reason);
		}

		// A "_"-prefixed length token in a sensitive slice operand, e.g.
		// "12_<hash>" → 12. Returns false on a non-integer prefix.
		bool ParseSliceLength(const FString& S, int32& Out)
		{
			if (S.IsEmpty())
			{
				return false;
			}
			int32 Value = 0;
			for (const TCHAR C : S)
			{
				if (C < TEXT('0') || C > TEXT('9'))
				{
					return false;
				}
				Value = Value * 10 + static_cast<int32>(C - TEXT('0'));
			}
			Out = Value;
			return true;
		}
	}

	// ── Text (cleartext) — FString ops operate on UTF-16 code units, matching
	// the canonical TS string semantics (the algorithm source of truth). ─────

	bool TextEquals(const FString& Text, const FString& ComparisonValue, bool bNegate)
	{
		return Text.Equals(ComparisonValue, ESearchCase::CaseSensitive) != bNegate;
	}

	bool TextIsOneOf(const FString& Text, const TArray<FString>& Values, bool bNegate)
	{
		bool bFound = false;
		for (const FString& V : Values)
		{
			if (V.Equals(Text, ESearchCase::CaseSensitive))
			{
				bFound = true;
				break;
			}
		}
		return bFound != bNegate;
	}

	bool TextContainsAnyOf(const FString& Text, const TArray<FString>& Values, bool bNegate)
	{
		for (const FString& V : Values)
		{
			if (Text.Contains(V, ESearchCase::CaseSensitive))
			{
				return !bNegate;
			}
		}
		return bNegate;
	}

	bool TextSliceEqualsAnyOf(
		const FString& Text, const TArray<FString>& Values, bool bStartsWith, bool bNegate)
	{
		for (const FString& Item : Values)
		{
			if (Text.Len() < Item.Len())
			{
				continue;
			}
			bool bResult = false;
			if (bStartsWith)
			{
				bResult = Text.StartsWith(Item, ESearchCase::CaseSensitive);
			}
			else
			{
				bResult = Text.EndsWith(Item, ESearchCase::CaseSensitive);
			}
			if (bResult)
			{
				return !bNegate;
			}
		}
		return bNegate;
	}

	// ── Sensitive text ─────────────────────────────────────────────────────

	bool SensitiveTextEquals(const FString& Text, const FString& ComparisonValue,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate)
	{
		const FString Hash = HashComparisonValue(Text, ConfigSalt, ContextSalt);
		return Hash.Equals(ComparisonValue, ESearchCase::CaseSensitive) != bNegate;
	}

	bool SensitiveTextIsOneOf(const FString& Text, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate)
	{
		const FString Hash = HashComparisonValue(Text, ConfigSalt, ContextSalt);
		bool bFound = false;
		for (const FString& V : Values)
		{
			if (V.Equals(Hash, ESearchCase::CaseSensitive))
			{
				bFound = true;
				break;
			}
		}
		return bFound != bNegate;
	}

	bool SensitiveTextSliceEqualsAnyOf(const FString& Text, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bStartsWith, bool bNegate)
	{
		// Slicing is over the UTF-8 BYTE sequence (matching common-js +
		// hash.ts): a slice may land mid-codepoint.
		const FTCHARToUTF8 Utf8(Text.GetCharArray().GetData(), Text.Len());
		const uint8* TextBytes = reinterpret_cast<const uint8*>(Utf8.Get());
		const int32 TextLen = Utf8.Length();

		for (const FString& Item : Values)
		{
			int32 Underscore = INDEX_NONE;
			if (!Item.FindChar(TEXT('_'), Underscore))
			{
				continue;
			}
			int32 SliceLength = 0;
			if (!ParseSliceLength(Item.Left(Underscore), SliceLength))
			{
				continue;
			}
			if (TextLen < SliceLength)
			{
				continue;
			}
			const uint8* SlicePtr = bStartsWith ? TextBytes : (TextBytes + (TextLen - SliceLength));
			const FString Hash =
				HashComparisonValueSlice(SlicePtr, SliceLength, ConfigSalt, ContextSalt);
			if (Hash.Equals(Item.Mid(Underscore + 1), ESearchCase::CaseSensitive))
			{
				return !bNegate;
			}
		}
		return bNegate;
	}

	// ── Semver ───────────────────────────────────────────────────────────────

	bool SemVerIsOneOf(const FString& Version, const TArray<FString>& Values, bool bNegate)
	{
		const FSemVer V1 = FSemVer::Parse(Version);
		// The caller (AttributeAsSemVer) already validated `Version`; this is
		// reached only with a parseable user version.
		if (!V1.IsValid())
		{
			return bNegate;
		}
		bool bResult = false;
		for (const FString& RawItem : Values)
		{
			// Trim FIRST, then skip empty — matching ConfigCat, which trims
			// before the empty check, so a whitespace-only operand is skipped
			// (not an error). A non-empty but unparseable operand still errors
			// the whole comparator.
			const FString Item = Trim(RawItem);
			if (Item.IsEmpty())
			{
				continue;
			}
			const FSemVer V2 = FSemVer::Parse(Item);
			if (!V2.IsValid())
			{
				return false;
			}
			if (!bResult && V1.Compare(V2) == 0)
			{
				bResult = true;
			}
		}
		return bResult != bNegate;
	}

	bool SemVerRelation(const FString& Version, int32 Comparator, const FString& ComparisonValue)
	{
		const FSemVer V1 = FSemVer::Parse(Version);
		if (!V1.IsValid())
		{
			return false;
		}
		const FSemVer V2 = FSemVer::Parse(Trim(ComparisonValue));
		if (!V2.IsValid())
		{
			return false;
		}
		const int32 Cmp = V1.Compare(V2);
		switch (Comparator)
		{
			case ComparatorSemVerLess:
				return Cmp < 0;
			case ComparatorSemVerLessOrEquals:
				return Cmp <= 0;
			case ComparatorSemVerGreater:
				return Cmp > 0;
			case ComparatorSemVerGreaterOrEquals:
				return Cmp >= 0;
			default:
				return false;
		}
	}

	// ── Number ─────────────────────────────────────────────────────────────

	bool NumberRelation(double Num, int32 Comparator, double ComparisonValue)
	{
		// NaN compares false on every relation (matches IEEE-754 + JS).
		switch (Comparator)
		{
			case ComparatorNumberEquals:
				return Num == ComparisonValue;
			case ComparatorNumberNotEquals:
				return Num != ComparisonValue;
			case ComparatorNumberLess:
				return Num < ComparisonValue;
			case ComparatorNumberLessOrEquals:
				return Num <= ComparisonValue;
			case ComparatorNumberGreater:
				return Num > ComparisonValue;
			case ComparatorNumberGreaterOrEquals:
				return Num >= ComparisonValue;
			default:
				return false;
		}
	}

	// ── Datetime ───────────────────────────────────────────────────────────

	bool DateTimeRelation(double Seconds, double ComparisonValue, bool bBefore)
	{
		return bBefore ? Seconds < ComparisonValue : Seconds > ComparisonValue;
	}

	// ── Array ──────────────────────────────────────────────────────────────

	bool ArrayContainsAnyOf(
		const TArray<FString>& Array, const TArray<FString>& Values, bool bNegate)
	{
		for (const FString& A : Array)
		{
			for (const FString& V : Values)
			{
				if (A.Equals(V, ESearchCase::CaseSensitive))
				{
					return !bNegate;
				}
			}
		}
		return bNegate;
	}

	bool SensitiveArrayContainsAnyOf(const TArray<FString>& Array, const TArray<FString>& Values,
		const FString& ConfigSalt, const FString& ContextSalt, bool bNegate)
	{
		for (const FString& A : Array)
		{
			const FString Hash = HashComparisonValue(A, ConfigSalt, ContextSalt);
			for (const FString& V : Values)
			{
				if (V.Equals(Hash, ESearchCase::CaseSensitive))
				{
					return !bNegate;
				}
			}
		}
		return bNegate;
	}

	// ── Attribute conversion ─────────────────────────────────────────────────

	bool ParseFloatStrict(const FString& Value, double& Out)
	{
		// common-js parseFloatStrict: reject empty / all-whitespace and a
		// leading (post-whitespace) `0` followed by a non-digit/non-`.`/non-`e`
		// (octal / hex); else a strict whole-string number parse (JS `+value`).
		if (Value.IsEmpty())
		{
			return false;
		}

		// Reject all-whitespace, and the `^\s*0[^\d.eE]` octal/hex pattern.
		{
			int32 i = 0;
			const int32 Len = Value.Len();
			while (i < Len && FChar::IsWhitespace(Value[i]))
			{
				++i;
			}
			if (i >= Len)
			{
				return false;  // all whitespace
			}
			if (Value[i] == TEXT('0') && (i + 1) < Len)
			{
				const TCHAR Next = Value[i + 1];
				const bool bAllowed = (Next >= TEXT('0') && Next <= TEXT('9')) || Next == TEXT('.')
					|| Next == TEXT('e') || Next == TEXT('E');
				if (!bAllowed)
				{
					return false;
				}
			}
		}

		// Whole-string numeric grammar (JS `+value`): optional surrounding
		// whitespace, optional sign, decimal + exponent, no trailing garbage.
		//   ^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$
		{
			const int32 Len = Value.Len();
			int32 i = 0;
			while (i < Len && FChar::IsWhitespace(Value[i]))
			{
				++i;
			}
			if (i < Len && (Value[i] == TEXT('+') || Value[i] == TEXT('-')))
			{
				++i;
			}
			int32 IntDigits = 0;
			while (i < Len && Value[i] >= TEXT('0') && Value[i] <= TEXT('9'))
			{
				++i;
				++IntDigits;
			}
			int32 FracDigits = 0;
			if (i < Len && Value[i] == TEXT('.'))
			{
				++i;
				while (i < Len && Value[i] >= TEXT('0') && Value[i] <= TEXT('9'))
				{
					++i;
					++FracDigits;
				}
			}
			// Mantissa: either `\d+\.?\d*` (>=1 int digit) or `\.\d+` (>=1 frac
			// digit with no int digits).
			if (IntDigits == 0 && FracDigits == 0)
			{
				return false;
			}
			// Exponent.
			if (i < Len && (Value[i] == TEXT('e') || Value[i] == TEXT('E')))
			{
				++i;
				if (i < Len && (Value[i] == TEXT('+') || Value[i] == TEXT('-')))
				{
					++i;
				}
				int32 ExpDigits = 0;
				while (i < Len && Value[i] >= TEXT('0') && Value[i] <= TEXT('9'))
				{
					++i;
					++ExpDigits;
				}
				if (ExpDigits == 0)
				{
					return false;
				}
			}
			while (i < Len && FChar::IsWhitespace(Value[i]))
			{
				++i;
			}
			if (i != Len)
			{
				return false;  // trailing garbage
			}
		}

		Out = FCString::Atod(*Value);
		return true;
	}

	FNumberConvert AttributeAsNumber(const FString& Attr, const FString& Value)
	{
		// common-js replaces only the FIRST comma with a dot.
		FString Normalized = Value;
		int32 Comma = INDEX_NONE;
		if (Normalized.FindChar(TEXT(','), Comma))
		{
			Normalized[Comma] = TEXT('.');
		}
		double Num = 0.0;
		if (ParseFloatStrict(Normalized, Num))
		{
			return FNumberConvert{ true, Num, FString() };
		}
		if (Trim(Value) == TEXT("NaN"))
		{
			return FNumberConvert{ true, FMath::Sqrt(-1.0), FString() };  // quiet NaN
		}
		return FNumberConvert{ false, 0.0,
			InvalidAttr(Attr, FString::Printf(TEXT("'%s' is not a valid decimal number"), *Value)) };
	}

	FNumberConvert AttributeAsUnixTimeSeconds(const FString& Attr, const FString& Value)
	{
		FString Normalized = Value;
		int32 Comma = INDEX_NONE;
		if (Normalized.FindChar(TEXT(','), Comma))
		{
			Normalized[Comma] = TEXT('.');
		}
		double Num = 0.0;
		if (ParseFloatStrict(Normalized, Num))
		{
			return FNumberConvert{ true, Num, FString() };
		}
		if (Trim(Value) == TEXT("NaN"))
		{
			return FNumberConvert{ true, FMath::Sqrt(-1.0), FString() };
		}
		return FNumberConvert{ false, 0.0,
			InvalidAttr(Attr,
				FString::Printf(TEXT("'%s' is not a valid Unix timestamp (number of seconds "
									 "elapsed since Unix epoch)"),
					*Value)) };
	}

	FArrayConvert AttributeAsStringArray(const FString& Attr, const FString& Value)
	{
		// A string attribute is JSON-parsed; the result must be a string array
		// (common-js getUserAttributeValueAsStringArray).
		FArrayConvert Out;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Value);
		TArray<TSharedPtr<FJsonValue>> Parsed;
		if (FJsonSerializer::Deserialize(Reader, Parsed))
		{
			bool bAllStrings = true;
			TArray<FString> Arr;
			for (const TSharedPtr<FJsonValue>& E : Parsed)
			{
				if (!E.IsValid() || E->Type != EJson::String)
				{
					bAllStrings = false;
					break;
				}
				Arr.Add(E->AsString());
			}
			if (bAllStrings)
			{
				Out.bOk = true;
				Out.Value = MoveTemp(Arr);
				return Out;
			}
		}
		// Non-JSON-array string falls through to the validation error.
		Out.bOk = false;
		Out.Error =
			InvalidAttr(Attr, FString::Printf(TEXT("'%s' is not a valid string array"), *Value));
		return Out;
	}
}
