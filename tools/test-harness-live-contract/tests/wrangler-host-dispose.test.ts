// SPDX-License-Identifier: MIT

/**
 * WranglerHost.dispose() must let a failed temp-dir removal through to
 * settleTeardown (plan 680 review round 2): it used to `.catch(() => {})` it,
 * so stop() reported a clean exit over a leaked directory.
 *
 * A file of its own: it mocks `rm` from node:fs/promises for the whole module.
 * A permission trick (chmod) would not work where the suite runs as root.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: vi.fn(async () => {
      throw new Error("EBUSY: resource busy, rmdir '/tmp/lc-harness-x'");
    }),
  };
});

const { WranglerHost } = await import("../src/wrangler-host.js");

describe("WranglerHost.dispose", () => {
  it("rejects when the persist dir cannot be removed — the error is not swallowed", async () => {
    const host = new WranglerHost({ scriptPath: "unused", configPath: "/unused/wrangler.toml" });
    (host as unknown as { persistDir: string }).persistDir = "/tmp/lc-harness-x";
    await expect(host.dispose()).rejects.toThrow(/EBUSY/);
    // The host no longer claims the directory, whatever the outcome.
    expect((host as unknown as { persistDir: string }).persistDir).toBe("");
  });

  it("reports both leaks when the worker fails to stop AND the dir fails to go", async () => {
    const host = new WranglerHost({ scriptPath: "unused", configPath: "/unused/wrangler.toml" });
    const internals = host as unknown as { persistDir: string; worker: unknown };
    internals.persistDir = "/tmp/lc-harness-x";
    internals.worker = {
      stop: async () => {
        throw new Error("worker stop failed");
      },
    };
    const err = await host.dispose().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "worker stop failed",
      "EBUSY: resource busy, rmdir '/tmp/lc-harness-x'",
    ]);
  });
});
