// SPDX-License-Identifier: MIT

/**
 * applySeed (plan 680, decision row 9) against a stub host — no Miniflare.
 * Pins the three modes and the ordering guarantee: KV is written before the
 * fault map is swapped, so a failed write changes nothing that is served.
 */

import { describe, expect, it } from "vitest";
import { AdminState } from "../src/admin-routes.js";
import { applySeed } from "../src/seed-applier.js";
import type { SeededKey } from "../src/types.js";

function stubHost(opts: { failSeed?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    host: {
      clear: async (): Promise<void> => {
        calls.push("clear");
      },
      seed: async (keys: SeededKey[]): Promise<void> => {
        calls.push(`seed:${keys.length}`);
        if (opts.failSeed) throw new Error("KV down");
      },
    },
  };
}

const key = (sdkKey: string, fault?: SeededKey["fault"]): SeededKey =>
  fault === undefined ? { sdkKey, payload: {} } : { sdkKey, payload: {}, fault };

describe("applySeed", () => {
  it("boot writes KV without clearing, and applies the seed's faults", async () => {
    const { host, calls } = stubHost();
    const state = new AdminState();
    await applySeed({ host, state }, [key("a", "5xx"), key("b")], "boot");
    expect(calls).toEqual(["seed:2"]);
    expect(Object.fromEntries(state.faults)).toEqual({ a: "5xx" });
    expect(state.seededKeys).toBe(2);
  });

  it("replace clears KV and drops faults injected before it", async () => {
    const { host, calls } = stubHost();
    const state = new AdminState();
    state.setFault("injected", "404");
    await applySeed({ host, state }, [key("a", "close-mid-response")], "replace");
    expect(calls).toEqual(["clear", "seed:1"]);
    expect(Object.fromEntries(state.faults)).toEqual({ a: "close-mid-response" });
    expect(state.seededKeys).toBe(1);
  });

  it("merge keeps other faults, sets carried ones, and 'none' clears", async () => {
    const { host, calls } = stubHost();
    const state = new AdminState();
    state.setFault("keep", "404");
    state.setFault("clear-me", "5xx");
    state.seededKeys = 3;
    await applySeed(
      { host, state },
      [key("new", "wrong-shape"), key("clear-me", "none"), key("keep")],
      "merge",
    );
    expect(Object.fromEntries(state.faults)).toEqual({ keep: "404", new: "wrong-shape" });
    expect(state.seededKeys).toBe(6);
    // Additive: no clear, so KV keys outside this call survive the merge.
    expect(calls).toEqual(["seed:3"]);
  });

  it("a failed KV write leaves the fault map and the count untouched", async () => {
    const { host } = stubHost({ failSeed: true });
    const state = new AdminState();
    state.setFault("live", "5xx");
    state.seededKeys = 1;
    await expect(applySeed({ host, state }, [key("a", "404")], "replace")).rejects.toThrow(
      "KV down",
    );
    expect(Object.fromEntries(state.faults)).toEqual({ live: "5xx" });
    expect(state.seededKeys).toBe(1);
  });
});
