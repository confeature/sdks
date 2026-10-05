// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execAgainstHarness, runWithHarness } from "../src/exec-runner.js";
import { HarnessShutdownTimeout } from "../src/harness.js";

const node = process.execPath;

describe("runWithHarness — how a live suite is handed the harness (#783)", () => {
  it("exports CONFEATURE_LIVE=1 and LIVE_HARNESS_URL, and passes the exit code through", async () => {
    const code = await runWithHarness("http://127.0.0.1:1234", [
      node,
      "-e",
      `process.exit(process.env.CONFEATURE_LIVE === "1" && process.env.LIVE_HARNESS_URL === "http://127.0.0.1:1234" ? 3 : 9)`,
    ]);
    expect(code).toBe(3);
  });

  it("passes a success through as 0", async () => {
    expect(await runWithHarness("http://x", [node, "-e", "process.exit(0)"])).toBe(0);
  });

  it("a command killed by a signal is a failure (1), never a silent pass", async () => {
    expect(
      await runWithHarness("http://x", [node, "-e", "process.kill(process.pid, 'SIGKILL')"]),
    ).toBe(1);
  });

  it("a command that cannot start is a failure (1)", async () => {
    expect(await runWithHarness("http://x", ["/nonexistent/binary-783"])).toBe(1);
  });
});

describe("runWithHarness — an interrupted run is never a pass (#783 review)", () => {
  it("forwards a signal, and a child that handles it and exits 0 still fails (128 + n)", async () => {
    const signals = new EventEmitter();
    const ready = join(mkdtempSync(join(tmpdir(), "exec-783-")), "ready");
    const run = runWithHarness(
      "http://x",
      [
        node,
        "-e",
        // Handler first, then the ready file: once it exists, SIGTERM is handled.
        `process.on('SIGTERM', () => process.exit(0));
         require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');
         setInterval(() => {}, 1000);`,
      ],
      signals,
    );
    while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 10));
    signals.emit("SIGTERM");
    expect(await run).toBe(128 + constants.signals.SIGTERM);
    expect(signals.listenerCount("SIGTERM")).toBe(0); // handlers removed
  });
});

describe("execAgainstHarness — the CLI's exec-mode exit code (#783 review)", () => {
  const handle = (stop: () => Promise<void>) => ({ url: "http://127.0.0.1:1", stop });

  it("passes <cmd>'s code through and stops the harness", async () => {
    let stopped = false;
    const code = await execAgainstHarness(
      handle(async () => {
        stopped = true;
      }),
      [node, "-e", "process.exit(3)"],
    );
    expect(code).toBe(3);
    expect(stopped).toBe(true);
  });

  it("a teardown timeout after a passing <cmd> exits 137", async () => {
    const code = await execAgainstHarness(
      handle(() => Promise.reject(new HarnessShutdownTimeout(5))),
      [node, "-e", "process.exit(0)"],
    );
    expect(code).toBe(137);
  });

  it("any other teardown error turns a pass into 1, and keeps a failure's own code", async () => {
    const broken = handle(() => Promise.reject(new Error("boom")));
    expect(await execAgainstHarness(broken, [node, "-e", "process.exit(0)"])).toBe(1);
    expect(await execAgainstHarness(broken, [node, "-e", "process.exit(4)"])).toBe(4);
  });
});
