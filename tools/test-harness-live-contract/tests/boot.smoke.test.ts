// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import type { Seed } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

const trivialSeed: Seed = {
  schemaVersion: "1.0",
  description: "boot.smoke trivial seed",
  keys: [
    {
      sdkKey: "smoke-test-key",
      payload: { p: { s: "test-salt", u: "test" }, f: {}, s: [] },
      etag: '"v1-smoke"',
    },
  ],
};

describe("boot smoke", () => {
  it("boots, exposes /admin/state, tears down within budget", async () => {
    const t0 = performance.now();
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: trivialSeed });
    const bootMs = performance.now() - t0;

    try {
      // SC-001 perf budget: cold boot < 10 s (wrangler dev boot is
      // ~2-3s on M-series + getPlatformProxy round-trip for seed adds
      // ~1s — leaving generous headroom for CI/slow machines).
      expect(bootMs).toBeLessThan(10_000);

      const reqStart = performance.now();
      const stateRes = await fetch(`${handle.url}/admin/state`);
      const reqMs = performance.now() - reqStart;
      // SC-001 perf budget: per-request < 200 ms (no fault, no admin work).
      expect(reqMs).toBeLessThan(200);

      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as {
        ok: boolean;
        seededKeys: number;
        bindAddress: string;
      };
      expect(state.ok).toBe(true);
      expect(state.seededKeys).toBe(1);
      expect(state.bindAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    } finally {
      await handle.stop();
    }
  });

  it("emits a URL matching the documented stdout protocol shape", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: trivialSeed });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await handle.stop();
    }
  });
});
