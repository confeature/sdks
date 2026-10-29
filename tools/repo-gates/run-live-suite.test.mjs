// SPDX-License-Identifier: MIT

/**
 * run-live-suite.mjs: the one implementation that finds and runs an SDK's
 * manifest `liveSuite.runner`. Dagger's `live-suite --sdk` runs it inside the
 * live container and the macOS job runs it natively, so what these rows
 * refuse is refused on both paths. It runs the runner from the repository
 * root as `bash` under its runnerArgv, passes its exit code through, and
 * refuses, red, anything it cannot run: a live step that exits 0 having run
 * nothing would report a live suite green. Whether a runner can run at all is
 * select-sdks.mjs's manifestProblems, asked here, never restated.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runnerArgv, runnerFor, RunLiveError } from "./run-live-suite.mjs";
import { LIVE_WRAPPER } from "./select-sdks.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run-live-suite.mjs");
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A runner of the one shape manifestProblems accepts: the harness wrapper, then `cmd`. */
const wrapped = (cmd) => `${LIVE_WRAPPER}${cmd}`;
/** A native live SDK, as the manifest writes Swift. */
const swift = (runner) => ({ name: "swift", ci: { native: "macos" }, liveSuite: { runner } });

/**
 * Stands in for the harness wrapper's `--exec`: runs what follows `--` from
 * its own working directory and passes its exit code through. The real
 * wrapper boots the harness first, which these rows do not need.
 */
const FAKE_WRAPPER = [
  'const { spawnSync } = require("node:child_process");',
  'const [cmd, ...args] = process.argv.slice(process.argv.indexOf("--") + 1);',
  'const r = spawnSync(cmd, args, { stdio: "inherit" });',
  "process.exit(r.status ?? 1);",
].join("\n");

/** A checkout holding dagger/sdk-manifest.json with these SDKs, and the fake wrapper where the runner names it. */
function checkout(sdks) {
  const root = mkdtempSync(join(tmpdir(), "run-live-"));
  dirs.push(root);
  mkdirSync(join(root, "dagger"));
  writeFileSync(join(root, "dagger", "sdk-manifest.json"), JSON.stringify({ sdks }));
  const cli = LIVE_WRAPPER.split(" ")[1];
  mkdirSync(join(root, dirname(cli)), { recursive: true });
  // No package.json above the tmpdir sandbox, so the `.js` the runner names is CommonJS.
  writeFileSync(join(root, cli), FAKE_WRAPPER);
  return root;
}
const run = (root, env) =>
  spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

describe("runnerFor", () => {
  const manifest = {
    sdks: [
      swift(wrapped("echo live")),
      { name: "plain", daggerFn: "plain-test" },
      // MUTATION M5: give runnerFor back its own check, minus manifestProblems,
      // and a runner made only of spaces is run.
      { name: "blank", ci: { native: "macos" }, liveSuite: { runner: "   " } },
      // MUTATION M6: delete the manifestProblems call and these two run: the
      // first skips every case and passes, the second's `|| true` is green
      // whatever the suite did.
      { name: "bare", ci: { native: "macos" }, liveSuite: { runner: "echo live" } },
      { name: "ortrue", ci: { native: "macos" }, liveSuite: { runner: wrapped("cmd || true") } },
    ],
  };
  it("returns the SDK's runner", () =>
    expect(runnerFor(manifest, "swift")).toBe(wrapped("echo live")));
  it.each([
    ["a runner made only of whitespace (M5)", "blank", /blank liveSuite\.runner is not a command/],
    [
      "a runner that skips the harness wrapper (M6)",
      "bare",
      /bare liveSuite\.runner does not run a command through the harness wrapper/,
    ],
    [
      "a runner with `|| true` after the wrapped command (M6)",
      "ortrue",
      /ortrue liveSuite\.runner has a shell operator .*\|\|/,
    ],
    ["an SDK with no liveSuite", "plain", /has no plain liveSuite\.runner/],
    ["an SDK the manifest does not list", "ghost", /has no ghost liveSuite\.runner/],
    ["a name that is not an SDK name", "a b; id", /not an SDK name/],
    ["no name at all", undefined, /not an SDK name/],
  ])("refuses %s", (_what, sdk, re) => {
    expect(() => runnerFor(manifest, sdk)).toThrow(RunLiveError);
    expect(() => runnerFor(manifest, sdk)).toThrow(re);
  });

  // MUTATION: refuse on every problem, not only the named SDK's, and one
  // broken entry stops every other SDK's live suite.
  it("runs an SDK whose own entry is sound when another SDK's entry is not", () =>
    expect(runnerFor(manifest, "swift")).toBe(wrapped("echo live")));

  // MUTATION: attribute findings by anything but the SDK's name and a second
  // entry under the same name is run, whichever of the two is found first.
  it("refuses an SDK the manifest lists twice", () => {
    const twice = { sdks: [swift(wrapped("echo live")), swift(wrapped("echo other"))] };
    expect(() => runnerFor(twice, "swift")).toThrow(RunLiveError);
    expect(() => runnerFor(twice, "swift")).toThrow(/swift is listed twice/);
  });

  // MUTATION: drop the `"-"` scope and a manifest whose sdks[] is not a list
  // is read anyway (a TypeError, not a refusal).
  it.each([
    ["sdks[] is not a list", { sdks: { swift: swift(wrapped("echo live")) } }],
    ["sdks[] is missing", {}],
  ])("refuses every SDK when the whole manifest is refused (%s)", (_what, m) => {
    expect(() => runnerFor(m, "swift")).toThrow(RunLiveError);
    expect(() => runnerFor(m, "swift")).toThrow(/the manifest has no sdks\[\]/);
  });
});

