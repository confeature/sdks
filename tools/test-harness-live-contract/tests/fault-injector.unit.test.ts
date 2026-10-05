// SPDX-License-Identifier: MIT

/**
 * Pure unit tests of fault-injector.ts (plan 680, decision rows 4-6). No
 * harness boot: these pin what each fault puts in the Response and where a
 * cut happens. The wire-level proof is tests/seed-fidelity.test.ts.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultWireCasesPath } from "../src/corpus-mapper.js";
import { CANNED_FAULTS, applyFault, truncationPlan } from "../src/fault-injector.js";

type ServerBlock = { status: number; headers?: Record<string, string>; body?: string };
const corpus = JSON.parse(readFileSync(defaultWireCasesPath(), "utf-8")) as {
  cases: Array<{ id: string; server: ServerBlock }>;
};
const serverOf = (id: string): ServerBlock => {
  const c = corpus.cases.find((x) => x.id === id);
  if (!c) throw new Error(`corpus has no case ${id}`);
  return c.server;
};

const upstream = (): Response =>
  new Response('{"p":1}', {
    status: 200,
    headers: { "content-type": "application/json", etag: '"upstream"', "x-upstream": "leak" },
  });

describe("CANNED_FAULTS — each literal IS its corpus case", () => {
  // Read from wire-cases.json at test time, never copied: a corpus edit that
  // is not mirrored here fails this test instead of drifting silently.
  it.each([
    ["5xx", "server-5xx-failure"],
    ["404", "invalid-sdk-key-404"],
    ["malformed-json", "malformed-json-200"],
    ["wrong-shape", "wrong-shape-200"],
  ] as const)("%s equals wire-cases.json#%s", (literal, caseId) => {
    const { kind: _kind, ...fault } = CANNED_FAULTS[literal];
    expect(fault).toEqual(serverOf(caseId));
  });
});

describe("applyFault — status faults", () => {
  it("serves exactly the declared headers — nothing from upstream survives", async () => {
    const r = applyFault(upstream(), {
      kind: "status",
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    });
    expect(r.kind).toBe("response");
    if (r.kind !== "response") return;
    expect(r.response.status).toBe(429);
    expect(r.response.headers.get("retry-after")).toBe("30");
    expect(r.response.headers.get("etag")).toBeNull();
    expect(r.response.headers.get("x-upstream")).toBeNull();
    expect(await r.response.text()).toBe("");
  });

  it("builds a 304 with a null body instead of throwing", () => {
    // new Response("", { status: 304 }) throws — the builder must pass null.
    const r = applyFault(upstream(), {
      kind: "status",
      status: 304,
      headers: { "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    expect(r.kind).toBe("response");
    if (r.kind !== "response") return;
    expect(r.response.status).toBe(304);
    expect(r.response.body).toBeNull();
    expect(r.response.headers.get("etag")).toBeNull();
  });

  it("serves a canned literal through the same builder", async () => {
    const r = applyFault(upstream(), "5xx");
    if (r.kind !== "response") throw new Error("expected a response");
    expect(r.response.status).toBe(503);
    expect(await r.response.text()).toBe("service unavailable");
    expect(r.response.headers.get("x-upstream")).toBeNull();
  });
});

describe("applyFault — socket-level markers", () => {
  it("close-mid-response returns the truncate marker carrying the upstream", () => {
    const up = upstream();
    const r = applyFault(up, "close-mid-response");
    expect(r).toEqual({ kind: "truncate", upstream: up });
  });

  it("no fault forwards upstream untouched", () => {
    const up = upstream();
    expect(applyFault(up, undefined)).toEqual({ kind: "response", response: up });
    expect(applyFault(up, "none")).toEqual({ kind: "response", response: up });
  });
});

describe("truncationPlan — where a cut happens", () => {
  it.each([0, 1])("refuses a %i-byte body (no strict non-empty prefix)", (n) => {
    expect(truncationPlan(n).kind).toBe("refuse");
  });

  it.each([
    [2, 1],
    [3, 1],
    [1000, 500],
  ])("a %i-byte body sends %i bytes and advertises all of them", (n, send) => {
    expect(truncationPlan(n)).toEqual({ kind: "cut", sendBytes: send, advertisedLength: n });
  });
});
