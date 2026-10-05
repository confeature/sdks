// SPDX-License-Identifier: MIT

/**
 * Type-system + option-resolution unit tests (T017, US1).
 *
 * Coverage:
 *  - `PollingMode` constant values match `configcat-common`'s numeric
 *    ordering (0/1/2) — switch-on-PollingMode customer code keeps working.
 *  - `resolveOptions` defaults match what the README + parity table claim:
 *      baseUrl                 https://cdn.confeature.io
 *      pollIntervalMs          60_000 (60 s)
 *      cacheTtlMs              60_000 (60 s)
 *      requestTimeoutMs        10_000  (Deno spec FR-013)
 *      maxInitWaitTimeMs       5_000
 *      cacheKind               filesystem
 *  - Out-of-range clamping logs a warning via the `onWarn` hook and
 *    falls back to the documented minimum.
 *  - `cache: "memory"` resolves `cacheKind === "memory"`.
 */

import { describe, expect, test } from "vitest";

import {
  DataGovernance,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_INIT_WAIT_TIME_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PollingMode,
} from "../../src/index.ts";
import { resolveOptions } from "../../src/options.ts";

describe("PollingMode enum parity", () => {
  test("numeric values match configcat-common", () => {
    expect(PollingMode.AutoPoll).toBe(0);
    expect(PollingMode.LazyLoad).toBe(1);
    expect(PollingMode.ManualPoll).toBe(2);
  });
});

describe("DataGovernance enum parity", () => {
  test("numeric values match configcat-common", () => {
    expect(DataGovernance.Global).toBe(0);
    expect(DataGovernance.EuOnly).toBe(1);
  });
});

describe("Default option constants", () => {
  test("documented defaults are exported as constants", () => {
    expect(DEFAULT_BASE_URL).toBe("https://cdn.confeature.io");
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(60);
    expect(DEFAULT_CACHE_TTL_SECONDS).toBe(60);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_MAX_INIT_WAIT_TIME_SECONDS).toBe(5);
  });
});

describe("resolveOptions — defaults", () => {
  test("undefined options yields documented defaults", () => {
    const out = resolveOptions(undefined);
    expect(out.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(out.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(out.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_SECONDS * 1000);
    expect(out.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_SECONDS * 1000);
    expect(out.maxInitWaitTimeMs).toBe(DEFAULT_MAX_INIT_WAIT_TIME_SECONDS * 1000);
    expect(out.offline).toBe(false);
    expect(out.defaultUser).toBeUndefined();
    expect(out.flagOverrides).toBeUndefined();
    expect(out.cacheKind).toBe("filesystem");
  });

  test("empty object yields the same defaults as undefined", () => {
    const out = resolveOptions({});
    expect(out.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(out.pollIntervalMs).toBe(60_000);
    expect(out.cacheTtlMs).toBe(60_000);
    expect(out.cacheKind).toBe("filesystem");
  });

  test("cache: 'memory' resolves cacheKind to memory", () => {
    const out = resolveOptions({ cache: "memory" });
    expect(out.cacheKind).toBe("memory");
  });

  test("cache: 'filesystem' resolves cacheKind to filesystem", () => {
    const out = resolveOptions({ cache: "filesystem" });
    expect(out.cacheKind).toBe("filesystem");
  });

  test("offline flag is honoured", () => {
    const out = resolveOptions({ offline: true });
    expect(out.offline).toBe(true);
  });

  test("baseUrl strips trailing slashes", () => {
    const out = resolveOptions({ baseUrl: "https://example.test/path///" });
    expect(out.baseUrl).toBe("https://example.test/path");
  });

  test("baseUrl invalid value warns and falls back to default", () => {
    const warnings: string[] = [];
    const out = resolveOptions({ baseUrl: "::not a url::" }, (m) => warnings.push(m));
    expect(out.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveOptions — clamping", () => {
  test("pollIntervalSeconds < 1 clamps to 1 second", () => {
    const warnings: string[] = [];
    const out = resolveOptions({ pollIntervalSeconds: 0 }, (m) => warnings.push(m));
    expect(out.pollIntervalMs).toBe(1000);
    expect(warnings.some((w) => w.includes("pollIntervalSeconds"))).toBe(true);
  });

  test("cacheTimeToLiveSeconds < 1 clamps to 1 second", () => {
    const warnings: string[] = [];
    const out = resolveOptions({ cacheTimeToLiveSeconds: -10 }, (m) => warnings.push(m));
    expect(out.cacheTtlMs).toBe(1000);
    expect(warnings.some((w) => w.includes("cacheTimeToLiveSeconds"))).toBe(true);
  });

  test("requestTimeoutMs below minimum clamps to 1000ms", () => {
    const warnings: string[] = [];
    const out = resolveOptions({ requestTimeoutMs: 5 }, (m) => warnings.push(m));
    expect(out.requestTimeoutMs).toBe(1000);
    expect(warnings.some((w) => w.includes("requestTimeoutMs"))).toBe(true);
  });

  test("negative maxInitWaitTimeSeconds means 'wait forever' (-1)", () => {
    const out = resolveOptions({ maxInitWaitTimeSeconds: -1 });
    expect(out.maxInitWaitTimeMs).toBe(-1);
  });
});
