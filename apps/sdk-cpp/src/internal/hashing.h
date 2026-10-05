// SPDX-License-Identifier: MIT
#ifndef CONFEATURE_INTERNAL_HASHING_H_
#define CONFEATURE_INTERNAL_HASHING_H_

// Two hashes the ConfigCat decision engine needs (spec 130, ported from
// `packages/sdk-shared/src/hash.ts`), both backed by OpenSSL EVP (already a
// dependency — see `internal/sdk_key.cpp`). NO vendored SHA implementation.
//
//   - SHA-1, UNSALTED — percentage bucketing:
//       parseInt(sha1(key + attrValue)[0..7], 16) % 100
//     `EVP_sha1()` over the UTF-8 input, lowercase hex, first 7 hex chars.
//   - SHA-256, SALTED — sensitive comparators:
//       sha256( value + configJsonSalt + contextSalt )
//     `EVP_sha256()` over the concatenated UTF-8 bytes, lowercase hex.
//     The slice variant hashes a raw UTF-8 BYTE slice (which may land
//     mid-codepoint) + the salt bytes, so a byte-level entry point is needed
//     (re-encoding a binary string as UTF-8 would corrupt multibyte attrs).

#include <cstddef>
#include <cstdint>
#include <string>

namespace confeature::internal {

// Lowercase-hex SHA-1 of `input` (40 chars). Used UNSALTED for percentage
// bucketing.
std::string sha1Hex(const std::string& input);

// Lowercase-hex SHA-256 of the raw bytes `data[0..len)` (64 chars).
std::string sha256HexBytes(const unsigned char* data, std::size_t len);

// Lowercase-hex SHA-256 of `input` (64 chars).
std::string sha256Hex(const std::string& input);

// ConfigCat percentage bucket in [0, 99] for `key + attrValue`:
//   stoull( sha1(key + attrValue)[0..7], 16 ) % 100.
// SHA-1, UNSALTED.
std::uint64_t percentageBucket(const std::string& key, const std::string& attrValue);

// Sensitive-comparator operand hash (common-js `hashComparisonValue`):
//   sha256( value + configJsonSalt + contextSalt ), lowercase hex.
std::string hashComparisonValue(const std::string& value, const std::string& configJsonSalt,
                                const std::string& contextSalt);

// Sensitive startsWith/endsWith slice hash (common-js
// `hashComparisonValueSlice`): sha256( sliceBytes ++ saltBytes ++ ctxBytes ).
// `slice` is a raw UTF-8 byte slice of the attribute.
std::string hashComparisonValueSlice(const std::string& slice, const std::string& configJsonSalt,
                                     const std::string& contextSalt);

}  // namespace confeature::internal

#endif  // CONFEATURE_INTERNAL_HASHING_H_
