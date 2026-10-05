// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { parseSemVer } from "../src/semver.ts";

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

function cmp(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemVer(a);
  const vb = parseSemVer(b);
  if (!va || !vb) throw new Error(`unparseable in cmp: ${a} / ${b}`);
  return sign(va.compare(vb));
}

describe("parseSemVer — strict grammar, null on failure (never throws)", () => {
  it("parses well-formed core versions", () => {
    const v = parseSemVer("1.2.3");
    expect(v).not.toBeNull();
    expect([v?.major, v?.minor, v?.patch]).toEqual([1, 2, 3]);
  });

  it("parses on trim", () => {
    expect(parseSemVer("  1.2.3  ")?.version).toBe("1.2.3");
  });

  it("accepts an optional leading 'v'", () => {
    expect(parseSemVer("v2.0.0")?.version).toBe("2.0.0");
  });

  it("captures pre-release and ignores build metadata for the canonical form", () => {
    const v = parseSemVer("1.0.0-alpha.1+build.7");
    expect(v?.version).toBe("1.0.0-alpha.1");
    expect(v?.prerelease).toEqual(["alpha", 1]);
    expect(v?.build).toEqual(["build", "7"]);
  });

  it.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "1.2.x",
    "01.2.3", // leading zero in a core identifier
    "1.2.3-", // empty pre-release
    "not-a-version",
    "1.2.-3",
  ])("returns null (not a throw) for unparseable %j", (bad) => {
    expect(() => parseSemVer(bad)).not.toThrow();
    expect(parseSemVer(bad)).toBeNull();
  });
});

describe("SemVer.compare — core precedence", () => {
  it("orders by major, then minor, then patch numerically", () => {
    expect(cmp("1.0.0", "2.0.0")).toBe(-1);
    expect(cmp("2.1.0", "2.0.9")).toBe(1);
    expect(cmp("1.2.10", "1.2.9")).toBe(1); // numeric, not lexical
    expect(cmp("1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores build metadata for precedence", () => {
    expect(cmp("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(cmp("1.0.0+anything", "1.0.0")).toBe(0);
  });
});

describe("SemVer.compare — pre-release precedence (SemVer §11)", () => {
  it("a release outranks a pre-release of the same core", () => {
    expect(cmp("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(cmp("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("numeric identifiers compare numerically; more fields outrank fewer", () => {
    // The canonical SemVer §11 precedence chain.
    expect(cmp("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(cmp("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(cmp("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1);
    expect(cmp("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
    expect(cmp("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1); // numeric, not lexical
    expect(cmp("1.0.0-beta.11", "1.0.0-rc.1")).toBe(-1);
    expect(cmp("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  it("a numeric identifier is lower-precedence than an alphanumeric one", () => {
    expect(cmp("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(cmp("1.0.0-10", "1.0.0-1a")).toBe(-1); // numeric < alphanumeric
  });
});

describe("SemVer.compare — vendored testmatrix_semantic_2 precedence chain", () => {
  // Exact rows from packages/test-fixtures-sdk-parity/fixtures/upstream/
  // testmatrix_semantic_2.csv — ConfigCat's own precedence oracle.
  const chain: [a: string, op: "<" | "=", b: string][] = [
    ["1.9.1-1", "<", "1.9.1-2"],
    ["1.9.1-2", "<", "1.9.1-10"],
    ["1.9.1-10", "<", "1.9.1-10a"],
    ["1.9.1-10a", "<", "1.9.1-1a"],
    ["1.9.1-1a", "<", "1.9.1-alpha"],
    ["1.9.1-alpha", "<", "1.9.99-alpha"],
    ["1.9.99-alpha", "=", "1.9.99-alpha"],
  ];
  for (const [a, op, b] of chain) {
    it(`${a} ${op} ${b}`, () => {
      expect(cmp(a, b)).toBe(op === "<" ? -1 : 0);
      if (op === "<") expect(cmp(b, a)).toBe(1); // antisymmetry
    });
  }
});
