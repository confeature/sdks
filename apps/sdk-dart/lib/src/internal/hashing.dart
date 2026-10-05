// SPDX-License-Identifier: MIT

/// ConfigCat evaluation hashes — SHA-1 (unsalted %) + SHA-256 (salted
/// sensitive). Ported field-for-field from the spec-117 TS reference
/// (`packages/sdk-shared/src/hash.ts`), cross-checked against the
/// spec-118/119/120/121/122 Python / Go / Ruby / PHP / .NET ports.
///
/// The flag evaluator needs two synchronous hashes:
///
///   - **SHA-1, UNSALTED** for percentage bucketing —
///     `int.parse(sha1hex.substring(0, 7), radix: 16) % 100`.
///   - **SHA-256, SALTED** for sensitive comparators —
///     `sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))`.
///
/// Unlike the TS reference (which vendors a pure-JS implementation because
/// `crypto.subtle` is async on every runtime), Dart's `crypto` package
/// (already a dependency) is synchronous, so we call it directly. UTF-8
/// bytes are obtained via `dart:convert`'s `utf8.encode`; the slice variant
/// hashes a raw BYTE slice concatenated with the salt bytes, so every bucket
/// / hash comes out byte-identical across the federation (the parity corpus
/// requires this).
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Lowercase-hex SHA-1 of the UTF-8 bytes of [input] (mirrors `hash.ts::sha1`).
String sha1Hex(String input) => sha1.convert(utf8.encode(input)).toString();

/// Lowercase-hex SHA-256 of the UTF-8 bytes of [input] (mirrors
/// `hash.ts::sha256`).
String sha256Hex(String input) => sha256.convert(utf8.encode(input)).toString();

/// Lowercase-hex SHA-256 of the raw [bytes] (mirrors `hash.ts::sha256Bytes`).
///
/// The byte-level entry point the sensitive startsWith/endsWith comparators
/// need: they slice the attribute at the UTF-8 **byte** boundary and hash that
/// slice concatenated with the salt bytes — so the input is an arbitrary byte
/// sequence, not re-encodable text.
String sha256Bytes(List<int> bytes) => sha256.convert(bytes).toString();

/// Hash a user-attribute value for a **sensitive** comparator. Mirrors
/// `hash.ts::hashComparisonValue`:
///
///     sha256( utf8(value) + utf8(configJsonSalt) + utf8(contextSalt) )
///
/// concatenated with no separators, output as lowercase hex.
///
/// [contextSalt] is the per-evaluation discriminator — the setting key for a
/// user condition, the segment name for a segment condition.
String hashComparisonValue(
  String value,
  String configJsonSalt,
  String contextSalt,
) =>
    sha256Hex(value + configJsonSalt + contextSalt);

/// Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator.
/// Mirrors `comparators.ts::hashComparisonValueSlice`:
///
///     sha256( sliceBytes + utf8(configSalt) + utf8(contextSalt) )
///
/// [sliceUtf8] is a raw byte slice (a byte-boundary cut of the attribute,
/// which may land mid-codepoint), so the hash runs over the concatenated byte
/// sequence — re-encoding a binary slice as UTF-8 would corrupt multibyte
/// attributes (the `testmatrix_unicode` `*Hashed` rows).
String hashComparisonValueSlice(
  List<int> sliceUtf8,
  String configJsonSalt,
  String contextSalt,
) {
  final buf = <int>[
    ...sliceUtf8,
    ...utf8.encode(configJsonSalt),
    ...utf8.encode(contextSalt),
  ];
  return sha256Bytes(buf);
}

/// Compute a ConfigCat percentage bucket in `[0, 99]` for `key + attrValue`.
/// Mirrors `hash.ts::percentageBucket`:
///
///     int.parse(sha1(key + attrValue).substring(0, 7), radix: 16) % 100
///
/// SHA-1, **unsalted**. 7 hex chars = 28 bits, well within a safe int.
int percentageBucket(String key, String attrValue) {
  final hex = sha1Hex(key + attrValue).substring(0, 7);
  return int.parse(hex, radix: 16) % 100;
}
