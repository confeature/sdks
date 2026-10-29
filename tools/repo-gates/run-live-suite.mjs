#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Run one SDK's live wire-cases: the one implementation that finds an SDK's
 * `liveSuite.runner` and runs it. Two callers run this script, and nothing
 * else runs a runner:
 *
 *   - Dagger's `live-suite --sdk <name>` (dagger/src/index.ts `liveSuite`),
 *     inside the SDK's live container at the repository root, for every SDK
 *     with a Dagger leg;
 *   - the `Run the live suite` step of sdk-gates.yml's macOS job, natively,
 *     for Swift, whose Apple toolchain no Dagger container has.
 *
 *   SDK=<name> node tools/repo-gates/run-live-suite.mjs
 *
 * Run from the checkout's root, after the workspace is installed and the
 * harness built. The command is the SDK's `liveSuite.runner` from
 * dagger/sdk-manifest.json, its one home: this script carries none of its
 * own. Whether a runner can run at all is select-sdks.mjs's manifestProblems,
 * asked here and never restated, so a runner `verify` refuses is refused on
 * both paths too. It runs from the repository root as `bash` with
 * `runnerArgv`, and its exit code is passed through.
 *
 * Fails closed: an SDK that is not a name, an SDK with no runner or one
 * manifestProblems refuses, or a manifest it cannot read is exit 2, never a
 * skip; a live step that exited 0 having run nothing would report a live
 * suite green.
 *
 * Zero dependencies, like the other repo-gates scripts.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";
import { hasLiveSuite, MANIFEST, manifestProblems, NAME } from "./select-sdks.mjs";

/** A live suite this script cannot run: exit 2. */
export class RunLiveError extends Error {}

/**
 * How bash is handed a runner: `-e` and `pipefail`, so a failing command
 * anywhere in it, piped or not, is the step's exit code, and `-u`, so a
 * misspelt variable is an error rather than an empty string.
 */
export function runnerArgv(runner) {
  return ["-euo", "pipefail", "-c", runner];
}

/**
 * The SDK's `liveSuite.runner`, or a RunLiveError saying why it cannot run.
 *
 * Refused on any manifestProblems finding about this SDK or about the whole
 * manifest (`"-"`), and only those: one broken entry stops its own live
 * suite, not every other SDK's. Findings are attributed by name, so a second
 * entry with this SDK's name ("listed twice") refuses it too.
 */
export function runnerFor(manifest, sdk) {
  if (typeof sdk !== "string" || !NAME.test(sdk))
    throw new RunLiveError(`${JSON.stringify(sdk ?? null)} is not an SDK name (${NAME.source})`);
  const problems = manifestProblems(manifest).filter((p) => p.sdk === sdk || p.sdk === "-");
  if (problems.length > 0)
    throw new RunLiveError(
      `${MANIFEST}: ${problems.map((p) => `${p.sdk === "-" ? "" : `${p.sdk} `}${p.why}`).join("; ")}`,
    );
  const entry = manifest.sdks.find((s) => s?.name === sdk);
  if (!hasLiveSuite(entry)) throw new RunLiveError(`${MANIFEST} has no ${sdk} liveSuite.runner`);
  return entry.liveSuite.runner;
}

function main() {
  const root = process.cwd();
  let runner;
  try {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
    } catch (e) {
      throw new RunLiveError(`${MANIFEST}: ${e?.message ?? e}`, { cause: e });
    }
    runner = runnerFor(manifest, process.env.SDK);
  } catch (e) {
    console.error(`run-live-suite: ${e?.message ?? e}`);
    return 2;
  }
  console.error(`run-live-suite: ${process.env.SDK}: ${runner}`);
  const r = spawnSync("bash", runnerArgv(runner), { cwd: root, stdio: "inherit" });
  if (r.error !== undefined) {
    console.error(`run-live-suite: bash did not start (${r.error.message})`);
    return 2;
  }
  // A runner killed by a signal has no status: red, never 0.
  return r.status ?? 1;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
