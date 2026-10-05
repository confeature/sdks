// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  CONFEATURE_SDK_KEY_PATTERN,
  isValidConfeatureKeyFormat,
  redactSdkKey,
} from "../../src/sdk-key.ts";

const VALID = "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("isValidConfeatureKeyFormat", () => {
  test("accepts a well-formed v1 key", () => {
    expect(isValidConfeatureKeyFormat(VALID)).toBe(true);
  });

  test("rejects keys that don't carry the v1 prefix", () => {
    expect(isValidConfeatureKeyFormat("configcat-sdk-1-AAA-BBB")).toBe(false);
    expect(isValidConfeatureKeyFormat("")).toBe(false);
    expect(isValidConfeatureKeyFormat("garbage")).toBe(false);
  });

  test("rejects keys with the wrong segment length", () => {
    expect(isValidConfeatureKeyFormat("confeature-sdk-1-AAA-BBB")).toBe(false);
    expect(
      isValidConfeatureKeyFormat(
        // 31 chars after the prefix instead of 32.
        "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ),
    ).toBe(false);
  });

  // The one accept/reject list every SDK's validator is tested from (#802).
  const shapes = JSON.parse(
    readFileSync(
      new URL("../../../test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json", import.meta.url),
      "utf8",
    ),
  ) as {
    valid: Array<{ name: string; key: string }>;
    invalid: Array<{ name: string; key: string }>;
  };

  test.each(shapes.valid.map((c) => [c.name, c.key]))("accepts %s", (_name, key) => {
    expect(isValidConfeatureKeyFormat(key)).toBe(true);
  });

  test.each(shapes.invalid.map((c) => [c.name, c.key]))("rejects %s", (_name, key) => {
    expect(isValidConfeatureKeyFormat(key)).toBe(false);
  });

  test("regex export is the same shape we document in spec", () => {
    expect(CONFEATURE_SDK_KEY_PATTERN.test(VALID)).toBe(true);
  });
});

describe("redactSdkKey", () => {
  test("never returns the raw key", () => {
    const out = redactSdkKey(VALID);
    expect(out).not.toBe(VALID);
    expect(out).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  });

  test("redacted form retains a recognisable head + tail (≤ 20% of key visible at each end)", () => {
    const out = redactSdkKey(VALID);
    expect(out).toContain("[redacted]");
    // head + tail combined must NOT cover more than ~40% of the key length.
    const visible = out.replace("[redacted]", "").replace(/[…\s]/g, "");
    expect(visible.length).toBeLessThanOrEqual(Math.ceil(VALID.length * 0.4));
  });

  test("masks middle 60% — the central 60% of the key never appears verbatim", () => {
    const out = redactSdkKey(VALID);
    const middleStart = Math.floor(VALID.length * 0.2);
    const middleEnd = Math.floor(VALID.length * 0.8);
    const middleSlice = VALID.slice(middleStart, middleEnd);
    expect(out).not.toContain(middleSlice);
  });

  test("returns [redacted] for empty / non-string / too-short input", () => {
    expect(redactSdkKey("")).toBe("[redacted]");
    expect(redactSdkKey(null)).toBe("[redacted]");
    expect(redactSdkKey(undefined)).toBe("[redacted]");
    expect(redactSdkKey("short")).toBe("[redacted]");
  });
});
