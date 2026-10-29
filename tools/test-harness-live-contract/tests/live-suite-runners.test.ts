// SPDX-License-Identifier: MIT

/**
 * Every live suite runs through the harness wrapper (#783). A bare runner —
 * `vp test run …` with no wrapper — would run the suite without
 * `CONFEATURE_LIVE`, the suite would skip every test, exit 0, and its leg
 * would pass with nothing asserted: the false green #783 removed. These
 * strings are run verbatim by tools/repo-gates/run-live-suite.mjs, the one
 * implementation, which Dagger's `live-suite --sdk <name>` runs in the live
 * container and the macOS job runs natively. select-sdks.mjs's
 * manifestProblems refuses the same on every verify (#793 review) and in that
 * script, and the wrapper itself fails a suite that asked the harness nothing.
 *
 * An SDK without a `liveSuite` carries a `liveExempt` reason (#918, plan 867
 * FR-016); the transitional "no live suite yet" state ended with #924. The
 * manifest's structure (a runner present, a liveSuite only where a Dagger leg
 * runs it, never beside a liveExempt, and the `liveSuite.toolchain` each
 * Dagger live suite's container is built from) is
 * tools/repo-gates/select-sdks.mjs's manifestProblems, checked on every
 * verify; it is not restated here. dagger/src/index.ts is read once, by a
 * negative guard: its `liveSuite` must hand the runner to that script and
 * hold no second way of running one.
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
// @ts-expect-error — plain .mjs repo-gates script, no type declarations
import { runnerArgv } from "../../repo-gates/run-live-suite.mjs";
// @ts-expect-error — plain .mjs repo-gates script, no type declarations
import { LIVE_WRAPPER } from "../../repo-gates/select-sdks.mjs";
// @ts-expect-error — plain .mjs repo-gates script, no type declarations
import { LIVE_SCRIPT } from "../../repo-gates/verify-workflows.mjs";
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
const WRAPPER = LIVE_WRAPPER as string;

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
 * boots the harness — the way run-live-suite.mjs runs a runner (its
 * `runnerArgv`, on both paths), in a sandbox laid out like the
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
    chmodSync(join(box, rel), 0o755); // a fake such as vendor/bin/phpunit is run directly
  }
  mkdirSync(join(box, "tmp"));
  mkdirSync(join(box, "cache"));
  const cmd = sdk
    .liveSuite!.runner.slice(WRAPPER.length)
    .replaceAll("/tmp/", `${box}/tmp/`)
    .replaceAll("/cache/", `${box}/cache/`);
  const r = spawnSync("bash", runnerArgv(cmd) as string[], {
    cwd: box,
    encoding: "utf-8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: box, STUB_OUTCOME: outcome },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The SDKs whose count check is not in their runner but in the suite itself:
 * their live suite is `defineLiveWireSuite()` (#925), which fails a run in
 * which any of its tests did not run, once for all three (#926 A2). That
 * check's own red run is packages/test-fixtures-sdk-parity's
 * live-wire-suite-count.test.ts.
 */
const COUNT_CHECKED_IN_HELPER = ["browser-js", "deno", "bun"];