describe("runnerArgv, how bash is handed a runner", () => {
  // MUTATION: drop, add or reorder any flag and this goes red. The runner is
  // one argument: `cmd with spaces` is not split.
  it("is exactly bash -euo pipefail -c <runner>", () => {
    expect(runnerArgv("cmd with spaces")).toHaveLength(4);
    expect(runnerArgv("cmd with spaces").join("|")).toBe("-euo|pipefail|-c|cmd with spaces");
  });

  // MUTATION: drop pipefail (or -e) and these exit 0.
  it.each([
    ["a failing command before a pipe (pipefail)", "false | cat"],
    ["a failing command followed by another (errexit)", "false; true"],
  ])("is red on %s", (_what, runner) =>
    expect(spawnSync("bash", runnerArgv(runner)).status).not.toBe(0),
  );
});

describe("the script", () => {
  it("runs the runner from the checkout's root and exits 0 when it does", () => {
    const root = checkout([swift(wrapped("bash -c 'pwd > ran.txt'"))]);
    const r = run(root, { SDK: "swift" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(root, "ran.txt"), "utf8").trim()).toBe(realpathSync(root));
  });

  // MUTATION: return r.status as it is and a runner killed by a signal is null, read as 0.
  // `$$` is the bash the script started (or the wrapper bash exec'd into): either way the process the script waits on dies by a signal.
  it("a runner killed by a signal is red (1)", () => {
    const root = checkout([swift(wrapped("kill -9 $$"))]);
    expect(run(root, { SDK: "swift" }).status).toBe(1);
  });

  it("passes the runner's own exit code through", () => {
    const root = checkout([swift(wrapped("bash -c 'exit 7'"))]);
    expect(run(root, { SDK: "swift" }).status).toBe(7);
  });

  // MUTATION: spawn bash with anything but runnerArgv and this exits 0. A
  // runner manifestProblems accepts is one simple command, so `-u` is the flag
  // that shows through the script; runnerArgv's own rows hold the rest.
  // The status is bash's 1 with its own message, so a refusal (2) cannot pass for it.
  it("runs the runner with runnerArgv: an unset variable is red", () => {
    const root = checkout([swift(wrapped("bash -c 'touch ran.txt' $RUN_LIVE_TEST_UNSET"))]);
    const r = run(root, { SDK: "swift" });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/RUN_LIVE_TEST_UNSET: unbound variable/);
    expect(() => readFileSync(join(root, "ran.txt"))).toThrow();
  });

  it.each([
    ["no SDK", {}],
    ["an SDK with no runner", { SDK: "plain" }],
    ["a runner manifestProblems refuses", { SDK: "bare" }],
  ])("is red (exit 2) on %s, never a skip, and runs nothing", (_what, env) => {
    const root = checkout([
      { name: "plain", daggerFn: "plain-test" },
      { name: "bare", ci: { native: "macos" }, liveSuite: { runner: "touch ran.txt" } },
    ]);
    const r = run(root, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/run-live-suite:/);
    expect(() => readFileSync(join(root, "ran.txt"))).toThrow();
  });

  it("is red (exit 2) when the manifest does not parse", () => {
    const root = checkout([]);
    writeFileSync(join(root, "dagger", "sdk-manifest.json"), "{");
    expect(run(root, { SDK: "swift" }).status).toBe(2);
  });
});
