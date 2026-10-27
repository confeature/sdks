// SPDX-License-Identifier: MIT

/**
 * Every live suite runs through the harness wrapper (#783). A bare runner —
 * `vp test run …` with no wrapper — would run the suite without
 * `CONFEATURE_LIVE`, the suite would skip every test, exit 0, and its leg
 * would pass with nothing asserted: the false green #783 removed. Dagger's
 * `live-suite --sdk <name>` runs these strings verbatim (#918). select-sdks.mjs's
 * manifestProblems refuses the same on every verify (#793 review), and the
 * wrapper itself fails a suite that asked the harness nothing.
 *
 * An SDK without a `liveSuite` carries a `liveExempt` reason (#918, plan 867
 * FR-016); the transitional "no live suite yet" state ended with #924. The
 * manifest's structure (a runner present, a liveSuite only where a Dagger leg
 * runs it, never beside a liveExempt) is tools/repo-gates/select-sdks.mjs's
 * manifestProblems, checked on every verify; it is not restated here.
 *
 * A test runner exits 0 when it skips a case, so most runners read their own
 * report after the suite and refuse a run in which a case was skipped or none
 * ran. Each of those count checks is run here against a fake toolchain
 * (live-runner-fakes.ts), so deleting or weakening one goes red (#926 A3).
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs report script, no type declarations
import { buildReport } from "../scripts/live-coverage-report.mjs";
import { OUTCOMES, RUNNER_COUNT_FAKES, type Fake, type Outcome } from "./live-runner-fakes.js";

const repoRoot = pathResolve(fileURLToPath(import.meta.url), "../../../..");
const manifestPath = pathResolve(repoRoot, "dagger/sdk-manifest.json");
type Sdk = {
  name: string;
  liveSuite?: { runner: string; path?: string };
  liveExempt?: string;
  ci?: { native?: string };
};
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { sdks: Sdk[] };
const live = manifest.sdks.filter((s) => s.liveSuite !== undefined);
const WRAPPER = "node tools/test-harness-live-contract/dist/cli.js --corpus-seed --exec -- ";

/**
 * The keys of `LIVE_TOOLCHAINS` in dagger/src/index.ts, read from its source:
 * the Dagger module is not importable here (it needs the engine's SDK), and
 * without this an SDK given a `liveSuite` but no toolchain passes every local
 * check and is refused only once its leg runs `live-suite` in CI (#919).
 */
function liveToolchainKeys(): string[] {
  const src = readFileSync(pathResolve(repoRoot, "dagger/src/index.ts"), "utf-8");
  const body = /const LIVE_TOOLCHAINS\b.*=\s*\{\n([\s\S]*?)\n\};/.exec(src)?.[1];
  if (body === undefined) throw new Error("dagger/src/index.ts: LIVE_TOOLCHAINS not found");
  return [...body.matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]!);
}

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

  it.each(live.map((s) => [s.name, s.liveSuite!] as const))(
    "%s's liveSuite.path exists and is a file its runner runs",
    (_name, suite) => {
      expect(suite.path, "liveSuite.path").toBeTypeOf("string");
      expect(existsSync(pathResolve(repoRoot, suite.path!)), suite.path).toBe(true);
      const sdkDir = /^apps\/[^/]+\//.exec(suite.path!)?.[0] ?? "";
      expect(suite.runner).toContain(suite.path!.slice(sdkDir.length));
    },
  );

  it("every Linux SDK with a liveSuite has its toolchain in LIVE_TOOLCHAINS, and no other", () => {
    const linuxLive = live.filter((s) => s.ci?.native === undefined).map((s) => s.name);
    expect(liveToolchainKeys().sort()).toEqual(linuxLive.sort());
  });

  it.each(manifest.sdks.filter((s) => s.liveExempt !== undefined).map((s) => [s.name, s] as const))(
    "%s's liveExempt is a real reason",
    (_name, s) => {
      expect(s.liveExempt!.trim().length).toBeGreaterThan(40);
    },
  );

  // #924 ended the "no live suite yet" state, as T10 ended ci.pending: an SDK
  // is live or exempt with a stated reason, and a new SDK cannot land with
  // neither (MUTATION: delete one SDK's liveSuite and this goes red).
  it("every SDK has a liveSuite or a liveExempt reason: none is 'no live suite yet'", () => {
    const neither = manifest.sdks
      .filter((s) => s.liveSuite === undefined && s.liveExempt === undefined)
      .map((s) => s.name);
    expect(neither, "SDKs with neither a liveSuite nor a liveExempt").toEqual([]);
    const report = buildReport(manifest) as { pending: string[] };
    expect(report.pending).toEqual([]);
  });
});

/**
 * Run one live runner's `<cmd>` — the runner minus the wrapper, which only
 * boots the harness — the way Dagger's `live-suite` and run-live-suite.mjs
 * run a runner (`bash -euo pipefail -c`), in a sandbox laid out like the
 * repository, with `fake` standing in for the SDK's toolchain. The runner's
 * absolute scratch paths (`/tmp/…`, `/cache/…`) are moved into the sandbox so
 * nothing outside it is written; nothing else in the string is touched.
 */
function runWithFake(
  sdk: Sdk,
  fake: Fake,
  outcome: Outcome,
): { status: number | null; out: string } {
  const box = mkdtempSync(join(tmpdir(), `live-runner-${sdk.name}-`));
  const bin = join(box, ".fake-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fake.bins ?? {})) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const files = { [sdk.liveSuite!.path!]: "", ...fake.files };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(box, rel)), { recursive: true });
    writeFileSync(join(box, rel), body);
  }
  mkdirSync(join(box, "tmp"));
  mkdirSync(join(box, "cache"));
  const cmd = sdk
    .liveSuite!.runner.slice(WRAPPER.length)
    .replaceAll("/tmp/", `${box}/tmp/`)
    .replaceAll("/cache/", `${box}/cache/`);
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", cmd], {
    cwd: box,
    encoding: "utf-8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: box, STUB_OUTCOME: outcome },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The SDKs whose runner has no count check yet: their test runner's exit code
 * is all the leg reads (#926 A2).
 */
const NO_COUNT_CHECK_YET = [
  "node",
  "browser-js",
  "deno",
  "bun",
  "python",
  "go",
  "php",
  "ruby",
  "rust",
];

describe("each runner's count check refuses a skipped case and an empty run (#926 A3)", () => {
  it("every live SDK's runner count check is driven by a fake here, or is listed as missing", () => {
    const covered = [...Object.keys(RUNNER_COUNT_FAKES), ...NO_COUNT_CHECK_YET].sort();
    expect(covered).toEqual(live.map((s) => s.name).sort());
  });

  // MUTATION: delete one SDK's count check from its runner in
  // dagger/sdk-manifest.json (the trailing grep of its report) and its `skip`
  // and `none` rows go green, so these go red.
  const rows = live
    .filter((s) => s.name in RUNNER_COUNT_FAKES)
    .flatMap((s) => OUTCOMES.map((o) => [s.name, o, s] as const));
  it.each(rows)("%s, %s", (_name, outcome, sdk) => {
    const { status, out } = runWithFake(sdk, RUNNER_COUNT_FAKES[sdk.name]!, outcome);
    if (outcome === "pass") expect(status, out).toBe(0);
    else expect(status, `${outcome} passed:\n${out}`).not.toBe(0);
  });
});
