// SPDX-License-Identifier: MIT

/**
 * The fault state over real HTTP (plan 680): run-time injection of the new
 * faults (US3), the admin caller guard (US4), and reset replacing the fault
 * state (FR-004).
 *
 * Its own file on purpose: vitest runs files in parallel forks, and a harness
 * boot inside admin-reset.test.ts would sit on the suite's critical path —
 * paid twice per pre-push (SC-003). One boot is shared by every test here, so
 * the tests run in order and the reset scenario, which replaces the whole
 * state, comes last.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import type { HarnessHandle, Seed } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

const payload = (s: string) => ({ p: { s }, f: { ENABLE: { v: { b: true }, t: 0 } }, s: [] });

const seedA: Seed = {
  schemaVersion: "1.0",
  keys: [
    { sdkKey: "demo-key", payload: payload("A") },
    { sdkKey: "inject-key", payload: payload("I") },
    { sdkKey: "etag-key", payload: payload("E"), etag: '"e1"' },
    { sdkKey: "hold-key", payload: payload("H") },
  ],
};

let harness: HarnessHandle;
const url = (key: string) => `${harness.url}/configuration-files/${key}/config_v6.json`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${harness.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  harness = await startHarness({ cdnEntry, cdnConfigPath, initialSeed: seedA });
});

afterAll(async () => {
  await harness?.stop();
});

describe("POST /admin/inject-fault — the new faults at run time (US3)", () => {
  it("serves an injected status fault exactly as declared", async () => {
    const res = await post("/admin/inject-fault", {
      sdkKey: "inject-key",
      fault: { kind: "status", status: 403, headers: { "Content-Type": "text/plain" } },
    });
    expect(res.status).toBe(200);
    const served = await fetch(url("inject-key"));
    expect(served.status).toBe(403);
    expect(served.headers.get("etag")).toBeNull();
    expect(await served.text()).toBe("");
  });

  it("serves an injected close-mid-response as a transport failure", async () => {
    await post("/admin/inject-fault", { sdkKey: "inject-key", fault: "close-mid-response" });
    const served = await fetch(url("inject-key"));
    expect(served.status).toBe(200);
    await expect(served.arrayBuffer()).rejects.toThrow();
  });

  it("refuses to cut a body that has none — a 304 from the upstream answers 500 naming the fault", async () => {
    // truncationPlan's refusal branch: the upstream 304 has a 0-byte body, so
    // there is no strict non-empty prefix to send. Never a silent full reply.
    await post("/admin/inject-fault", { sdkKey: "etag-key", fault: "close-mid-response" });
    const served = await fetch(url("etag-key"), { headers: { "if-none-match": '"e1"' } });
    expect(served.status).toBe(500);
    expect(await served.text()).toMatch(/close-mid-response needs an upstream body/);
    await post("/admin/inject-fault", { sdkKey: "etag-key", fault: "none" });
  });

  it("rejects an invalid status fault with the existing error shape", async () => {
    const res = await post("/admin/inject-fault", {
      sdkKey: "inject-key",
      fault: { kind: "status", status: 200, headers: { "Content-Type": "text/html" }, body: "<b>" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^fault/);
  });
});

describe("admin caller guard over the wire (US4)", () => {
  const browser = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
  const stateOf = async () => (await (await fetch(`${harness.url}/admin/state`)).json()) as unknown;

  // Every admin route, not only one: the guard sits in route(), and each row
  // below fails if any route can be reached around it.
  it.each([
    ["POST", "/admin/inject-fault", { sdkKey: "demo-key", fault: "5xx" }],
    ["POST", "/admin/seed", { keys: [{ sdkKey: "demo-key", payload: null, fault: "404" }] }],
    [
      "POST",
      "/admin/reset",
      { seed: { schemaVersion: "1.0", keys: [{ sdkKey: "x", payload: null }] } },
    ],
    ["GET", "/admin/state", undefined],
    ["GET", "/admin/requests?sdkKey=demo-key", undefined],
    ["GET", "/admin/does-not-exist", undefined],
  ] as const)("%s %s from a browser → 403, state untouched", async (method, path, body) => {
    const before = await stateOf();
    const res = await fetch(`${harness.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...browser },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(403);
    expect(await stateOf()).toEqual(before);
    expect((await fetch(url("demo-key"))).status).toBe(200);
  });
});

describe("POST /admin/seed — merges into the fault state (FR-004)", () => {
  it("keeps other keys' faults, applies a carried fault, and 'none' clears it", async () => {
    await post("/admin/inject-fault", { sdkKey: "demo-key", fault: "5xx" });

    await post("/admin/seed", {
      keys: [
        {
          sdkKey: "seed-key",
          payload: null,
          fault: { kind: "status", status: 429, headers: { "Retry-After": "30" } },
        },
      ],
    });
    expect((await fetch(url("demo-key"))).status).toBe(503); // kept
    const seeded = await fetch(url("seed-key"));
    expect(seeded.status).toBe(429); // applied
    expect(seeded.headers.get("retry-after")).toBe("30");

    await post("/admin/seed", { keys: [{ sdkKey: "seed-key", payload: null, fault: "none" }] });
    // cleared: seed-key has no payload and no fault now — the upstream's own miss,
    // which answers ConfigCat's 403 since #785
    expect((await fetch(url("seed-key"))).status).toBe(403);
    expect((await fetch(url("demo-key"))).status).toBe(503); // still kept

    await post("/admin/inject-fault", { sdkKey: "demo-key", fault: "none" });
  });
});

describe("the harness reports its case set and the requests it served (#783)", () => {
  it("GET /admin/state lists the seeded keys", async () => {
    const state = (await (await fetch(`${harness.url}/admin/state`)).json()) as { keys: string[] };
    // Exactly the seeded keys: `seed-key` was seeded then removed above, and a
    // stale key surviving its removal would be a case served that no longer exists.
    expect(state.keys).toEqual(["demo-key", "etag-key", "hold-key", "inject-key"]);
  });

  it("GET /admin/requests returns each config request, with its If-None-Match", async () => {
    await fetch(url("etag-key"), { headers: { "if-none-match": '"e1"' } });
    await fetch(`${url("etag-key")}?sdk=probe-783`);
    const body = (await (await fetch(`${harness.url}/admin/requests?sdkKey=etag-key`)).json()) as {
      ok: boolean;
      requests: Array<{ url: string; ifNoneMatch: string | null }>;
    };
    expect(body.ok).toBe(true);
    expect(body.requests.slice(-2)).toEqual([
      { url: "/configuration-files/etag-key/config_v6.json", ifNoneMatch: '"e1"' },
      { url: "/configuration-files/etag-key/config_v6.json?sdk=probe-783", ifNoneMatch: null },
    ]);
  });

  it("GET /admin/requests for a key never requested is an empty log", async () => {
    const body = (await (await fetch(`${harness.url}/admin/requests?sdkKey=never-783`)).json()) as {
      requests: unknown[];
    };
    expect(body.requests).toEqual([]);
  });

  it("GET /admin/requests without a key is refused", async () => {
    expect((await fetch(`${harness.url}/admin/requests`)).status).toBe(400);
  });

  // Moved here from the sdk-node live suite (#783 FR-008): a harness property,
  // not an SDK one. Repeated aborted timeouts must release every held socket —
  // a leaking proxy would wedge its single port and the recovery fetch below
  // could not succeed.
  it("repeated aborted timeouts release their sockets — the origin recovers", async () => {
    await post("/admin/inject-fault", {
      sdkKey: "hold-key",
      fault: { kind: "timeout", ms: 30_000 },
    });
    for (let i = 0; i < 5; i++) {
      await expect(fetch(url("hold-key"), { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    }
    await post("/admin/inject-fault", { sdkKey: "hold-key", fault: "none" });
    const recovered = await fetch(url("hold-key"), { signal: AbortSignal.timeout(5_000) });
    expect(recovered.status).toBe(200);
  });
});

describe("POST /admin/reset — fault state (FR-004)", () => {
  it("replaces the fault state: injected faults go, the seed's own faults apply", async () => {
    await post("/admin/inject-fault", { sdkKey: "demo-key", fault: "5xx" });
    expect((await fetch(url("demo-key"))).status).toBe(503);

    const res = await post("/admin/reset", {
      seed: {
        schemaVersion: "1.0",
        keys: [
          { sdkKey: "demo-key", payload: payload("B") },
          { sdkKey: "faulty-key", payload: null, fault: "404" },
        ],
      },
    });
    expect(res.status).toBe(200);
    // A replacing reset also empties the request log.
    const log = (await (await fetch(`${harness.url}/admin/requests?sdkKey=etag-key`)).json()) as {
      requests: unknown[];
    };
    expect(log.requests).toEqual([]);
    // ...and the reported case set is the new seed's, nothing carried over.
    const state = (await (await fetch(`${harness.url}/admin/state`)).json()) as { keys: string[] };
    expect(state.keys).toEqual(["demo-key", "faulty-key"]);

    // The faults injected before the reset did not survive it...
    expect((await fetch(url("demo-key"))).status).toBe(200);
    // inject-key carried close-mid-response before the reset. After it, the
    // key is absent from KV and unfaulted: the upstream's own miss, delivered whole.
    const unfaulted = await fetch(url("inject-key"));
    expect(unfaulted.status).toBe(403); // the upstream's own miss (#785), not a fault
    expect(await unfaulted.text()).toContain("<Code>AccessDenied</Code>");
    // ...and the fault the seed carries is served — the canned 404 body,
    // not the upstream's own KV miss.
    const faulty = await fetch(url("faulty-key"));
    expect(faulty.status).toBe(404);
    expect(await faulty.text()).toBe('{"error": "unknown sdk key"}');
  });
});
