// SPDX-License-Identifier: MIT

/**
 * Unit tests for `BrowserConfigCache` + `InMemoryConfigCache` (T051, US2).
 *
 * Coverage:
 *  - localStorage hit / miss / set roundtrip.
 *  - localStorage fallback to memory when:
 *      a) globalThis.localStorage is undefined,
 *      b) `setItem` throws (quota / private mode),
 *      c) constructor receives `cacheKind === "memory"`.
 *  - Cache key format matches `confeature:cache:v1:[A-Za-z0-9_-]{32}`.
 *  - FR-019: after `getValueAsync(key, default, user)` is called with a
 *    fully-populated user context, dumping `localStorage` shows ZERO
 *    user-context fields (`identifier`, `email`, `country`, `custom`).
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  deriveCacheKeySync,
  LoggerWrapper,
  NullLogger,
  ProjectConfig,
  User,
  type IConfig,
} from "@confeature/sdk-shared";

import { BrowserConfigCache } from "../../src/localstorage-cache.ts";
import { InMemoryConfigCache } from "../../src/memory-cache.ts";
import { ConfeatureClient, disposeAllClients, PollingMode } from "../../src/index.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeConfig(): IConfig {
  return {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: {
      "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] },
      "feature.y": { t: 0, v: { b: false }, i: "vy", r: [] },
    },
    s: [],
  };
}

function makeLogger(): LoggerWrapper {
  return new LoggerWrapper(new NullLogger());
}

beforeEach(() => {
  globalThis.localStorage.clear();
  disposeAllClients();
});

afterEach(() => {
  globalThis.localStorage.clear();
  disposeAllClients();
  vi.restoreAllMocks();
});

describe("InMemoryConfigCache", () => {
  test("starts empty", () => {
    const c = new InMemoryConfigCache();
    expect(c.getCurrent().configJson).toBeNull();
  });

  test("set() swaps the held config", () => {
    const c = new InMemoryConfigCache();
    const cfg = new ProjectConfig(makeConfig(), '"e1"', 1000);
    c.set(cfg);
    expect(c.getCurrent()).toBe(cfg);
  });
});

describe("BrowserConfigCache — localStorage roundtrip", () => {
  test("set() persists to localStorage; hydrate() reads it back", () => {
    const key = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
    const cache = new BrowserConfigCache(key, "localStorage", makeLogger());
    const cfg = new ProjectConfig(makeConfig(), '"e1"', 12345);
    cache.set(cfg);

    const raw = globalThis.localStorage.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.etag).toBe('"e1"');
    expect(parsed.fetchedAt).toBe(12345);
    // Re-hydrate via a brand-new cache instance.
    const next = new BrowserConfigCache(key, "localStorage", makeLogger());
    expect(next.getCurrent().eTag).toBe('"e1"');
    expect(next.getCurrent().fetchTime).toBe(12345);
    expect(next.getCurrent().configJson).not.toBeNull();
  });

  test("hydrate() drops corrupted entries silently", () => {
    const key = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
    globalThis.localStorage.setItem(key, "not-json{");
    const cache = new BrowserConfigCache(key, "localStorage", makeLogger());
    expect(cache.getCurrent().configJson).toBeNull();
    // The corrupted entry should have been removed during hydrate.
    expect(globalThis.localStorage.getItem(key)).toBeNull();
  });

  test("hydrate() drops entries with bad shape", () => {
    const key = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
    globalThis.localStorage.setItem(
      key,
      JSON.stringify({ config: { not: "the right shape" }, etag: null, fetchedAt: 1 }),
    );
    const cache = new BrowserConfigCache(key, "localStorage", makeLogger());
    expect(cache.getCurrent().configJson).toBeNull();
  });
});

describe("BrowserConfigCache — memory fallback paths", () => {
  test("cacheKind === 'memory' bypasses localStorage entirely", () => {
    const key = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
    const cache = new BrowserConfigCache(key, "memory", makeLogger());
    const cfg = new ProjectConfig(makeConfig(), '"e1"', 999);
    cache.set(cfg);
    // Nothing persisted.
    expect(globalThis.localStorage.getItem(key)).toBeNull();
    // But getCurrent still works.
    expect(cache.getCurrent().eTag).toBe('"e1"');
  });

  test("setItem throwing demotes the cache to memory-only for the lifetime", () => {
    const key = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
    const cache = new BrowserConfigCache(key, "localStorage", makeLogger());
    const setItemSpy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const cfg = new ProjectConfig(makeConfig(), '"e1"', 1);
    expect(() => cache.set(cfg)).not.toThrow();
    // Memory still has it.
    expect(cache.getCurrent().eTag).toBe('"e1"');
    setItemSpy.mockRestore();
    // A subsequent set should NOT touch localStorage anymore.
    const cfg2 = new ProjectConfig(makeConfig(), '"e2"', 2);
    const setItemSpy2 = vi.spyOn(globalThis.localStorage, "setItem");
    cache.set(cfg2);
    expect(setItemSpy2).not.toHaveBeenCalled();
  });
});

describe("BrowserConfigCache — cache key format (FR-015)", () => {
  test("deriveCacheKeySync output matches `confeature:cache:v1:[A-Za-z0-9_-]{32}`", () => {
    const key = deriveCacheKeySync(SDK_KEY);
    expect(key).toMatch(/^confeature:cache:v1:[A-Za-z0-9_-]{32}$/);
  });

  test("deriveCacheKeySync is deterministic for the same input", () => {
    expect(deriveCacheKeySync(SDK_KEY)).toBe(deriveCacheKeySync(SDK_KEY));
  });

  test("deriveCacheKeySync produces different keys for different inputs", () => {
    const a = deriveCacheKeySync(SDK_KEY);
    const b = deriveCacheKeySync(SDK_KEY.replace(/A/g, "Z"));
    expect(a).not.toBe(b);
  });
});

describe("FR-019: user context MUST NOT be persisted to localStorage", () => {
  test("getValueAsync with a fully-populated user leaves localStorage user-free", async () => {
    // Seed a working config so the snapshot/eval path exercises every
    // user-aware code path the SDK has.
    const cacheKey = deriveCacheKeySync(SDK_KEY);
    globalThis.localStorage.setItem(
      cacheKey,
      JSON.stringify({ config: makeConfig(), etag: '"e1"', fetchedAt: Date.now() }),
    );

    const richUser = new User("alice@example.com", "alice@example.com", "FR", {
      plan: "pro",
      betaTester: "true",
    });

    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, { offline: true });
    // Read via every public eval path that takes a user.
    await client.getValueAsync("feature.x", false, richUser);
    await client.getValueDetailsAsync("feature.x", false, richUser);
    await client.getAllValuesAsync(richUser);
    await client.getAllValueDetailsAsync(richUser);
    client.setDefaultUser(richUser);
    await client.getValueAsync("feature.y", true);
    client.clearDefaultUser();

    // Dump every localStorage entry — none may contain user fields.
    const banned = ["alice@example.com", "FR", "betaTester", '"plan"', "pro"];
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i);
      if (k === null) continue;
      const v = globalThis.localStorage.getItem(k) ?? "";
      for (const needle of banned) {
        expect(v).not.toContain(needle);
      }
      // The persisted entry should also NOT have an `identifier`,
      // `email`, `country`, or `custom` key.
      try {
        const parsed = JSON.parse(v) as Record<string, unknown>;
        expect(Object.keys(parsed)).not.toContain("identifier");
        expect(Object.keys(parsed)).not.toContain("email");
        expect(Object.keys(parsed)).not.toContain("country");
        expect(Object.keys(parsed)).not.toContain("custom");
      } catch {
        // Non-JSON entries are also acceptable, but should not contain
        // banned substrings — already asserted above.
      }
    }

    client.dispose();
  });
});
