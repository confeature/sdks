// SPDX-License-Identifier: MIT

#include "Internal/SdkKey.h"

#include "Misc/SecureHash.h"

namespace Confeature::Internal
{
	namespace
	{
		// URL-safe base64 alphabet — RFC 4648 §5. We hand-roll the
		// encoder rather than reusing UE's `FBase64::Encode` because
		// FBase64 emits the standard alphabet ('+' / '/') + padding,
		// which we'd then have to post-process. A 30-line encoder is
		// faster + clearer + byte-identical to the canonical TS port.
		constexpr ANSICHAR B64UrlAlphabet[] =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

		// Compares the full TCHAR (not a byte-truncated cast): a
		// non-ASCII code unit such as U+012D must not alias to '-'.
		bool IsB64UrlChar(TCHAR C)
		{
			return (C >= TEXT('A') && C <= TEXT('Z')) || (C >= TEXT('a') && C <= TEXT('z'))
				|| (C >= TEXT('0') && C <= TEXT('9')) || C == TEXT('_') || C == TEXT('-');
		}

		// True when `S[Start, Start + Count)` lies inside `S` and is
		// entirely URL-safe base64 characters.
		bool IsB64UrlRun(const FString& S, int32 Start, int32 Count)
		{
			if (Start < 0 || Count < 0 || Start + Count > S.Len())
			{
				return false;
			}
			for (int32 I = Start; I < Start + Count; ++I)
			{
				if (!IsB64UrlChar(S[I]))
				{
					return false;
				}
			}
			return true;
		}

		// `<Prefix><N url-safe><Sep><N url-safe>` — exactly, nothing after.
		// Positional rather than split-based: the alphabet contains '-',
		// so a legacy key's segments may themselves contain the '-'
		// separator. Equivalent to the canonical TS regex
		// `^<Prefix>[A-Za-z0-9_-]{N}<Sep>[A-Za-z0-9_-]{N}$`.
		bool MatchesTwoSegmentShape(
			const FString& SdkKey, const TCHAR* Prefix, TCHAR Sep, int32 SegmentLen)
		{
			if (!SdkKey.StartsWith(Prefix, ESearchCase::CaseSensitive))
			{
				return false;
			}
			const int32 P = FCString::Strlen(Prefix);
			return SdkKey.Len() == P + SegmentLen + 1 + SegmentLen
				&& IsB64UrlRun(SdkKey, P, SegmentLen)
				&& SdkKey[P + SegmentLen] == Sep
				&& IsB64UrlRun(SdkKey, P + SegmentLen + 1, SegmentLen);
		}
	}

	FString Base64UrlEncode(const uint8* Data, int32 Len)
	{
		FString Out;
		Out.Reserve(((Len + 2) / 3) * 4);

		int32 i = 0;
		for (; i + 3 <= Len; i += 3)
		{
			const uint32 A = Data[i];
			const uint32 B = Data[i + 1];
			const uint32 C = Data[i + 2];
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[(A >> 2) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[((A << 4) | (B >> 4)) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[((B << 2) | (C >> 6)) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[C & 0x3F]));
		}

		const int32 Rem = Len - i;
		if (Rem == 1)
		{
			const uint32 A = Data[i];
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[(A >> 2) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[(A << 4) & 0x3F]));
		}
		else if (Rem == 2)
		{
			const uint32 A = Data[i];
			const uint32 B = Data[i + 1];
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[(A >> 2) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[((A << 4) | (B >> 4)) & 0x3F]));
			Out.AppendChar(static_cast<TCHAR>(B64UrlAlphabet[(B << 2) & 0x3F]));
		}
		// No-pad — matches the canonical TS `URL_SAFE_NO_PAD`.
		return Out;
	}

	bool IsValidConfeatureKeyFormat(const FString& SdkKey)
	{
		// Mirrors `packages/sdk-shared/src/sdk-key.ts:CONFEATURE_SDK_KEY_PATTERN`
		// (#802). Accept/reject cases:
		// `packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json`.
		return MatchesTwoSegmentShape(SdkKey, TEXT("configcat-sdk-1/"), TEXT('/'), 22)
			|| MatchesTwoSegmentShape(SdkKey, TEXT("confeature-sdk-1-"), TEXT('-'), 32);
	}

	FString RedactSdkKey(const FString& SdkKey)
	{
		if (SdkKey.Len() < 16)
		{
			return TEXT("[redacted]");
		}
		const int32 Visible = FMath::Max(SdkKey.Len() / 10, 4);
		// U+2026 HORIZONTAL ELLIPSIS in UTF-16 (UE's native TCHAR width
		// on most platforms) — `…`. Cross-language redaction parity.
		const FString Ellipsis = TEXT("…");
		return FString::Printf(
			TEXT("%s%s[redacted]%s%s"),
			*SdkKey.Left(Visible),
			*Ellipsis,
			*Ellipsis,
			*SdkKey.Right(Visible));
	}

	FString DeriveCacheKey(const FString& SdkKey)
	{
		// Convert FString → UTF-8 byte sequence. UE's `FTCHARToUTF8` is
		// a stack-allocated converter that owns the resulting buffer;
		// capture it into a strong holder so the pointer stays valid
		// through the SHA-256 update.
		const FTCHARToUTF8 Utf8(SdkKey.GetCharArray().GetData(), SdkKey.Len());
		const int32 Utf8Len = Utf8.Length();
		const uint8* Utf8Bytes = reinterpret_cast<const uint8*>(Utf8.Get());

		// FSHA256 ships in UE 5.3+ via `Misc/SecureHash.h`. The API
		// mirrors FSHA1: stack-construct, `Update`, `Final`, then read
		// the 32-byte digest via `GetHash`. If a future UE version
		// shuffles the namespace (e.g. UE 5.6 moving to FSHA2), the
		// owning agent must port this site — every other SDK in the
		// federation tests the same fixture corpus so drift is loud.
		FSHA256 Sha;
		Sha.Update(Utf8Bytes, Utf8Len);
		Sha.Final();
		uint8 Digest[32];
		Sha.GetHash(Digest);

		// Encode the full 32-byte digest then truncate to 32 base64url
		// chars — matches the canonical "first 32 base64url chars"
		// cross-language rule.
		const FString Encoded = Base64UrlEncode(Digest, 32);
		return FString::Printf(TEXT("%s%s"), CacheKeyPrefix, *Encoded.Left(32));
	}

	FString CacheKeyTail(const FString& CacheKey)
	{
		int32 Colon = INDEX_NONE;
		if (CacheKey.FindLastChar(TEXT(':'), Colon))
		{
			return CacheKey.RightChop(Colon + 1);
		}
		return CacheKey;
	}
}
