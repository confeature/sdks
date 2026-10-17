// SPDX-License-Identifier: MIT

/**
 * run-live-suite.mjs (#924): the macOS job's live step. It runs an SDK's
 * manifest `liveSuite.runner` exactly as Dagger's `live-suite` does (from the
 * repository root, under `bash -euo pipefail`), passes its exit code through,
 * and refuses, red, anything it cannot run: a live step that exits 0 having
 * run nothing would report a live suite green.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runnerFor, RunLiveError } from "./run-live-suite.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run-live-suite.mjs");
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A checkout holding only dagger/sdk-manifest.json with these SDKs. */
function checkout(sdks) {
  const root = mkdtempSync(join(tmpdir(), "run-live-"));
  dirs.push(root);
  mkdirSync(join(root, "dagger"));
  writeFileSync(join(root, "dagger", "sdk-manifest.json"), JSON.stringify({ sdks }));
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
      { name: "swift", liveSuite: { runner: "echo live" } },
      { name: "plain" },
      { name: "empty", liveSuite: { runner: " " } },
    ],
  };
  it("returns the SDK's runner", () => expect(runnerFor(manifest, "swift")).toBe("echo live"));
  it.each([
    ["an SDK with no liveSuite", "plain", /has no [a-z]* liveSuite\.runner/],
    ["an empty runner", "empty", /has no [a-z]* liveSuite\.runner/],
    ["an SDK the manifest does not list", "ghost", /has no [a-z]* liveSuite\.runner/],
    ["a name that is not an SDK name", "a b; id", /not an SDK name/],
    ["no name at all", undefined, /not an SDK name/],
  ])("refuses %s", (_what, sdk, re) => {
    expect(() => runnerFor(manifest, sdk)).toThrow(RunLiveError);
    expect(() => runnerFor(manifest, sdk)).toThrow(re);
  });
});

describe("the script", () => {
  it("runs the runner from the checkout's root and exits 0 when it does", () => {
    const root = checkout([{ name: "swift", liveSuite: { runner: "pwd > ran.txt" } }]);
    const r = run(root, { SDK: "swift" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(root, "ran.txt"), "utf8").trim()).toBe(realpathSync(root));
  });

  it("passes the runner's own exit code through", () => {
    const root = checkout([{ name: "swift", liveSuite: { runner: "exit 7" } }]);
    expect(run(root, { SDK: "swift" }).status).toBe(7);
  });

  // MUTATION: drop pipefail (or -e) and both of these exit 0.
  it("runs under pipefail and errexit, as Dagger's live-suite does", () => {
    const pipe = checkout([{ name: "swift", liveSuite: { runner: "false | cat" } }]);
    expect(run(pipe, { SDK: "swift" }).status).not.toBe(0);
    const errexit = checkout([{ name: "swift", liveSuite: { runner: "false; true" } }]);
    expect(run(errexit, { SDK: "swift" }).status).not.toBe(0);
  });

  it.each([
    ["no SDK", {}],
    ["an SDK with no runner", { SDK: "plain" }],
  ])("is red (exit 2) on %s, never a skip", (_what, env) => {
    const root = checkout([{ name: "plain" }]);
    const r = run(root, env);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/run-live-suite:/);
  });

  it("is red (exit 2) when the manifest does not parse", () => {
    const root = checkout([]);
    writeFileSync(join(root, "dagger", "sdk-manifest.json"), "{");
    expect(run(root, { SDK: "swift" }).status).toBe(2);
  });
});
