// SPDX-License-Identifier: MIT

/**
 * The reference origin replays the read-path transcript byte for byte
 * (ADR 0006 Q1, #861).
 *
 * packages/contract/read-path-transcript.json is recorded from the private CDN
 * Worker, and a private test fails when that Worker drifts from it. This is the
 * public half of the chain
 *   SDK live suite → harness + reference origin → (this test) → transcript →
 *   (private test) → the CDN Worker,
 * so it asserts what the private test asserts — the status, the exact header
 * set and the body of every entry — against `reference-origin/`, booted the
 * way the harness boots it (`WranglerHost`, in-process Miniflare).
 *
 * It also holds the harness's own seeding to the transcript: every recorded
 * hit is seeded a second time through `WranglerHost.seed()` — the path seeds
 * and `/admin/*` take — and must answer the same. That fails if the harness's
 * KV key shape (its `configKey` copy) or its metadata fields stop being the
 * ones the CDN reads, which is the harness half of contract.test.ts's
 * metadata and key checks, moved here because it travels with the harness.
 *
 * And it holds the origin to the transcript's `runtime` block (#941): what no
 * exchange can record — the compatibility date, and the `onError` 500 an
 * unexpected failure answers (its status, its body keys and values, and the
 * request header its correlation id is read from). The private repository
 * holds the same block to the CDN Worker, so the two cannot drift apart unseen.
 *
 * Fails closed: an empty transcript, or one whose metadata uses a field the
 * seed format cannot express, fails before anything is replayed.
 */

import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

import origin from "../reference-origin/src/index.js";
import { sdkKeyFromUrl } from "../src/fault-injector.js";
import { SeededKeySchema } from "../src/seed-schema.js";
import type { SeededKey } from "../src/types.js";
import { referenceOrigin } from "../src/upstream.js";
import { WranglerHost, type KvRecord } from "../src/wrangler-host.js";

const pkgRoot = pathResolve(fileURLToPath(import.meta.url), "../..");
const TRANSCRIPT = pathResolve(pkgRoot, "../../packages/contract/read-path-transcript.json");

type Metadata = { etag?: string; lastModified?: string };
type Entry = {
  name: string;
  kv: { key: string; value: string; metadata: Metadata | null } | null;
  request: { method: string; path: string; headers: Record<string, string> };
  response: { status: number; headers: Record<string, string>; body: string };
};

/** What the transcript cannot record by exchange (#795 FR-012). Public: no id, no hostname. */
type Runtime = {
  compatibilityDate: string;
  onError: {
    status: number;
    body: { error: string; message: string; requestId: string };
    correlationHeader: string;
  };
};

const { entries, runtime } = JSON.parse(readFileSync(TRANSCRIPT, "utf-8")) as {
  entries: Entry[];
  runtime: Runtime;
};

/**
 * HTTP framing, not the Worker's answer. The transcript is recorded in the
 * Workers pool, where no message is framed; here the answer crosses a real
 * socket, which adds one of these. Every other header is compared exactly.
 */
const FRAMING = new Set(["content-length", "transfer-encoding"]);

let host: WranglerHost;

beforeAll(async () => {
  host = new WranglerHost({
    scriptPath: referenceOrigin().cdnEntry,
    configPath: referenceOrigin().cdnConfigPath,
  });
  await host.start();
});

afterAll(async () => {
  await host?.dispose();
});

async function send(entry: Entry): Promise<Entry["response"]> {
  const res = await fetch(`${host.workerUrl()}${entry.request.path}`, {
    method: entry.request.method,
    // `identity`: fetch would otherwise ask for gzip, and the answer would be
    // re-encoded on the wire — a transport choice the transcript never made.
    headers: { ...entry.request.headers, "accept-encoding": "identity" },
  });
  const headers = Object.fromEntries([...res.headers].filter(([name]) => !FRAMING.has(name)));
  return { status: res.status, headers, body: await res.text() };
}

function expectRecorded(entry: Entry, observed: Entry["response"]): void {
  expect(observed.status, "status").toBe(entry.response.status);
  expect(observed.headers, "header set").toStrictEqual(entry.response.headers);
  expect(observed.body, "body").toBe(entry.response.body);
}

