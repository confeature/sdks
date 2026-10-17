// SPDX-License-Identifier: MIT

/**
 * Every live suite runs through the harness wrapper (#783). A bare runner —
 * `vp test run …` with no wrapper — would run the suite without
 * `CONFEATURE_LIVE`, the suite would skip every test, exit 0, and its leg
 * would pass with nothing asserted: the false green #783 removed. Dagger's
 * `live-suite --sdk <name>` runs these strings verbatim (#918), so this is the
 * one place to hold the line.
 *
 * An SDK without a `liveSuite` is accepted in two forms only (#918, plan 867
 * FR-016): it carries a `liveExempt` reason, or it is "no live suite yet",
 * which live-coverage-report.mjs counts and lists, never as covered. The
 * manifest's structure (a runner present, a liveSuite only where a Dagger leg
 * runs it, never beside a liveExempt) is tools/repo-gates/select-sdks.mjs's
 * manifestProblems, checked on every verify; it is not restated here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs report script, no type declarations
import { buildReport } from "../scripts/live-coverage-report.mjs";

const manifestPath = pathResolve(
  fileURLToPath(import.meta.url),
  "../../../../dagger/sdk-manifest.json",
);
type Sdk = { name: string; liveSuite?: { runner: string }; liveExempt?: string };
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { sdks: Sdk[] };
const live = manifest.sdks.filter((s) => s.liveSuite !== undefined);
const WRAPPER = "node tools/test-harness-live-contract/dist/cli.js --corpus-seed --exec -- ";

describe("dagger/sdk-manifest.json live suites (#783, #918)", () => {
  it("declares at least one live suite", () => {
    expect(live.length).toBeGreaterThan(0);
  });

  it.each(live.map((s) => [s.name, s.liveSuite!.runner] as const))(
    "%s runs through the harness wrapper",
    (_name, runner) => {
      expect(runner.startsWith(WRAPPER)).toBe(true);
      expect(runner.slice(WRAPPER.length).trim()).not.toBe("");
    },
  );

  it.each(manifest.sdks.filter((s) => s.liveExempt !== undefined).map((s) => [s.name, s] as const))(
    "%s's liveExempt is a real reason",
    (_name, s) => {
      expect(s.liveExempt!.trim().length).toBeGreaterThan(40);
    },
  );

  it("an SDK with no liveSuite is exempt with a reason, or counted as no live suite yet", () => {
    const without = manifest.sdks.filter((s) => s.liveSuite === undefined);
    const report = buildReport(manifest) as { pending: string[] };
    for (const s of without) {
      if (s.liveExempt !== undefined) continue;
      expect(report.pending, `${s.name} has neither and is not reported as a gap`).toContain(
        s.name,
      );
    }
  });
});
