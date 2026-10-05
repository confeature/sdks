// SPDX-License-Identifier: MIT

/**
 * Every live suite runs through the harness wrapper (#783). A bare runner —
 * `vp test run …` with no wrapper — would run the suite without
 * `CONFEATURE_LIVE`, the suite would skip every test, exit 0, and the
 * conformance report would count the SDK as live-covered with nothing
 * asserted: the false green #783 removed. contract-live.yml and Dagger both
 * run these strings verbatim, so this is the one place to hold the line.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifestPath = pathResolve(
  fileURLToPath(import.meta.url),
  "../../../../dagger/sdk-manifest.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  sdks: Array<{ name: string; liveSuite?: { runner: string } }>;
};
const live = manifest.sdks.filter((s) => s.liveSuite !== undefined);
const WRAPPER = "node tools/test-harness-live-contract/dist/cli.js --corpus-seed --exec -- ";

describe("dagger/sdk-manifest.json live suites (#783)", () => {
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
});
