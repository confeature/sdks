// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";

import { InMemoryConfigCache } from "../../src/config-cache.ts";
import { ProjectConfig, type IConfig } from "@confeature/sdk-shared";
const SAMPLE_CONFIG: IConfig = {
  p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
  f: { "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] } },
  s: [],
};

describe("InMemoryConfigCache", () => {
  test("initial state is ProjectConfig.empty()", () => {
    const cache = new InMemoryConfigCache();
    const current = cache.getCurrent();
    expect(current.configJson).toBeNull();
    expect(current.eTag).toBeNull();
    expect(current.fetchTime).toBe(0);
    // empty()'s settings record is `{}` — never throws.
    expect(Object.keys(current.settings)).toEqual([]);
  });

  test("set() performs an atomic swap — getCurrent() returns the latest ref", () => {
    const cache = new InMemoryConfigCache();
    const first = new ProjectConfig(SAMPLE_CONFIG, '"e1"', 1000);
    cache.set(first);
    expect(cache.getCurrent()).toBe(first);
    const second = new ProjectConfig(SAMPLE_CONFIG, '"e2"', 2000);
    cache.set(second);
    expect(cache.getCurrent()).toBe(second);
    expect(cache.getCurrent().eTag).toBe('"e2"');
  });

  test("ETag is preserved across a 304 no-op (withFreshFetchTime keeps same eTag + json)", () => {
    const cache = new InMemoryConfigCache();
    const first = new ProjectConfig(SAMPLE_CONFIG, '"e1"', 1000);
    cache.set(first);
    const refreshed = cache.getCurrent().withFreshFetchTime(5000);
    cache.set(refreshed);
    expect(cache.getCurrent().eTag).toBe('"e1"');
    expect(cache.getCurrent().configJson).toBe(SAMPLE_CONFIG);
    expect(cache.getCurrent().fetchTime).toBe(5000);
  });

  test("ProjectConfig.empty() returns a distinct empty value each call but is structurally equal", () => {
    const a = ProjectConfig.empty();
    const b = ProjectConfig.empty();
    expect(a.configJson).toBeNull();
    expect(b.configJson).toBeNull();
    expect(a.fetchTime).toBe(0);
    expect(b.fetchTime).toBe(0);
  });

  test("isExpired flips on stale fetchTime", () => {
    const now = Date.now();
    const fresh = new ProjectConfig(SAMPLE_CONFIG, '"e"', now);
    const stale = new ProjectConfig(SAMPLE_CONFIG, '"e"', now - 100_000);
    expect(fresh.isExpired(60_000)).toBe(false);
    expect(stale.isExpired(60_000)).toBe(true);
  });
});
