// SPDX-License-Identifier: MIT
#pragma once

// Two hashes the ConfigCat decision engine needs (spec 131, re-ported from
// the corpus-verified C++ port `apps/sdk-cpp/src/internal/hashing.cpp`, which
// ports `packages/sdk-shared/src/hash.ts`). Both backed by UE's bundled
// `Misc/SecureHash.h` (`FSHA1` / `FSHA256`, already used by `SdkKey.cpp`).
// NO vendored / third-party SHA implementation.
//
//   - SHA-1, UNSALTED — percentage bucketing:
//       parseInt(sha1(key + attrValue)[0..7], 16) % 100
//     `FSHA1::HashBuffer` over the UTF-8 input, lowercase hex, first 7 hex
//     chars.
//   - SHA-256, SALTED — sensitive comparators:
//       sha256( value + configJsonSalt + contextSalt )
//     `FSHA256` (stack-construct / Update / Final / GetHash, mirroring
//     `SdkKey.cpp`) over the concatenated UTF-8 bytes, lowercase hex.
//     The slice variant hashes a raw UTF-8 BYTE slice (which may land
//     mid-codepoint) + the salt bytes, so a byte-level entry point is
//     needed — re-encoding a binary string as UTF-8 would corrupt multibyte
//     attributes (the `testmatrix_unicode` *Hashed rows).

#include "CoreMinimal.h"

namespace Confeature::Internal
{
	// Lowercase-hex SHA-1 of `Input` (40 chars). Used UNSALTED for percentage
	// bucketing. `Input` is UTF-8-encoded before hashing.
	FString Sha1Hex(const FString& Input);

	// Lowercase-hex SHA-256 of the raw bytes `Data[0..Len)` (64 chars).
	FString Sha256HexBytes(const uint8* Data, int32 Len);

	// Lowercase-hex SHA-256 of `Input` (64 chars). `Input` is UTF-8-encoded
	// before hashing.
	FString Sha256Hex(const FString& Input);

	// ConfigCat percentage bucket in [0, 99] for `Key + AttrValue`:
	//   ParseInt( sha1(Key + AttrValue)[0..7], 16 ) % 100.
	// SHA-1, UNSALTED.
	int32 PercentageBucket(const FString& Key, const FString& AttrValue);

	// Sensitive-comparator operand hash (common-js `hashComparisonValue`):
	//   sha256( value + configJsonSalt + contextSalt ), lowercase hex.
	FString HashComparisonValue(
		const FString& Value, const FString& ConfigJsonSalt, const FString& ContextSalt);

	// Sensitive startsWith/endsWith slice hash (common-js
	// `hashComparisonValueSlice`): sha256( sliceBytes ++ saltBytes ++ ctxBytes ).
	// `SliceBytes`/`SliceLen` is a raw UTF-8 byte slice of the attribute.
	FString HashComparisonValueSlice(const uint8* SliceBytes, int32 SliceLen,
		const FString& ConfigJsonSalt, const FString& ContextSalt);
}
