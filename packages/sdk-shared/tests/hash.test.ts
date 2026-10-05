// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { hashComparisonValue, percentageBucket, sha1, sha256 } from "../src/hash.ts";

/**
 * Known-answer + ConfigCat-derived vectors for the vendored pure-JS hashes
 * (research.md §R2). These are load-bearing: a single wrong byte mis-buckets
 * every percentage case (SHA-1) or mis-matches every sensitive comparator
 * (SHA-256), so we pin canonical FIPS-180 vectors AND a vector reverse-derived
 * from the vendored ConfigCat sensitive corpus.
 */
describe("sha1 — canonical FIPS-180 known-answer vectors", () => {
  const vectors: [input: string, expected: string][] = [
    ["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
    ["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
    ["The quick brown fox jumps over the lazy dog", "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"],
    // Multi-block (> 55 bytes forces a second padding block).
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    ],
  ];
  for (const [input, expected] of vectors) {
    it(`sha1(${JSON.stringify(input)})`, () => {
      expect(sha1(input)).toBe(expected);
    });
  }
});

describe("sha256 — canonical FIPS-180 known-answer vectors", () => {
  const vectors: [input: string, expected: string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    // UTF-8 multi-byte input must hash the bytes, not the code points.
    ["héllo", "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179"],
  ];
  for (const [input, expected] of vectors) {
    it(`sha256(${JSON.stringify(input)})`, () => {
      expect(sha256(input)).toBe(expected);
    });
  }
});

describe("hashComparisonValue — ConfigCat-derived salted vector", () => {
  // Reverse-derived from the vendored sensitive matrix config
  // (configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/-0YmVOUNgEGKkgRF-rU65g, setting
  // `isOneOfSensitive`): hashing the Identifier "Kutya" with that config's
  // top-level salt and the setting key as contextSalt produces the exact
  // hashed list entry stored in the config. This pins the salted scheme
  // (value · configSalt · contextSalt, UTF-8, lowercase hex) byte-for-byte
  // against real ConfigCat output.
  const CONFIG_SALT = "d/5B2fVBt+oPIpGNKO9/jKLHLl+mowGFdgrf462ar4k=";

  it("matches the vendored config's stored hash for Identifier 'Kutya'", () => {
    expect(hashComparisonValue("Kutya", CONFIG_SALT, "isOneOfSensitive")).toBe(
      "eddfd5563a084e8b3c859da8d17150bc6c6156d5d54ed75406fb621f09193748",
    );
  });

  it("is order-sensitive (value · configSalt · contextSalt, no separators)", () => {
    expect(hashComparisonValue("Kutya", CONFIG_SALT, "isOneOfSensitive")).toBe(
      sha256("Kutya" + CONFIG_SALT + "isOneOfSensitive"),
    );
  });
});

describe("percentageBucket — SHA-1 unsalted, parseInt(hex[0..7],16) % 100", () => {
  it("computes the documented bucket formula", () => {
    const key = "feature";
    const attr = "alice@example.com";
    const expected = parseInt(sha1(key + attr).substring(0, 7), 16) % 100;
    expect(percentageBucket(key, attr)).toBe(expected);
  });

  it("returns an integer in [0, 99]", () => {
    for (const id of ["a", "bob", "12345", "user@example.com", ""]) {
      const bucket = percentageBucket("someFlag", id);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(99);
    }
  });

  it("is deterministic — same input, same bucket", () => {
    expect(percentageBucket("flag", "stable-user")).toBe(percentageBucket("flag", "stable-user"));
  });
});
