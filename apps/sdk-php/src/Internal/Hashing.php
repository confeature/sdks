<?php

// SPDX-License-Identifier: MIT

declare(strict_types=1);

namespace Confeature\Internal;

/**
 * ConfigCat evaluation hashes — SHA-1 (unsalted %) + SHA-256 (salted
 * sensitive). Ported field-for-field from the spec-117 TS reference
 * (`packages/sdk-shared/src/hash.ts`), cross-checked against the
 * spec-118/119/120 Python / Go / Ruby ports. The flag evaluator needs
 * two synchronous hashes:
 *
 *   - **SHA-1, UNSALTED** for percentage bucketing —
 *     `hexdec(substr(hash('sha1', $key . $attr), 0, 7)) % 100`.
 *   - **SHA-256, SALTED** for sensitive comparators —
 *     `sha256(utf8(value) . utf8(configSalt) . utf8(contextSalt))`.
 *
 * Unlike the TS reference (which vendors a pure-JS implementation because
 * `crypto.subtle` is async on every runtime), PHP's stdlib `hash()` is
 * synchronous and always present, so we call it directly. PHP strings ARE
 * byte sequences: JSON-decoded strings are UTF-8, so `.` concatenation and
 * `substr` slicing operate on the exact byte sequence the TS / Python / Go /
 * Ruby ports hash — every bucket / hash comes out byte-identical across the
 * federation (the parity corpus requires this).
 */
final class Hashing
{
    private function __construct()
    {
    }

    /**
     * Lowercase-hex SHA-1 of the raw byte string (mirrors `hash.ts::sha1`).
     */
    public static function sha1Hex(string $data): string
    {
        return hash('sha1', $data);
    }

    /**
     * Lowercase-hex SHA-256 of the raw byte string (mirrors
     * `hash.ts::sha256Bytes`).
     */
    public static function sha256Hex(string $data): string
    {
        return hash('sha256', $data);
    }

    /**
     * Hash a user-attribute value for a **sensitive** comparator. Mirrors
     * `hash.ts::hashComparisonValue`:
     *
     *     sha256( utf8(value) . utf8(configJsonSalt) . utf8(contextSalt) )
     *
     * concatenated with no separators, output as lowercase hex.
     *
     * @param string $value          attribute value as text (after conversion)
     * @param string $configJsonSalt top-level config salt (`config['p']['s']`)
     * @param string $contextSalt    per-evaluation discriminator — the setting
     *                                key for a user condition, the segment name
     *                                for a segment condition
     */
    public static function hashComparisonValue(
        string $value,
        string $configJsonSalt,
        string $contextSalt,
    ): string {
        return self::sha256Hex($value . $configJsonSalt . $contextSalt);
    }

    /**
     * Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator.
     * Mirrors `comparators.ts::hashComparisonValueSlice`:
     *
     *     sha256( sliceBytes . utf8(configSalt) . utf8(contextSalt) )
     *
     * `$sliceUtf8` is a raw byte slice (a byte-boundary cut of the attribute,
     * which may land mid-codepoint), so the hash runs over the concatenated
     * byte sequence. PHP string concatenation is byte-level, so this is exact.
     */
    public static function hashComparisonValueSlice(
        string $sliceUtf8,
        string $configJsonSalt,
        string $contextSalt,
    ): string {
        return self::sha256Hex($sliceUtf8 . $configJsonSalt . $contextSalt);
    }

    /**
     * Compute a ConfigCat percentage bucket in `[0, 99]` for
     * `key . attrValue`. Mirrors `hash.ts::percentageBucket`:
     *
     *     hexdec(substr(sha1(key . attrValue), 0, 7)) % 100
     *
     * SHA-1, **unsalted**. 7 hex chars = 28 bits, safely within PHP's int
     * range on every supported platform.
     */
    public static function percentageBucket(string $key, string $attrValue): int
    {
        $hex = substr(self::sha1Hex($key . $attrValue), 0, 7);

        return (int) (hexdec($hex) % 100);
    }
}
