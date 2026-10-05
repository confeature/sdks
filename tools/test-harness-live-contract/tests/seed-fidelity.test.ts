// SPDX-License-Identifier: MIT

/**
 * Seed fidelity — every seeded wire-case is served the way the corpus says
 * (plan 680, US1 / FR-008, decision row 12). This is the only test that
 * compares a seed to its case — status, declared headers, undeclared
 * validators, framing, and the body's CONTENT. corpus-mapping.test.ts checks that seeds
 * EXIST, this checks what they SERVE, over real HTTP against the
 * reference origin, which the read-path transcript binds to the real CDN Worker.
 *
 * Why it exists: until plan 680 a seed's `fault` was never applied, so five
 * seeds were decorative and nothing noticed — the suite only ever asked
 * whether a file was there. An SDK classes 403 and 404 alike, so only the
 * observed wire can tell a 403 seed from one that silently answers 404.
 *
 * One boot for every case: each seed's key is renamed to its case id and all
 * of them are written in one KV bulk put. A reset per case would cost a KV
 * clear + write per case (~1 s each), paid twice per pre-push.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultWireCasesPath } from "../src/corpus-mapper.js";
import { startHarness } from "../src/harness.js";
import { referenceOrigin } from "../src/upstream.js";
import { buildCorpusSeed, seededCaseIds } from "../src/corpus-seed.js";
import { NULL_BODY_STATUSES } from "../src/seed-schema.js";
import type { HarnessHandle } from "../src/types.js";

const { cdnEntry, cdnConfigPath } = referenceOrigin();

type WireCase = {
  id: string;
  given: { previousEtag: string | null };
  server: {
    status: number;
    behavior?: "timeout" | "close-mid-response";
    headers?: Record<string, string>;
    body?: string;
    bodyRef?: string | null;
  };
};

const corpus = JSON.parse(readFileSync(defaultWireCasesPath(), "utf-8")) as { cases: WireCase[] };
// The set under test: every corpus case that has a seed (FR-008), decided in
// one place — src/corpus-seed.ts, shared with the SDK live runners (#783).
const seededIds = new Set(seededCaseIds());
const seededCases = corpus.cases.filter((c) => seededIds.has(c.id));

/** Header names a case does NOT declare but whose presence changes SDK behaviour. */
const VALIDATORS = ["etag", "last-modified"] as const;

let harness: HarnessHandle;

beforeAll(async () => {
  harness = await startHarness({
    cdnEntry,
    cdnConfigPath,
    initialSeed: buildCorpusSeed(),
  });
});

afterAll(async () => {
  await harness?.stop();
});

function request(c: WireCase, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {};
  if (c.given.previousEtag !== null) headers["if-none-match"] = c.given.previousEtag;
  return fetch(`${harness.url}/configuration-files/${c.id}/config_v6.json`, { headers, signal });
}

function assertHead(c: WireCase, res: Response): void {
  expect(res.status, `${c.id}: status`).toBe(c.server.status);
  const declared = Object.fromEntries(
    Object.entries(c.server.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const [name, value] of Object.entries(declared)) {
    expect(res.headers.get(name), `${c.id}: header ${name}`).toBe(value);
  }
  // Framing is harness-computed (plan 680 FR-002): never chunked, and a
  // null-body status (204/205/304) carries no Content-Length at all.
  expect(res.headers.get("transfer-encoding"), `${c.id}: transfer-encoding`).toBeNull();
  if (NULL_BODY_STATUSES.has(c.server.status)) {
    expect(res.headers.get("content-length"), `${c.id}: content-length`).toBeNull();
  }
  for (const name of VALIDATORS) {
    if (!(name in declared)) {
      expect(res.headers.get(name), `${c.id}: undeclared ${name}`).toBeNull();
    }
  }
}

describe("seed fidelity — each seed serves its wire-case's server block", () => {
  // The case set every live runner iterates is the one the harness REPORTS
  // (`GET /admin/state` → keys, #783): it must be exactly the seeded cases, so
  // a runner can neither miss a case nor run one the corpus no longer has.
  it("reports exactly the seeded case ids as its keys", async () => {
    const state = (await (await fetch(`${harness.url}/admin/state`)).json()) as { keys: string[] };
    expect(state.keys).toEqual([...seededIds].sort());
  });

  it("covers every seeded case (the set is not empty)", () => {
    expect(seededCases.length).toBeGreaterThan(0);
  });

  it.each(seededCases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    if (c.server.behavior === "timeout") {
      // Never answered within the SDK's deadline: observed with a 500 ms
      // client abort, not by waiting out the seed's own hold.
      await expect(request(c, AbortSignal.timeout(500))).rejects.toThrow();
      return;
    }

    const res = await request(c);
    assertHead(c, res);

    if (c.server.behavior === "close-mid-response") {
      // Headers arrive, then the body stops short of what was advertised:
      // the read must fail AFTER at least one byte — a transport failure,
      // never a complete-but-short body an SDK would misread as bad JSON.
      const reader = res.body!.getReader();
      let received = 0;
      const read = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += value.byteLength;
        }
      };
      await expect(read(), `${c.id}: body must not complete`).rejects.toThrow();
      expect(received, `${c.id}: bytes before the cut`).toBeGreaterThan(0);
      return;
    }

    const body = await res.text();
    if (c.server.body !== undefined) {
      expect(body, `${c.id}: body`).toBe(c.server.body);
    } else if (c.server.bodyRef) {
      // Content, not presence: the served config must BE the fixture the
      // corpus names. Compared as JSON — the harness re-serialises payloads.
      const fixture = JSON.parse(
        readFileSync(pathResolve(dirname(defaultWireCasesPath()), c.server.bodyRef), "utf-8"),
      ) as unknown;
      expect(JSON.parse(body), `${c.id}: body is ${c.server.bodyRef}`).toEqual(fixture);
    } else {
      expect(body, `${c.id}: no body`).toBe("");
    }
  });
});
