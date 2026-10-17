#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Run one SDK's live wire-cases natively: the `Run the live suite` step of
 * sdk-gates.yml's macOS job (#924), the job that runs Swift, whose Apple
 * toolchain no Dagger container has.
 *
 *   SDK=swift node tools/repo-gates/run-live-suite.mjs
 *
 * Run from the checkout's root, after the workspace is installed and the
 * harness built. The command is the SDK's `liveSuite.runner` from
 * dagger/sdk-manifest.json, its one home (plan 867 §5): this script carries
 * none of its own, and runs it exactly as Dagger's `live-suite --sdk` does,
 * from the repository root under `bash -euo pipefail`, so the same runner
 * string means the same thing in both. Its exit code is passed through.
 *
 * Fails closed: an SDK that is not a name, an SDK with no runner, or a
 * manifest it cannot read is exit 2, never a skip; a live step that exited 0
 * having run nothing would report a live suite green.
 *
 * Zero dependencies, like the other repo-gates scripts.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntry } from "../lib/is-entry.mjs";
import { MANIFEST, NAME } from "./select-sdks.mjs";

/** A live suite this script cannot run: exit 2. */
export class RunLiveError extends Error {}

/** The SDK's `liveSuite.runner`, or a RunLiveError saying why there is none. */
export function runnerFor(manifest, sdk) {
  if (typeof sdk !== "string" || !NAME.test(sdk))
    throw new RunLiveError(`${JSON.stringify(sdk ?? null)} is not an SDK name (${NAME.source})`);
  const runner = (manifest?.sdks ?? []).find((s) => s?.name === sdk)?.liveSuite?.runner;
  if (typeof runner !== "string" || runner.trim() === "")
    throw new RunLiveError(`${MANIFEST} has no ${sdk} liveSuite.runner`);
  return runner;
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
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", runner], { cwd: root, stdio: "inherit" });
  if (r.error !== undefined) {
    console.error(`run-live-suite: bash did not start (${r.error.message})`);
    return 2;
  }
  // A runner killed by a signal has no status: red, never 0.
  return r.status ?? 1;
}

if (isEntry(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = main();
