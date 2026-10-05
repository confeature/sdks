// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants } from "node:os";
import { HarnessShutdownTimeout } from "./harness.js";
import type { HarnessHandle } from "./types.js";

const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Run <cmd> with the harness handed to it the one agreed way (#783, decision
 * row 3): `CONFEATURE_LIVE=1` and `LIVE_HARNESS_URL` in its environment.
 * Resolves to its exit code; a command that could not start, or that died on
 * a signal, resolves to 1 — a live suite can never pass by not running.
 *
 * Signals received meanwhile (from `signals`, the process by default) are
 * forwarded to it. A run that was interrupted is never a pass: if <cmd>
 * handles the signal and exits 0 anyway, the result is 128 + the signal
 * number, the shell's convention for "stopped by a signal".
 */
export function runWithHarness(
  harnessUrl: string,
  cmd: readonly string[],
  signals: EventEmitter = process,
): Promise<number> {
  const [bin, ...rest] = cmd;
  if (bin === undefined) return Promise.resolve(1);
  const child = spawn(bin, rest, {
    stdio: "inherit",
    env: { ...process.env, CONFEATURE_LIVE: "1", LIVE_HARNESS_URL: harnessUrl },
  });
  let interrupted: (typeof FORWARDED)[number] | undefined;
  const handlers = FORWARDED.map(
    (s) =>
      [
        s,
        () => {
          interrupted ??= s;
          child.kill(s);
        },
      ] as const,
  );
  for (const [s, h] of handlers) signals.on(s, h);
  return new Promise<number>((resolve) => {
    const done = (code: number): void => {
      for (const [s, h] of handlers) signals.off(s, h);
      resolve(code === 0 && interrupted ? 128 + constants.signals[interrupted] : code);
    };
    child.once("error", (err) => {
      process.stderr.write(`--exec: could not start ${bin}: ${err.message}\n`);
      done(1);
    });
    child.once("exit", (exitCode, signal) => done(signal !== null ? 1 : (exitCode ?? 1)));
  });
}

/**
 * Exec mode end to end, minus the boot: run <cmd> against the ready harness,
 * stop the harness, and resolve to the code the CLI exits with — <cmd>'s own,
 * except that a failed teardown is never a pass (a timeout is 137, the CLI's
 * documented teardown code; any other stop error turns 0 into 1).
 */
export async function execAgainstHarness(
  handle: Pick<HarnessHandle, "url" | "stop">,
  cmd: readonly string[],
  signals: EventEmitter = process,
): Promise<number> {
  const code = await runWithHarness(handle.url, cmd, signals);
  try {
    await handle.stop();
  } catch (err) {
    process.stderr.write(`shutdown error: ${(err as Error).message}\n`);
    if (err instanceof HarnessShutdownTimeout) return 137;
    return code === 0 ? 1 : code;
  }
  return code;
}
