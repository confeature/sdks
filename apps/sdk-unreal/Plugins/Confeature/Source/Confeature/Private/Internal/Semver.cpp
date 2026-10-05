// SPDX-License-Identifier: MIT

#include "Internal/Semver.h"

namespace Confeature::Internal
{
	namespace
	{
		constexpr int32 MaxLength = 256;
		// JS Number.MAX_SAFE_INTEGER — the upstream ceiling for core + numeric
		// ids.
		constexpr uint64 MaxSafeInteger = 9007199254740991ULL;

		bool IsDigit(TCHAR C) { return C >= TEXT('0') && C <= TEXT('9'); }

		bool IsAlpha(TCHAR C)
		{
			return (C >= TEXT('a') && C <= TEXT('z')) || (C >= TEXT('A') && C <= TEXT('Z'));
		}

		// Matches the build/pre-release id char class `[0-9A-Za-z-]`.
		bool IsIdentifierChar(TCHAR C) { return IsDigit(C) || IsAlpha(C) || C == TEXT('-'); }

		FString Trim(const FString& S)
		{
			// FString::TrimStartAndEnd trims Unicode whitespace, matching the
			// C++ port's std::isspace-based trim closely enough for the corpus
			// (the *_trimming rows use ASCII spaces).
			return S.TrimStartAndEnd();
		}

		bool IsAllDigits(const FString& S)
		{
			if (S.IsEmpty())
			{
				return false;
			}
			for (const TCHAR C : S)
			{
				if (!IsDigit(C))
				{
					return false;
				}
			}
			return true;
		}

		// A core component matches `0|[1-9]\d*`: either "0" exactly, or a
		// non-zero leading digit followed by digits (no leading zeros).
		bool IsValidCore(const FString& S)
		{
			if (S.IsEmpty())
			{
				return false;
			}
			if (S == TEXT("0"))
			{
				return true;
			}
			if (S[0] == TEXT('0'))
			{
				return false;
			}
			for (const TCHAR C : S)
			{
				if (!IsDigit(C))
				{
					return false;
				}
			}
			return true;
		}

		// A pre-release identifier matches `0|[1-9]\d*` (numeric, no leading
		// zeros) OR `\d*[a-zA-Z-][a-zA-Z0-9-]*` (alphanumeric — must contain at
		// least one letter or hyphen and only [0-9A-Za-z-]).
		bool IsValidPreId(const FString& S)
		{
			if (S.IsEmpty())
			{
				return false;
			}
			if (IsAllDigits(S))
			{
				// Numeric branch: no leading zeros unless the whole thing is
				// "0".
				return S == TEXT("0") || S[0] != TEXT('0');
			}
			// Alphanumeric branch: every char in [0-9A-Za-z-] and at least one
			// non-digit.
			bool bHasNonDigit = false;
			for (const TCHAR C : S)
			{
				if (!IsIdentifierChar(C))
				{
					return false;
				}
				if (!IsDigit(C))
				{
					bHasNonDigit = true;
				}
			}
			return bHasNonDigit;
		}

		bool IsValidBuildId(const FString& S)
		{
			if (S.IsEmpty())
			{
				return false;
			}
			for (const TCHAR C : S)
			{
				if (!IsIdentifierChar(C))
				{
					return false;
				}
			}
			return true;
		}

		// Parse a `0|[1-9]\d*` core to uint64, rejecting > MAX_SAFE_INTEGER.
		bool ParseCore(const FString& S, uint64& Out)
		{
			// The grammar already guarantees an all-digit (no-leading-zero)
			// string; guard overflow.
			uint64 Value = 0;
			for (const TCHAR C : S)
			{
				const uint64 Digit = static_cast<uint64>(C - TEXT('0'));
				// Overflow / safe-integer guard: bail before Value can exceed
				// MAX_SAFE_INTEGER.
				if (Value > (MaxSafeInteger - Digit) / 10)
				{
					return false;
				}
				Value = Value * 10 + Digit;
			}
			if (Value > MaxSafeInteger)
			{
				return false;
			}
			Out = Value;
			return true;
		}

		// compareIdentifiers (semver.ts): both numeric → numeric compare; a
		// numeric id is lower-precedence than an alphanumeric one; otherwise
		// ASCII-lexical.
		int32 CompareIdentifiers(bool ANumeric, uint64 ANum, const FString& AStr, bool BNumeric,
			uint64 BNum, const FString& BStr)
		{
			if (ANumeric && BNumeric)
			{
				if (ANum == BNum)
				{
					return 0;
				}
				return ANum < BNum ? -1 : 1;
			}
			if (ANumeric && !BNumeric)
			{
				return -1;
			}
			if (BNumeric && !ANumeric)
			{
				return 1;
			}
			if (AStr == BStr)
			{
				return 0;
			}
			// ASCII-lexical (FString::operator< is code-unit ordered).
			return AStr < BStr ? -1 : 1;
		}
	}

