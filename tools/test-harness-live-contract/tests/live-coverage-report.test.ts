// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs report script, no type declarations
import { buildReport } from "../scripts/live-coverage-report.mjs";

type Row = { sdk: string; live: string; result: string };

/**
 * The live-suite coverage of the roster (#918, plan 867 FR-016), read from
 * the manifest's `liveSuite` and `liveExempt` only — never from `status`,
 * which says how an SDK is PUBLISHED, not whether it meets the origin. Since
 * contract-live.yml retired, a live suite's pass or fail is its leg's result
 * in sdk-gates.yml; this report says which SDKs have one at all.
 */

const manifest = {
  sdks: [
    { name: "node", status: "covered", liveSuite: { runner: "x", path: "y" } },
    { name: "python", status: "covered", liveSuite: { runner: "x", path: "y" } },
    { name: "go", status: "covered" }, // neither → no live suite yet
    { name: "swift", status: "exempt" }, // exempt from PUBLISHING only → no live suite yet
    { name: "unreal", status: "exempt", liveExempt: "no Unreal Engine on hosted runners" },
  ],
};

describe("buildReport (live-coverage-report)", () => {
  it("counts an SDK as live-covered only when it has a liveSuite.runner", () => {
    const r = buildReport(manifest);
    expect(r.total).toBe(5);
    expect(r.covered).toBe(2);
    expect(r.exempt).toBe(1);
    expect(r.pending).toEqual(["go", "swift"]);
    expect(r.headline).toBe(
      "Live suites — 2/5 SDKs run one on every push, 1 exempt, 2 with no live suite yet",
    );
  });

  it("an SDK with neither liveSuite nor liveExempt is 'no live suite yet', never covered", () => {
    const r = buildReport(manifest);
    for (const sdk of ["go", "swift"]) {
      const row = r.rows.find((x: Row) => x.sdk === sdk);
      expect(row?.live).toBe("no");
      expect(row?.result).toMatch(/no live suite yet/);
    }
  });

  it("exemption is read from liveExempt, with its reason — never from status", () => {
    const r = buildReport(manifest);
    expect(r.rows.find((x: Row) => x.sdk === "unreal")?.result).toBe(
      "exempt: no Unreal Engine on hosted runners",
    );
    expect(r.rows.find((x: Row) => x.sdk === "swift")?.result).not.toMatch(/exempt/);
  });

  it("a liveSuite with no runner is not coverage", () => {
    const r = buildReport({ sdks: [{ name: "x", liveSuite: { path: "y" } }] });
    expect(r.covered).toBe(0);
    expect(r.pending).toEqual(["x"]);
  });

  it("the real manifest: every SDK is covered, exempt or counted as no live suite yet", () => {
    const real = JSON.parse(
      readFileSync(
        pathResolve(fileURLToPath(import.meta.url), "../../../../dagger/sdk-manifest.json"),
        "utf-8",
      ),
    ) as { sdks: unknown[] };
    const r = buildReport(real);
    expect(r.covered + r.exempt + r.pending.length).toBe(real.sdks.length);
    expect(r.covered).toBeGreaterThan(0);
  });
});
