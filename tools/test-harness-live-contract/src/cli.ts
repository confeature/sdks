#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * live-contract-harness — CLI entry point.
 *
 * stdout protocol (serve mode): exactly one line
 * `LIVE_HARNESS_URL=http://127.0.0.1:<port>` followed by newline, emitted once
 * the harness is ready. All other output goes to stderr.
 *
 * `--exec -- <cmd…>` (#783): the one way a live SDK suite is booted and handed
 * the harness — the manifest runner Dagger's `live-suite --sdk <name>` runs (#918).
 * The harness boots in THIS process, then <cmd> runs with
 * `CONFEATURE_LIVE=1` and `LIVE_HARNESS_URL` exported; its exit code becomes
 * ours (a command killed by a signal exits 1 — never a silent pass), and the
 * harness is stopped either way. The URL line goes to stderr so <cmd> owns
 * stdout.
 *
 * Exit codes:
 *   0   — clean shutdown via signal (serve mode) / <cmd> exited 0 (exec mode)
 *   1   — boot failure (printed on stderr), <cmd> died on a signal, or a
 *         teardown error after <cmd> exited 0
 *   2   — bad CLI arguments
 *   137 — graceful teardown exceeded --shutdown-grace
 *   128+n — (exec mode) interrupted by signal n while <cmd> exited 0 anyway
 *   n   — (exec mode) <cmd>'s own exit code
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { BadArgs, parseArgs, USAGE, type ParsedArgs } from "./cli-args.js";
import { buildCorpusSeed } from "./corpus-seed.js";
import { execAgainstHarness } from "./exec-runner.js";
import { HarnessShutdownTimeout, startHarness } from "./harness.js";
import { SeedSchema } from "./seed-schema.js";
import { resolveUpstream, type Upstream } from "./upstream.js";
import type { HarnessConfig, HarnessHandle, Seed } from "./types.js";

async function loadSeedFromPath(path: string): Promise<Seed> {
  const resolved = isAbsolute(path) ? path : pathResolve(process.cwd(), path);
  const raw = await readFile(resolved, "utf-8");
  const parsed = JSON.parse(raw);
  const result = SeedSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const pointer = first?.path.join("/") ?? "";
    throw new Error(`seed validation failed at ${pointer}: ${first?.message}`);
  }
  return result.data;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof BadArgs) {
      process.stderr.write(`${err.message}\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }

  if (args.showHelp) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.showVersion) {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    process.exit(0);
  }

  let initialSeed: Seed | undefined;
  if (args.corpusSeed) {
    try {
      initialSeed = buildCorpusSeed();
    } catch (err) {
      process.stderr.write(`corpus seed failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  } else if (args.seed) {
    try {
      initialSeed = await loadSeedFromPath(args.seed);
    } catch (err) {
      process.stderr.write(`seed load failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  // The reference origin by default; the private CDN Worker only through CDN_ENTRY + CDN_CONFIG (#861).
  let upstream: Upstream;
  try {
    upstream = resolveUpstream();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }

  const config: HarnessConfig = {
    ...upstream,
    bindAddress: args.bind,
    bindPort: args.port,
    shutdownGrace: args.shutdownGrace,
  };
  if (initialSeed !== undefined) config.initialSeed = initialSeed;

  let handle: HarnessHandle;
  try {
    handle = await startHarness(config);
  } catch (err) {
    process.stderr.write(`harness boot failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (args.exec) {
    await runExec(handle, args.exec);
    return;
  }

  // Single stdout line — the deterministic signal.
  process.stdout.write(`LIVE_HARNESS_URL=${handle.url}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`received ${signal}, shutting down…\n`);
    try {
      await handle.stop();
      process.exit(0);
    } catch (err) {
      if (err instanceof HarnessShutdownTimeout) {
        process.stderr.write(`${err.message}\n`);
        process.exit(137);
      }
      process.stderr.write(`shutdown error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
}

/**
 * Exec mode: run <cmd> against the ready harness, then stop it and exit with
 * <cmd>'s code (see src/exec-runner.ts).
 */
async function runExec(handle: HarnessHandle, cmd: string[]): Promise<void> {
  process.stderr.write(`LIVE_HARNESS_URL=${handle.url}\n`);
  process.exit(await execAgainstHarness(handle, cmd));
}

void main();