	FSemVer FSemVer::Parse(const FString& Version)
	{
		FSemVer Out;
		const FString Trimmed = Trim(Version);
		if (Trimmed.Len() > MaxLength || Trimmed.IsEmpty())
		{
			return Out;  // invalid
		}

		// Optional leading `v`.
		int32 Pos = 0;
		if (Trimmed[0] == TEXT('v'))
		{
			Pos = 1;
		}

		const FString Core = Trimmed.Mid(Pos);

		// Split off the build metadata (`+...`) first — it is ignored for
		// precedence but must be grammatically valid.
		FString MainAndPre = Core;
		int32 PlusIdx = INDEX_NONE;
		if (Core.FindChar(TEXT('+'), PlusIdx))
		{
			MainAndPre = Core.Left(PlusIdx);
			const FString Build = Core.Mid(PlusIdx + 1);
			// Build is `buildId(.buildId)*`.
			TArray<FString> BuildIds;
			Build.ParseIntoArray(BuildIds, TEXT("."), /*InCullEmpty=*/false);
			if (BuildIds.Num() == 0)
			{
				return Out;  // invalid (trailing '+')
			}
			for (const FString& Id : BuildIds)
			{
				if (!IsValidBuildId(Id))
				{
					return Out;
				}
			}
		}

		// Split off the pre-release (`-...`) from the main version.
		FString MainVer = MainAndPre;
		FString PreRaw;
		bool bHasPre = false;
		int32 DashIdx = INDEX_NONE;
		if (MainAndPre.FindChar(TEXT('-'), DashIdx))
		{
			MainVer = MainAndPre.Left(DashIdx);
			PreRaw = MainAndPre.Mid(DashIdx + 1);
			bHasPre = true;
		}

		// Main version is exactly MAJOR.MINOR.PATCH.
		TArray<FString> Parts;
		MainVer.ParseIntoArray(Parts, TEXT("."), /*InCullEmpty=*/false);
		if (Parts.Num() != 3)
		{
			return Out;
		}
		if (!IsValidCore(Parts[0]) || !IsValidCore(Parts[1]) || !IsValidCore(Parts[2]))
		{
			return Out;
		}

		uint64 Major = 0;
		uint64 Minor = 0;
		uint64 Patch = 0;
		if (!ParseCore(Parts[0], Major) || !ParseCore(Parts[1], Minor) || !ParseCore(Parts[2], Patch))
		{
			return Out;
		}

		Out.Major = Major;
		Out.Minor = Minor;
		Out.Patch = Patch;

		if (bHasPre)
		{
			TArray<FString> PreIds;
			PreRaw.ParseIntoArray(PreIds, TEXT("."), /*InCullEmpty=*/false);
			if (PreIds.Num() == 0)
			{
				return Out;  // invalid (trailing '-')
			}
			for (const FString& Id : PreIds)
			{
				if (!IsValidPreId(Id))
				{
					return Out;
				}
				FIdentifier Ident;
				if (IsAllDigits(Id))
				{
					// Numberify numeric pre-release ids (matching common-js),
					// but only when in safe-integer range; otherwise keep as
					// string.
					uint64 Num = 0;
					bool bOk = true;
					for (const TCHAR C : Id)
					{
						const uint64 Digit = static_cast<uint64>(C - TEXT('0'));
						if (Num > (MaxSafeInteger - Digit) / 10)
						{
							bOk = false;
							break;
						}
						Num = Num * 10 + Digit;
					}
					if (bOk && Num < MaxSafeInteger)
					{
						Ident.bNumeric = true;
						Ident.Num = Num;
					}
					else
					{
						Ident.Str = Id;
					}
				}
				else
				{
					Ident.Str = Id;
				}
				Out.Prerelease.Add(MoveTemp(Ident));
			}
		}

		// Build the canonical form (used as an equality fast-path).
		FString Canonical = FString::Printf(
			TEXT("%llu.%llu.%llu"), Out.Major, Out.Minor, Out.Patch);
		if (Out.Prerelease.Num() > 0)
		{
			Canonical += TEXT("-");
			for (int32 i = 0; i < Out.Prerelease.Num(); ++i)
			{
				if (i > 0)
				{
					Canonical += TEXT(".");
				}
				const FIdentifier& Id = Out.Prerelease[i];
				Canonical += Id.bNumeric ? FString::Printf(TEXT("%llu"), Id.Num) : Id.Str;
			}
		}
		Out.Canonical = MoveTemp(Canonical);
		Out.bIsValid = true;
		return Out;
	}

	int32 FSemVer::CompareMain(const FSemVer& Other) const
	{
		if (Major != Other.Major)
		{
			return Major < Other.Major ? -1 : 1;
		}
		if (Minor != Other.Minor)
		{
			return Minor < Other.Minor ? -1 : 1;
		}
		if (Patch != Other.Patch)
		{
			return Patch < Other.Patch ? -1 : 1;
		}
		return 0;
	}

	int32 FSemVer::ComparePre(const FSemVer& Other) const
	{
		// A version WITHOUT a pre-release is higher-precedence than one WITH.
		const bool bAEmpty = Prerelease.Num() == 0;
		const bool bBEmpty = Other.Prerelease.Num() == 0;
		if (!bAEmpty && bBEmpty)
		{
			return -1;
		}
		if (bAEmpty && !bBEmpty)
		{
			return 1;
		}
		if (bAEmpty && bBEmpty)
		{
			return 0;
		}

		for (int32 i = 0;; ++i)
		{
			const bool bAHas = i < Prerelease.Num();
			const bool bBHas = i < Other.Prerelease.Num();
			if (!bAHas && !bBHas)
			{
				return 0;
			}
			if (!bBHas)
			{
				return 1;
			}
			if (!bAHas)
			{
				return -1;
			}
			const FIdentifier& A = Prerelease[i];
			const FIdentifier& B = Other.Prerelease[i];
			if (A.bNumeric == B.bNumeric && A.Num == B.Num && A.Str == B.Str)
			{
				continue;
			}
			return CompareIdentifiers(A.bNumeric, A.Num, A.Str, B.bNumeric, B.Num, B.Str);
		}
	}

	int32 FSemVer::Compare(const FSemVer& Other) const
	{
		if (Canonical == Other.Canonical)
		{
			return 0;
		}
		const int32 Main = CompareMain(Other);
		if (Main != 0)
		{
			return Main;
		}
		return ComparePre(Other);
	}
}
