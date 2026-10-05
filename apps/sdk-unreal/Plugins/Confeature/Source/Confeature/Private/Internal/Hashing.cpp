// SPDX-License-Identifier: MIT

#include "Internal/Hashing.h"

#include "Misc/SecureHash.h"

namespace Confeature::Internal
{
	namespace
	{
		const ANSICHAR HexAlphabet[] = "0123456789abcdef";

		// Lowercase-hex-encode `Len` bytes of `Digest`.
		FString ToHex(const uint8* Digest, int32 Len)
		{
			FString Out;
			Out.Reserve(Len * 2);
			for (int32 i = 0; i < Len; ++i)
			{
				Out.AppendChar(static_cast<TCHAR>(HexAlphabet[(Digest[i] >> 4) & 0x0F]));
				Out.AppendChar(static_cast<TCHAR>(HexAlphabet[Digest[i] & 0x0F]));
			}
			return Out;
		}

		// Parse a hex string into a uint32. The percentage bucketer feeds a
		// 7-hex-char string (28 bits), well within uint32 range. Returns 0 on
		// any unexpected non-hex char (defensive — the SHA-1 output is always
		// valid hex).
		uint32 ParseHex(const FString& Hex)
		{
			uint32 Value = 0;
			for (const TCHAR C : Hex)
			{
				uint32 Digit;
				if (C >= TEXT('0') && C <= TEXT('9'))
				{
					Digit = static_cast<uint32>(C - TEXT('0'));
				}
				else if (C >= TEXT('a') && C <= TEXT('f'))
				{
					Digit = static_cast<uint32>(C - TEXT('a') + 10);
				}
				else if (C >= TEXT('A') && C <= TEXT('F'))
				{
					Digit = static_cast<uint32>(C - TEXT('A') + 10);
				}
				else
				{
					return 0;
				}
				Value = (Value << 4) | Digit;
			}
			return Value;
		}
	}

	FString Sha1Hex(const FString& Input)
	{
		// UTF-8-encode the FString — the byte-level input MUST match the other
		// ports (FTCHARToUTF8 mirrors common-js `utf8Encode`).
		const FTCHARToUTF8 Utf8(Input.GetCharArray().GetData(), Input.Len());
		const uint8* Bytes = reinterpret_cast<const uint8*>(Utf8.Get());
		const int32 Len = Utf8.Length();

		// FSHA1::HashBuffer writes a 20-byte digest. `HashBuffer` accepts a
		// zero-length buffer (the empty-string case) without issue.
		uint8 Digest[20];
		FSHA1::HashBuffer(Bytes, static_cast<uint64>(Len), Digest);
		return ToHex(Digest, 20);
	}

	FString Sha256HexBytes(const uint8* Data, int32 Len)
	{
		// Mirror the SdkKey.cpp FSHA256 read pattern: stack-construct, Update,
		// Final, then read the 32-byte digest via GetHash.
		FSHA256 Sha;
		if (Len > 0)
		{
			Sha.Update(Data, Len);
		}
		Sha.Final();
		uint8 Digest[32];
		Sha.GetHash(Digest);
		return ToHex(Digest, 32);
	}

	FString Sha256Hex(const FString& Input)
	{
		const FTCHARToUTF8 Utf8(Input.GetCharArray().GetData(), Input.Len());
		return Sha256HexBytes(
			reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
	}

	int32 PercentageBucket(const FString& Key, const FString& AttrValue)
	{
		const FString Hex = Sha1Hex(Key + AttrValue).Left(7);
		// 7 hex chars = 28 bits — within an unsigned 32-bit parse.
		const uint32 HashValue = ParseHex(Hex);
		return static_cast<int32>(HashValue % 100u);
	}

	FString HashComparisonValue(
		const FString& Value, const FString& ConfigJsonSalt, const FString& ContextSalt)
	{
		return Sha256Hex(Value + ConfigJsonSalt + ContextSalt);
	}

	FString HashComparisonValueSlice(const uint8* SliceBytes, int32 SliceLen,
		const FString& ConfigJsonSalt, const FString& ContextSalt)
	{
		// The slice is raw UTF-8 bytes (may land mid-codepoint); concatenate
		// the salt bytes and hash the whole byte sequence. Re-encoding would
		// corrupt multibyte attributes (the `testmatrix_unicode` *Hashed rows).
		const FTCHARToUTF8 SaltUtf8(
			ConfigJsonSalt.GetCharArray().GetData(), ConfigJsonSalt.Len());
		const FTCHARToUTF8 CtxUtf8(ContextSalt.GetCharArray().GetData(), ContextSalt.Len());

		TArray<uint8> Buf;
		Buf.Reserve(SliceLen + SaltUtf8.Length() + CtxUtf8.Length());
		Buf.Append(SliceBytes, SliceLen);
		Buf.Append(reinterpret_cast<const uint8*>(SaltUtf8.Get()), SaltUtf8.Length());
		Buf.Append(reinterpret_cast<const uint8*>(CtxUtf8.Get()), CtxUtf8.Length());
		return Sha256HexBytes(Buf.GetData(), Buf.Num());
	}
}
