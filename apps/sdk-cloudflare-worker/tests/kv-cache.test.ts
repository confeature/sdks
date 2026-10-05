// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { workersKvCache } from "../src/kv-cache.ts";

/**
 * Tests for the {@link workersKvCache} adapter.
 *
 * `workersKvCache` only consumes two methods of the {@link KVNamespace}
 * interface — `get(key, "text")` and `put(key, value, { expirationTtl })`
 * — so a Map-backed in-memory mock that implements those two methods
 * is byte-for-byte equivalent to a real Cloudflare KV binding for the
 * adapter logic we're exercising here.
 *
 * Why not workerd? — `@confeature/sdk-browser-js` (a peer dep of this
 * SDK) uses `WeakRef` for its per-key client singleton table, and
 * Cloudflare's workerd runtime intentionally does NOT expose
 * `WeakRef` / `FinalizationRegistry`. Running this suite under
 * `@cloudflare/vitest-pool-workers` would unconditionally throw on
 * import even though `workersKvCache` itself never touches `WeakRef`.
 * End-to-end workerd integration is verified out-of-band via the
 * deployed README example against real KV.
 *
 * NOTE on expirationTtl: production Cloudflare KV enforces a 60-second
 * floor on `expirationTtl` server-side; the mock does not simulate
 * expiry. We assert plumbing (the option reaches `put`) and the
 * default-TTL fallback paths instead.
 */

interface CapturedPut {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

interface MockKv {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /** Test introspection — most recent `put` call. */
  lastPut(): CapturedPut | undefined;
}

function createMockKv(): MockKv {
  const store = new Map<string, string>();
  let last: CapturedPut | undefined;
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      last = { key, value, options };
      store.set(key, value);
    },
    lastPut(): CapturedPut | undefined {
      return last;
    },
  };
}

describe("workersKvCache", () => {
  it("returns null on a key that has never been written", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace);
    const value = await cache.get("absent-key");
    expect(value).toBeNull();
  });

  it("round-trips a value: set then get returns the same string", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace);
    await cache.set("round-trip-key", "round-trip-value");
    const value = await cache.get("round-trip-key");
    expect(value).toBe("round-trip-value");
  });

  it("round-trips a large JSON payload (config_v6-shaped)", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace);
    const payload = JSON.stringify({
      f: { "feature.x": { v: { b: true }, t: 0 } },
      p: { s: "deadbeef", u: "https://cdn.confeature.io", r: 0 },
      s: [],
    });
    await cache.set("config-key", payload);
    const value = await cache.get("config-key");
    expect(value).toBe(payload);
  });

  it("set() overwrites a previously-stored value", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace);
    await cache.set("overwrite-key", "v1");
    await cache.set("overwrite-key", "v2");
    const value = await cache.get("overwrite-key");
    expect(value).toBe("v2");
  });

  it("two adapter instances over the same KV namespace share storage", async () => {
    const kv = createMockKv();
    const cacheA = workersKvCache(kv as unknown as KVNamespace);
    const cacheB = workersKvCache(kv as unknown as KVNamespace);
    await cacheA.set("shared-key", "shared-value");
    const value = await cacheB.get("shared-key");
    expect(value).toBe("shared-value");
  });

  it("default TTL (60s) is forwarded as expirationTtl on put", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace);
    await cache.set("default-ttl-key", "x");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(60);
  });

  it("custom ttlSeconds is forwarded as expirationTtl on put", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, { ttlSeconds: 120 });
    await cache.set("ttl-key", "ttl-value");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(120);
  });

  it("floors fractional ttlSeconds to an integer", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, { ttlSeconds: 90.7 });
    await cache.set("frac-ttl-key", "x");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(90);
  });

  it("falls back to the default TTL when ttlSeconds is non-finite (NaN)", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, { ttlSeconds: Number.NaN });
    await cache.set("nan-ttl-key", "x");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(60);
  });

  it("falls back to the default TTL when ttlSeconds is zero", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, { ttlSeconds: 0 });
    await cache.set("zero-ttl-key", "y");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(60);
  });

  it("falls back to the default TTL when ttlSeconds is negative", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, { ttlSeconds: -1 });
    await cache.set("neg-ttl-key", "z");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(60);
  });

  it("falls back to the default TTL when ttlSeconds is +Infinity", async () => {
    const kv = createMockKv();
    const cache = workersKvCache(kv as unknown as KVNamespace, {
      ttlSeconds: Number.POSITIVE_INFINITY,
    });
    await cache.set("inf-ttl-key", "z");
    expect(kv.lastPut()?.options?.expirationTtl).toBe(60);
  });
});
