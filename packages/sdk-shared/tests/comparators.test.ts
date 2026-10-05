// SPDX-License-Identifier: MIT

/**
 * Focused unit coverage for the comparator primitives (US2). The vendored
 * upstream matrix in `parity-upstream.test.ts` is the exhaustive gate; these
 * pin the easy-to-get-wrong edges directly against `configcat-common@9.4.1`
 * behaviour: strict number parsing, the multibyte sensitive byte-slice, and
 * the three-valued validation outcomes.
 */

import { describe, expect, it } from "vitest";

import {
  attributeAsNumber,
  attributeAsStringArray,
  evaluateSensitiveTextSliceEqualsAnyOf,
  evaluateTextSliceEqualsAnyOf,
  isStringArray,
  parseFloatStrict,
  userAttributeValueToString,
} from "../src/comparators.ts";

describe("parseFloatStrict (whole-string, comma already normalized by caller)", () => {
  it("parses a plain decimal", () => {
    expect(parseFloatStrict("1.5")).toBe(1.5);
  });
  it("rejects a number with trailing garbage (NOT a prefix parse)", () => {
    expect(parseFloatStrict("12abc")).toBeNaN();
  });
  it("rejects empty / all-whitespace", () => {
    expect(parseFloatStrict("")).toBeNaN();
    expect(parseFloatStrict("   ")).toBeNaN();
  });
  it("rejects hex / octal leading zero forms", () => {
    expect(parseFloatStrict("0x1F")).toBeNaN();
  });
  it("accepts scientific notation and tolerates surrounding whitespace", () => {
    expect(parseFloatStrict("1e3")).toBe(1000);
    expect(parseFloatStrict(" 1.5 ")).toBe(1.5);
  });
});

describe("userAttributeValueToString (common-js parity)", () => {
  it("stringifies a Date as Unix seconds", () => {
    expect(userAttributeValueToString(new Date(1000))).toBe("1");
  });
  it("JSON-stringifies a string array", () => {
    expect(userAttributeValueToString(["a", "b"])).toBe('["a","b"]');
  });
});

describe("isStringArray", () => {
  it("is true only for all-string arrays", () => {
    expect(isStringArray(["a"])).toBe(true);
    expect(isStringArray([1])).toBe(false);
    expect(isStringArray("a")).toBe(false);
  });
});

describe("attribute conversion → three-valued outcome (FR-010)", () => {
  it("number conversion errors on non-numeric text", () => {
    const r = attributeAsNumber("Age", "not-a-number");
    expect(r.ok).toBe(false);
  });
  it("string-array conversion errors on a non-JSON string", () => {
    const r = attributeAsStringArray("Roles", "read,execute");
    expect(r.ok).toBe(false);
  });
  it("string-array conversion accepts a JSON array string", () => {
    const r = attributeAsStringArray("Roles", '["read","execute"]');
    expect(r).toEqual({ ok: true, value: ["read", "execute"] });
  });
});

describe("cleartext startsWith/endsWith any-of", () => {
  it("matches a prefix and respects negate", () => {
    expect(evaluateTextSliceEqualsAnyOf("Dog food", ["Dog"], true, false)).toBe(true);
    expect(evaluateTextSliceEqualsAnyOf("Dog food", ["Dog"], true, true)).toBe(false);
  });
  it("matches a suffix; skips operands longer than the text", () => {
    expect(evaluateTextSliceEqualsAnyOf("Dog food", ["food"], false, false)).toBe(true);
    expect(evaluateTextSliceEqualsAnyOf("Dog", ["Dog food"], true, false)).toBe(false);
  });
});

describe("sensitive startsWith/endsWith — multibyte byte-slice (testmatrix_unicode oracle)", () => {
  // From content-by-key.json key Da6w8dBbmUeMUBhh0iEeQQ → boolStartsWithHashed,
  // a 13-BYTE prefix of "ÁRVÍZTŰRŐ tükörfúrógép" (each accented char is 2 UTF-8
  // bytes, so the cut lands mid-multibyte — the hash MUST run over raw bytes).
  const salt = "9Ye6QeYbxP3pBmWlj+kD3ye2tWHDb9mVIc/T8UoOpsk=";
  const ctx = "boolStartsWithHashed";
  const text = "ÁRVÍZTŰRŐ tükörfúrógép";
  const operand = "13_90969e5a4df699232fbebfc7a3221db58cf49f89804791048bd59f87132bcbd1";

  it("matches the 13-byte salted slice hash", () => {
    expect(evaluateSensitiveTextSliceEqualsAnyOf(text, [operand], salt, ctx, true, false)).toBe(
      true,
    );
  });
  it("negate inverts the match", () => {
    expect(evaluateSensitiveTextSliceEqualsAnyOf(text, [operand], salt, ctx, true, true)).toBe(
      false,
    );
  });
});
