// SPDX-License-Identifier: MIT

/**
 * defineLiveWireSuite() fails a run in which any of its tests did not run
 * (#926 A2). vitest exits 0 when it skips a test (a `-t` filter, a `.skip`,
 * a `ctx.skip()`), so without the check a live suite of browser-js, bun or
 * deno that ran one case and skipped the rest was green on exit code alone.
 *
 * The suite is run for real, by a child vitest, against a fake harness
 * served from here: `GET /admin/state` names two corpus cases, `GET
 * /admin/requests` lists nothing.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["etag-rotation", "fresh-fetch-200"];

let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/admin/state") res.end(JSON.stringify({ keys: KEYS, faults: {} }));
    else if (req.url?.startsWith("/admin/requests"))
      res.end(JSON.stringify({ ok: true, requests: [] }));
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The fixture run's exit code and output; async, so this process keeps serving the fake harness. */
function runFixture(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(pkg, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "tests/live-suite-fixture/vitest.config.ts",
        ...args,
      ],
      {
        cwd: pkg,
        env: {
          ...process.env,
          CONFEATURE_LIVE: "1",
          LIVE_HARNESS_URL: url,
          FIXTURE_KEYS: KEYS.join(","),
          CI: "true",
        },
      },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, out }));
  });
}

describe("defineLiveWireSuite() refuses a run that skipped a test (#926 A2)", () => {
  it("is green when every test ran", async () => {
    const { code, out } = await runFixture();
    expect(code, out).toBe(0);
  }, 60_000);

  // MUTATION: drop failUnlessEveryTestRan() from defineLiveWireSuite and this
  // run is green: one case skipped, exit 0.
  it("is red, naming the case, when one case was skipped", async () => {
    const { code, out } = await runFixture("-t", "^(?!.*fresh-fetch-200)");
    expect(code, out).not.toBe(0);
    expect(out).toContain("fresh-fetch-200");
  }, 60_000);
});