describe("each runner's count check refuses a skipped case and an empty run (#926 A3)", () => {
  // MUTATION: drop an SDK's fake (or add a live SDK with no count check) and
  // this goes red: no live SDK is left trusting its test runner's exit code.
  it("every live SDK has a count check: in its runner, driven by a fake here, or in the shared helper", () => {
    const covered = [...Object.keys(RUNNER_COUNT_FAKES), ...COUNT_CHECKED_IN_HELPER].sort();
    expect(covered).toEqual(live.map((s) => s.name).sort());
  });

  it.each(
    live.filter((s) => COUNT_CHECKED_IN_HELPER.includes(s.name)).map((s) => [s.name, s] as const),
  )("%s's live suite is defineLiveWireSuite(), so the helper's count check is its", (_name, s) => {
    const src = readFileSync(pathResolve(repoRoot, s.liveSuite!.path!), "utf-8");
    expect(src).toMatch(/^await defineLiveWireSuite\(/m);
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

/**
 * Dagger's `liveSuite` runs no runner of its own: it hands the SDK to
 * tools/repo-gates/run-live-suite.mjs, the one implementation, and passes its
 * exit code through. dagger/src/index.ts cannot be imported outside the
 * engine, so this reads its text, as a negative guard: each finding names a
 * second way of finding or running a runner, or a softened exec that would let
 * the script's exit 2 (a refused runner) or a red suite pass. A new spelling
 * can dodge a text guard; the positive proof is every Dagger live leg in CI.
 * Comment lines are not code and are skipped.
 */
const DAGGER_MODULE = pathResolve(repoRoot, "dagger/src/index.ts");
const LIVE_SUITE_HEAD = /async liveSuite\([^)]*\)[^{]*\{/g;
const codeOf = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");

/** `liveSuite`'s body in `src`, brace-matched; it must be declared exactly once. */
function liveSuiteBody(src: string): string {
  const heads = [...src.matchAll(LIVE_SUITE_HEAD)];
  if (heads.length !== 1) throw new Error(`liveSuite is declared ${heads.length} times, not once`);
  const open = heads[0]!.index + heads[0]![0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("liveSuite's body never closes");
}

/** Every way `src`'s liveSuite departs from "run the one script, exit code passed through". */
function liveSuiteProblems(src: string): string[] {
  const out: string[] = [];
  const body = codeOf(liveSuiteBody(src));
  const execs = [...body.matchAll(/withExec\(\s*\[([^\]]*)\]/g)].map((m) => {
    try {
      return JSON.stringify(JSON.parse(`[${m[1]}]`));
    } catch {
      return m[1]!.trim(); // not literal strings: never the script's argv
    }
  });
  const script = JSON.stringify(["node", LIVE_SCRIPT]);
  if (execs.length === 0 || execs.some((argv) => argv !== script))
    out.push(`liveSuite execs something other than ${script}: ${execs.join(", ") || "nothing"}`);
  if (/\.runner\b/.test(codeOf(src))) out.push("dagger/src/index.ts reads a .runner");
  if (/pipefail/.test(body)) out.push("liveSuite hands bash a runner (-euo pipefail)");
  for (const [word, re] of [
    ["expect", /\bexpect\b/],
    ["ReturnType", /\bReturnType\b/],
    ["exitCode(", /\bexitCode\(/],
    ["catch", /\bcatch\b/],
  ] as const)
    if (re.test(body)) out.push(`liveSuite softens its exec: ${word}`);
  if (/\.test\(/.test(body)) out.push("liveSuite judges the SDK name itself");
  return out;
}

describe("Dagger's liveSuite runs run-live-suite.mjs and nothing else (FR-006)", () => {
  const src = readFileSync(DAGGER_MODULE, "utf-8");
  const inBody = (from: string, to: string) => (text: string) => {
    const body = liveSuiteBody(text);
    return text.replace(body, body.replace(from, to));
  };
  const SCRIPT_EXEC = `.withExec(["node", "${LIVE_SCRIPT as string}"])`;

  it("the real module has none of the findings, and execs exactly node LIVE_SCRIPT", () => {
    expect(liveSuiteProblems(src)).toEqual([]);
    expect(liveSuiteBody(src)).toContain(SCRIPT_EXEC);
  });

  // MUTATION M7, one row each: applied to a copy of the source, never committed.
  it.each([
    [
      "the script literal is not LIVE_SCRIPT",
      inBody(`"${LIVE_SCRIPT as string}"`, '"tools/repo-gates/run-live-suite.js"'),
      /execs something other than/,
    ],
    [
      "a runner lookup (.runner) anywhere in the module",
      (t: string) => t.replace("@object()", "const r = sdks[0]?.liveSuite?.runner;\n@object()"),
      /reads a \.runner/,
    ],
    [
      "a runner bash pipefail argv in liveSuite (any spelling)",
      inBody(".stdout()", '.withExec(["bash", "-eu", "-o", "pipefail", "-c", runner]).stdout()'),
      /hands bash a runner/,
    ],
    [
      "an exec with expect",
      inBody(SCRIPT_EXEC, SCRIPT_EXEC.replace("])", '], { expect: "ANY" })')),
      /softens its exec: expect$/,
    ],
    [
      "a ReturnType in liveSuite",
      inBody("const result", "void ReturnType;\n    const result"),
      /softens its exec: ReturnType$/,
    ],
    ["an exitCode() read", inBody(".stdout()", ".exitCode()"), /softens its exec: exitCode\($/],
    ["a catch", inBody(".stdout()", '.stdout().catch(() => "")'), /softens its exec: catch$/],
    [
      "an SDK-name check of its own",
      inBody(
        "const container",
        'if (!/^[a-z]+$/.test(sdk)) throw new Error("no");\n    const container',
      ),
      /judges the SDK name itself/,
    ],
  ])("refuses %s", (_what, mutate, re) => {
    const mutated = mutate(src);
    expect(mutated, "the mutation did not apply").not.toBe(src);
    expect(
      liveSuiteProblems(mutated).some((p) => re.test(p)),
      liveSuiteProblems(mutated).join("\n"),
    ).toBe(true);
  });

  it("refuses a module where liveSuite cannot be found", () =>
    expect(() => liveSuiteProblems(src.replace(LIVE_SUITE_HEAD, "async liveSuites() {"))).toThrow(
      /declared 0 times/,
    ));
});
