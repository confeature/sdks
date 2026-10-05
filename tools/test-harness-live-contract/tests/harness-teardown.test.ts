// SPDX-License-Identifier: MIT

/**
 * settleTeardown and WranglerHost.clear — two places that used to swallow an
 * error and report success (plan 680 review). No harness boot.
 */

import { describe, expect, it } from "vitest";
import { failAfterCleanup, settleTeardown } from "../src/harness.js";
import { WranglerHost } from "../src/wrangler-host.js";

describe("settleTeardown", () => {
  it("resolves when every step succeeds", async () => {
    await expect(settleTeardown([Promise.resolve(1), Promise.resolve()], "x")).resolves.toBe(
      undefined,
    );
  });

  it("waits for every step, then reports every failure — none is swallowed", async () => {
    let lateStepRan = false;
    const late = new Promise<void>((resolve) =>
      setTimeout(() => {
        lateStepRan = true;
        resolve();
      }, 10),
    );
    const err = await settleTeardown(
      [Promise.reject(new Error("proxy close")), late, Promise.reject(new Error("dispose"))],
      "harness teardown failed",
    ).catch((e: unknown) => e);
    expect(lateStepRan).toBe(true);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toBe("harness teardown failed");
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "proxy close",
      "dispose",
    ]);
  });
});

describe("WranglerHost.clear", () => {
  it("fails loudly on an unreadable key listing instead of clearing nothing", async () => {
    // Before plan 680's review, unparseable `kv key list` output was treated
    // as an empty store: /admin/reset answered ok over stale keys.
    const host = new WranglerHost({ scriptPath: "unused", configPath: "/unused/wrangler.toml" });
    const internals = host as unknown as {
      persistDir: string;
      runWranglerKv: (args: string[]) => Promise<string | null>;
    };
    internals.persistDir = "/nonexistent";
    const calls: string[][] = [];
    internals.runWranglerKv = async (args) => {
      calls.push(args);
      return "⛅️ wrangler noise, not JSON";
    };
    await expect(host.clear()).rejects.toThrow(/unparseable output/);
    expect(calls).toEqual([["key", "list"]]); // nothing deleted on a guess
  });
});

describe("failAfterCleanup — a start failure after the host started", () => {
  it("rethrows the start error itself when cleanup succeeds", async () => {
    const start = new Error("proxy failed to bind");
    await expect(failAfterCleanup(start, [Promise.resolve()])).rejects.toBe(start);
  });

  it("reports both failures, start error first, when cleanup fails too", async () => {
    const start = new Error("boot seed failed");
    const err = await failAfterCleanup(start, [Promise.reject(new Error("dispose failed"))]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AggregateError);
    const [first, second] = (err as AggregateError).errors as [Error, AggregateError];
    expect(first).toBe(start);
    expect(second.errors.map((e: Error) => e.message)).toEqual(["dispose failed"]);
  });
});
