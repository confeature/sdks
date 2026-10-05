// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import type { Seed } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

const seed: Seed = {
  schemaVersion: "1.0",
  keys: [
    {
      sdkKey: "demo-key",
      payload: { p: { s: "test-salt", u: "demo" }, f: { ENABLE: { v: { b: true }, t: 0 } }, s: [] },
      etag: '"v1-fresh"',
      lastModified: "Sat, 26 Sep 2026 10:00:00 GMT",
    },
  ],
};

describe("proxy forward to the upstream via Miniflare", () => {
  it("forwards /configuration-files/<key>/config_v6.json to the worker", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seed });
    try {
      const res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.f).toEqual({ ENABLE: { v: { b: true }, t: 0 } });
      // The real Worker's validators pass through the proxy unchanged (#785).
      expect(res.headers.get("etag")).toBe('"v1-fresh"');
      expect(res.headers.get("last-modified")).toBe("Sat, 26 Sep 2026 10:00:00 GMT");
      expect(res.headers.get("cache-control")).toBe("max-age=0, must-revalidate");
    } finally {
      await handle.stop();
    }
  });

  it("forwards the upstream's ConfigCat-parity 403 when the SDK key is not seeded (#785)", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seed });
    try {
      const res = await fetch(`${handle.url}/configuration-files/unknown-key/config_v6.json`);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toBe("application/xml");
    } finally {
      await handle.stop();
    }
  });
});
