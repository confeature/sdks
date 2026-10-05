// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import type { Seed } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

const seedA: Seed = {
  schemaVersion: "1.0",
  keys: [
    {
      sdkKey: "demo-key",
      payload: { p: { s: "A" }, f: { ENABLE: { v: { b: true }, t: 0 } }, s: [] },
    },
  ],
};

const seedB: Seed = {
  schemaVersion: "1.0",
  keys: [
    {
      sdkKey: "demo-key",
      payload: { p: { s: "B" }, f: { ENABLE: { v: { b: false }, t: 0 } }, s: [] },
    },
  ],
};

describe("POST /admin/reset", () => {
  it("drops existing KV state and replays the supplied seed", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seedA });
    try {
      // Initial fetch sees seed A.
      let res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(200);
      let body = (await res.json()) as Record<string, unknown>;
      expect(body.p).toEqual({ s: "A" });

      // Reset with seed B.
      res = await fetch(`${handle.url}/admin/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: seedB }),
      });
      expect(res.status).toBe(200);
      const resetResult = (await res.json()) as { ok: boolean; seededKeys: number };
      expect(resetResult.ok).toBe(true);
      expect(resetResult.seededKeys).toBe(1);

      // Subsequent fetch sees seed B.
      res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(200);
      body = (await res.json()) as Record<string, unknown>;
      expect(body.p).toEqual({ s: "B" });
    } finally {
      await handle.stop();
    }
  });

  it("rejects seedFile path-traversal outside cwd / harness seeds dir", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seedA });
    try {
      const res = await fetch(`${handle.url}/admin/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seedFile: "/etc/passwd" }),
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { ok: boolean; error: string };
      expect(err.ok).toBe(false);
      expect(err.error).toMatch(/must be under cwd/i);
    } finally {
      await handle.stop();
    }
  });

  it("rejects malformed seeds with 400 + clear pointer", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seedA });
    try {
      const res = await fetch(`${handle.url}/admin/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: { schemaVersion: "0.9", keys: [] } }),
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { ok: boolean; error: string };
      expect(err.ok).toBe(false);
      expect(err.error).toBeTruthy();
    } finally {
      await handle.stop();
    }
  });
});