/** Each KV record once; an entry that repeats a key must repeat its record. */
function records(): KvRecord[] {
  const byKey = new Map<string, KvRecord>();
  for (const { kv } of entries) {
    if (!kv) continue;
    const record: KvRecord = { key: kv.key, value: kv.value };
    if (kv.metadata) record.metadata = { ...kv.metadata } as Record<string, string>;
    const seen = byKey.get(kv.key);
    if (seen) expect(seen, `${kv.key} recorded twice, differently`).toStrictEqual(record);
    byKey.set(kv.key, record);
  }
  return [...byKey.values()];
}

describe("the transcript is usable as the reference origin's oracle", () => {
  it("is not empty", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.kv !== null)).toBe(true);
  });

  it("records only the KV metadata fields the harness seed format expresses", () => {
    const seedFields = Object.keys(SeededKeySchema.innerType().shape).filter(
      (f) => f === "etag" || f === "lastModified",
    );
    const recorded = new Set(entries.flatMap((e) => Object.keys(e.kv?.metadata ?? {})));
    expect([...recorded].sort()).toEqual(["etag", "lastModified"]);
    expect(seedFields.sort()).toEqual([...recorded].sort());
  });

  it("records no framing header, so dropping them here hides nothing", () => {
    for (const e of entries) {
      for (const header of Object.keys(e.response.headers)) {
        expect(FRAMING.has(header), `${e.name}: ${header}`).toBe(false);
      }
    }
  });

  it("stores every recorded value as the canonical JSON the harness writes", () => {
    for (const { kv, name } of entries) {
      if (kv) expect(JSON.stringify(JSON.parse(kv.value)), name).toBe(kv.value);
    }
  });
});

describe("the reference origin answers every transcript entry as recorded", () => {
  beforeAll(async () => {
    await host.clear();
    await host.putRecords(records());
  });

  it.each(entries.map((e) => [e.name, e] as const))("%s", async (_name, entry) => {
    expectRecorded(entry, await send(entry));
  });
});

describe("the harness's own seeding writes what the transcript recorded", () => {
  // Hits only: a recorded request whose path names an SDK key, so the harness
  // can be handed that key the way a seed hands it.
  const seedable = entries.flatMap((entry) => {
    if (!entry.kv) return [];
    const sdkKey = sdkKeyFromUrl(new URL(entry.request.path, "http://reference.test"));
    return sdkKey === null ? [] : [{ entry, sdkKey }];
  });

  beforeAll(async () => {
    await host.clear();
    const keys: SeededKey[] = seedable.map(({ entry, sdkKey }) => ({
      sdkKey,
      payload: JSON.parse(entry.kv!.value) as SeededKey["payload"],
      ...entry.kv!.metadata,
    }));
    await host.seed(keys);
  });

  it("covers the recorded hits", () => {
    expect(seedable.length).toBeGreaterThan(0);
  });

  it.each(seedable.map(({ entry }) => [entry.name, entry] as const))("%s", async (_name, entry) => {
    expectRecorded(entry, await send(entry));
  });
});

describe("the reference origin's runtime is the transcript's runtime block (#941)", () => {
  it("the block carries exactly its three facts", () => {
    // The file is public (#795 security F2): a fourth field is reviewed here first.
    expect(Object.keys(runtime).sort()).toEqual(["compatibilityDate", "onError"]);
    expect(Object.keys(runtime.onError).sort()).toEqual(["body", "correlationHeader", "status"]);
  });

  it("its compatibility_date is the block's compatibilityDate", () => {
    const config = unstable_readConfig(
      { config: referenceOrigin().cdnConfigPath },
      { hideWarnings: true },
    );
    expect(config.compatibility_date).toBe(runtime.compatibilityDate);
  });

  it("an unexpected failure answers the block's onError: status, body and correlation id", async () => {
    // KV failing is the one failure the transcript cannot record, so the origin
    // is called in-process with a KV that throws (on its first read).
    const failingKv = {
      getWithMetadata: () => Promise.reject(new Error("KV unavailable")),
    };
    const correlationId = "transcript-correlation-0941";
    const [entry] = entries.filter((e) => e.kv !== null);
    const res = await origin.fetch(
      new Request(`http://reference.test${entry!.request.path}`, {
        headers: { [runtime.onError.correlationHeader]: correlationId },
      }),
      { CONFIG_KV: failingKv },
    );

    expect(res.status).toBe(runtime.onError.status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(runtime.onError.body).sort());
    expect(body.error).toBe(runtime.onError.body.error);
    expect(body.message).toBe(runtime.onError.body.message);
    // The block names requestId's meaning, not a value: it is the id the
    // correlation header carried, echoed back.
    expect(body.requestId).toBe(correlationId);
  });
});
