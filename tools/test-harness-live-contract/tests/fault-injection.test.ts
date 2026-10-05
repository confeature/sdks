// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import type { Seed } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

const baseSeed: Seed = {
  schemaVersion: "1.0",
  keys: [
    {
      sdkKey: "demo-key",
      payload: { p: { s: "test" }, f: {}, s: [] },
    },
  ],
};

describe("fault injection at the proxy layer", () => {
  it("returns 503 for fault=5xx", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: baseSeed });
    try {
      // Attach 5xx fault.
      let res = await fetch(`${handle.url}/admin/inject-fault`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey: "demo-key", fault: "5xx" }),
      });
      expect(res.status).toBe(200);

      res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(503);
    } finally {
      await handle.stop();
    }
  });

  it("substitutes malformed JSON body for fault=malformed-json", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: baseSeed });
    try {
      await fetch(`${handle.url}/admin/inject-fault`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey: "demo-key", fault: "malformed-json" }),
      });

      const res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // The canned literal is the corpus's malformed-json-200 response,
      // byte for byte (plan 680 FR-005) — invalid JSON, with its ETag.
      expect(body).toBe("{not valid json");
      expect(res.headers.get("etag")).toBe('"garbage"');
      expect(() => JSON.parse(body)).toThrow();
    } finally {
      await handle.stop();
    }
  });

  it("returns 404 for fault=404 regardless of payload existence", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: baseSeed });
    try {
      await fetch(`${handle.url}/admin/inject-fault`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey: "demo-key", fault: "404" }),
      });
      const res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(404);
    } finally {
      await handle.stop();
    }
  });

  it("clears fault on POST { fault: 'none' }, returning the upstream's real response", async () => {
    const handle = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: baseSeed });
    try {
      await fetch(`${handle.url}/admin/inject-fault`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey: "demo-key", fault: "5xx" }),
      });
      let res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(503);

      await fetch(`${handle.url}/admin/inject-fault`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdkKey: "demo-key", fault: "none" }),
      });
      res = await fetch(`${handle.url}/configuration-files/demo-key/config_v6.json`);
      expect(res.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });
});
