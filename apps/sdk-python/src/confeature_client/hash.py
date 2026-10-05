# SPDX-License-Identifier: MIT
"""ConfigCat evaluation hashes — SHA-1 (unsalted %) + SHA-256 (salted sensitive).

Ported field-for-field from the spec-117 TS reference
(`packages/sdk-shared/src/hash.ts`). The flag evaluator needs two
synchronous hashes:

  - **SHA-1, UNSALTED** for percentage bucketing —
    ``int(sha1(key + attrValue).hexdigest()[:7], 16) % 100``.
  - **SHA-256, SALTED** for sensitive comparators —
    ``sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))``.

Unlike the TS reference (which vendors a pure-JS implementation because
`crypto.subtle` is async on every runtime), Python's stdlib `hashlib` is
**synchronous and present everywhere** (research §R2 / Assumptions), so we use
it directly. The bytes hashed are identical to the TS implementation —
UTF-8-encoded text for the text paths, raw byte slices for the
startsWith/endsWith slice scheme — so every bucket / hash comes out
byte-identical with the JS family (the parity corpus requires this).
"""

from __future__ import annotations

import hashlib


def sha1_hex(data: bytes) -> str:
    """Lowercase-hex SHA-1 of raw bytes (mirrors `hash.ts::sha1`)."""
    return hashlib.sha1(data, usedforsecurity=False).hexdigest()


def sha256_hex(data: bytes) -> str:
    """Lowercase-hex SHA-256 of raw bytes (mirrors `hash.ts::sha256Bytes`)."""
    return hashlib.sha256(data, usedforsecurity=False).hexdigest()


def hash_comparison_value(value: str, config_json_salt: str, context_salt: str) -> str:
    """Hash a user-attribute value for a **sensitive** comparator.

    Mirrors `hash.ts::hashComparisonValue` (common-js `hashComparisonValue`)::

        sha256( utf8(value) + utf8(configJsonSalt) + utf8(contextSalt) )

    concatenated with no separators, output as lowercase hex.

    Args:
        value: the user attribute value as text (after attribute conversion).
        config_json_salt: the top-level config salt (``config["p"]["s"]``).
        context_salt: the per-evaluation discriminator — the setting key for a
            user condition, or the segment name for a segment condition.
    """
    return sha256_hex((value + config_json_salt + context_salt).encode("utf-8"))


def hash_comparison_value_slice(
    slice_utf8: bytes,
    config_json_salt: str,
    context_salt: str,
) -> str:
    """Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator.

    Mirrors `comparators.ts::hashComparisonValueSlice` (common-js
    `hashComparisonValueSlice`)::

        sha256( sliceUtf8Bytes ++ utf8(configSalt) ++ utf8(contextSalt) )

    The slice is **raw bytes** — a byte-boundary cut of the attribute, which may
    land mid-codepoint — so the hash runs over the concatenated byte sequence
    (re-encoding a binary string as UTF-8 would corrupt multibyte attributes,
    the `testmatrix_unicode` ``*Hashed`` rows).
    """
    return sha256_hex(slice_utf8 + config_json_salt.encode("utf-8") + context_salt.encode("utf-8"))


def percentage_bucket(key: str, attr_value: str) -> int:
    """Compute a ConfigCat percentage bucket in ``[0, 99]`` for ``key + attrValue``.

    Mirrors `hash.ts::percentageBucket` (common-js
    ``evaluatePercentageOptions``)::

        int( sha1(key + attrValue).hexdigest()[:7], 16 ) % 100

    SHA-1, **unsalted**. 7 hex chars = 28 bits, well within a safe integer.
    """
    return int(sha1_hex((key + attr_value).encode("utf-8"))[:7], 16) % 100
