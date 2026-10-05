// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { AdminState, MAX_REQUESTS_PER_KEY } from "../src/admin-routes.js";

const req = (n: number) => ({ url: `/r/${n}`, ifNoneMatch: null });

describe("the request log behind GET /admin/requests (#783)", () => {
  it("keeps the most recent requests of a key, bounded per key", () => {
    const state = new AdminState();
    state.keys.add("k");
    for (let i = 0; i < MAX_REQUESTS_PER_KEY + 5; i++) state.recordRequest("k", req(i));
    const log = state.requests.get("k")!;
    expect(log).toHaveLength(MAX_REQUESTS_PER_KEY);
    expect(log[0]).toEqual(req(5));
    expect(log.at(-1)).toEqual(req(MAX_REQUESTS_PER_KEY + 4));
  });

  it("does not log an unseeded key — the log is bounded by the seed, not by callers", () => {
    const state = new AdminState();
    state.recordRequest("never-seeded", req(0));
    expect(state.requests.size).toBe(0);
  });
});
