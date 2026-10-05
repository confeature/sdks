// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs report script, no type declarations
import { buildReport } from "../scripts/live-coverage-report.mjs";

type Row = { sdk: string; live: string; result: string };

/**
 * #150 / spec 115 — burn-down report logic (data-model §3, FR-004).
 * Pure unit test of buildReport so the classification + headline are covered
 * without a full CI matrix run.
 */

const manifest = {
  sdks: [
    { name: "node", status: "covered", liveSuite: { runner: "x", path: "y" } },
    { name: "python", status: "covered", liveSuite: { runner: "x", path: "y" } },
    { name: "go", status: "covered" }, // no liveSuite → pending
    { name: "swift", status: "exempt" },
    { name: "unreal", status: "exempt" },
  ],
};

describe("buildReport (live-coverage-report)", () => {
  it("counts only passing live SDKs as covered; pending/exempt excluded", () => {
    const results = new Map([
      ["node", { sdk: "node", status: "pass" }],
      ["python", { sdk: "python", status: "pass" }],
    ]);
    const r = buildReport(manifest, results);
    expect(r.total).toBe(5);
    expect(r.covered).toBe(2);
    expect(r.headline).toBe("Live contract conformance — 2/5 live-covered");
    expect(r.failed).toEqual([]);
    expect(r.rows.find((x: Row) => x.sdk === "go")?.result).toMatch(/pending/);
    expect(r.rows.find((x: Row) => x.sdk === "swift")?.result).toBe("exempt");
  });

  it("a live SDK with a failing result is reported fail and listed in failed[]", () => {
    const results = new Map([
      ["node", { sdk: "node", status: "pass" }],
      ["python", { sdk: "python", status: "fail" }],
    ]);
    const r = buildReport(manifest, results);
    expect(r.covered).toBe(1);
    expect(r.failed).toEqual(["python"]);
    expect(r.rows.find((x: Row) => x.sdk === "python")?.result).toMatch(/fail/);
  });

  it("a live SDK with a MISSING result is treated as fail (no false-green)", () => {
    const results = new Map(); // node has liveSuite but no result artifact
    const r = buildReport(manifest, results);
    expect(r.covered).toBe(0);
    // node + python both have liveSuite but no result → both fail
    expect(r.failed.sort()).toEqual(["node", "python"]);
    // go (no liveSuite) stays pending, never fail
    expect(r.rows.find((x: Row) => x.sdk === "go")?.result).toMatch(/pending/);
  });

  it("pending-only roster never fails the run (covered=0, failed=[])", () => {
    const pendingManifest = {
      sdks: [
        { name: "go", status: "covered" },
        { name: "unreal", status: "exempt" },
      ],
    };
    const r = buildReport(pendingManifest, new Map());
    expect(r.covered).toBe(0);
    expect(r.failed).toEqual([]); // no liveSuite anywhere → nothing to fail
  });
});
