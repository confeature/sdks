// SPDX-License-Identifier: MIT

// ConfigCat evaluation hashes — SHA-1 (unsalted %) + SHA-256 (salted sensitive).
//
// Ported field-for-field from the spec-117 TS reference
// (packages/sdk-shared/src/hash.ts). The flag evaluator needs two hashes:
//
//   - SHA-1, UNSALTED for percentage bucketing —
//     ParseInt(hex(sha1(key + attrValue))[:7], 16) % 100.
//   - SHA-256, SALTED for sensitive comparators —
//     sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt)).
//
// Unlike the TS reference (which vendors a pure-JS implementation because
// crypto.subtle is async on every runtime), Go's crypto/sha1 + crypto/sha256
// are synchronous stdlib and present everywhere, so we use them directly. The
// bytes hashed are identical to the TS implementation — UTF-8-encoded text for
// the text paths, raw byte slices for the startsWith/endsWith slice scheme — so
// every bucket / hash comes out byte-identical with the JS family (the parity
// corpus requires this).
package evaluator

import (
	"crypto/sha1" //nolint:gosec // bucketing/hashed-equality, not a security boundary (ConfigCat parity).
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// sha1Hex returns the lowercase-hex SHA-1 of raw bytes (mirrors hash.ts::sha1).
func sha1Hex(data []byte) string {
	sum := sha1.Sum(data) //nolint:gosec // see package note.
	return hex.EncodeToString(sum[:])
}

// sha256Hex returns the lowercase-hex SHA-256 of raw bytes (mirrors
// hash.ts::sha256Bytes).
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// hashComparisonValue hashes a user-attribute value for a sensitive comparator.
//
// Mirrors hash.ts::hashComparisonValue (common-js hashComparisonValue):
//
//	sha256( utf8(value) + utf8(configJSONSalt) + utf8(contextSalt) )
//
// concatenated with no separators, output as lowercase hex. contextSalt is the
// per-evaluation discriminator — the setting key for a user condition, or the
// segment name for a segment condition.
func hashComparisonValue(value, configJSONSalt, contextSalt string) string {
	return sha256Hex([]byte(value + configJSONSalt + contextSalt))
}

// hashComparisonValueSlice hashes a UTF-8 byte slice for a sensitive
// startsWith/endsWith comparator.
//
// Mirrors comparators.ts::hashComparisonValueSlice (common-js
// hashComparisonValueSlice):
//
//	sha256( sliceUtf8Bytes ++ utf8(configSalt) ++ utf8(contextSalt) )
//
// The slice is raw bytes — a byte-boundary cut of the attribute, which may land
// mid-codepoint — so the hash runs over the concatenated byte sequence
// (re-encoding a binary string as UTF-8 would corrupt multibyte attributes, the
// testmatrix_unicode *Hashed rows).
func hashComparisonValueSlice(sliceUTF8 []byte, configJSONSalt, contextSalt string) string {
	buf := make([]byte, 0, len(sliceUTF8)+len(configJSONSalt)+len(contextSalt))
	buf = append(buf, sliceUTF8...)
	buf = append(buf, configJSONSalt...)
	buf = append(buf, contextSalt...)
	return sha256Hex(buf)
}

// percentageBucket computes a ConfigCat percentage bucket in [0, 99] for
// key + attrValue.
//
// Mirrors hash.ts::percentageBucket (common-js evaluatePercentageOptions):
//
//	ParseInt( hex(sha1(key + attrValue))[:7], 16 ) % 100
//
// SHA-1, UNSALTED. 7 hex chars = 28 bits, well within a safe int64.
func percentageBucket(key, attrValue string) int {
	h := sha1Hex([]byte(key + attrValue))
	n, err := strconv.ParseInt(h[:7], 16, 64)
	if err != nil {
		// Unreachable: a SHA-1 hex digest's first 7 chars are always valid
		// hex. Surfaced as bucket 0 rather than a panic for the fail-closed
		// guarantee.
		return 0
	}
	return int(n % 100)
}
