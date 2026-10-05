// SPDX-License-Identifier: MIT

/**
 * Unit tests for `ConfigPollService` — the three polling modes (T026, US3).
 *
 * SC-004: zero-flake budget. Every assertion in this file is driven by
 * `vi.useFakeTimers()` so wall-clock noise can't make a flake.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ClientCacheState,
  type FetchOutcome,
  type IConfig,
  type IConfigFetcher,
  LoggerWrapper,
  NullLogger,
} from "@confeature/sdk-shared";

import { DenoFileConfigCache } from "../../src/deno-file-cache.ts";
import { Hooks } from "../../src/hooks.ts";
import { PollingMode, type ResolvedOptions } from "../../src/options.ts";
import { ConfigPollService } from "../../src/poll-service.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CACHE_KEY = "confeature:cache:v1:abc12345abc12345abc12345abc12345";

function makeConfig(tag: string): IConfig {
  return {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: { [`feature.${tag}`]: { t: 0, v: { b: true }, i: "v", r: [] } },
    s: [],
  };
}

function makeOptions(partial: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    baseUrl: "https://cdn.example.test",
    requestTimeoutMs: 5000,
    pollIntervalMs: 60_000,
    cacheTtlMs: 60_000,
    maxInitWaitTimeMs: 5000,
    offline: false,
    defaultUser: undefined,
    flagOverrides: undefined,
    cacheKind: "memory",
    ...partial,
  };
}

class StubFetcher implements IConfigFetcher {
  public calls = 0;
  constructor(private readonly responder: (call: number) => Promise<FetchOutcome>) {}
  async fetchAsync(_eTag: string | null): Promise<FetchOutcome> {
    this.calls++;
    return this.responder(this.calls);
  }
}

function makeService(
  fetcher: IConfigFetcher,
  mode: PollingMode,
  opts: Partial<ResolvedOptions> = {},
): { service: ConfigPollService; hooks: Hooks; cache: DenoFileConfigCache } {
  const logger = new LoggerWrapper(new NullLogger());
  const hooks = new Hooks();
  const cache = new DenoFileConfigCache(CACHE_KEY, "memory", logger);
  const service = new ConfigPollService(
    SDK_KEY,
    fetcher,
    cache,
    makeOptions(opts),
    mode,
    logger,
    hooks,
  );
  return { service, hooks, cache };
}

/** Drain enough microtasks to let the polling chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AutoPoll mode — exact tick count by time", () => {
  test("at t=60s/120s/300s the fetcher has been called 1/2/3/6 times", async () => {
    let v = 0;
    const fetcher = new StubFetcher(async () => {
      v++;
      return {
        status: "fetched",
        configJson: makeConfig(`v${String(v)}`),
        eTag: `"e${String(v)}"`,
      };
    });
    const { service } = makeService(fetcher, PollingMode.AutoPoll, {
      pollIntervalMs: 60_000,
    });
    // Cold-start call fires immediately.
    await flush();
    expect(fetcher.calls).toBe(1);
    // t = 60s → second call.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetcher.calls).toBe(2);
    // t = 120s → third call.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetcher.calls).toBe(3);
    // t = 300s total (advance 3 more 60s windows).
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    await flush();
    expect(fetcher.calls).toBe(6);
    service.dispose();
  });

  test("dispose() stops further polls regardless of advanced time", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, PollingMode.AutoPoll, {
      pollIntervalMs: 1000,
    });
    await flush();
    const before = fetcher.calls;
    service.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetcher.calls).toBe(before);
  });
});

describe("LazyLoad mode — fires only when cache age exceeds TTL", () => {
  test("background refresh fires only after cacheTtlMs elapses since the last fetch", async () => {
    let calls = 0;
    const fetcher = new StubFetcher(async () => {
      calls++;
      return {
        status: "fetched",
        configJson: makeConfig(`v${String(calls)}`),
        eTag: `"e${String(calls)}"`,
      };
    });
    const { service } = makeService(fetcher, PollingMode.LazyLoad, {
      cacheTtlMs: 10_000,
      pollIntervalMs: 60_000, // ignored in LazyLoad mode
    });
    // Initial fetch happens once at construction.
    await flush();
    expect(fetcher.calls).toBe(1);
    // ensureFresh() before TTL → no extra fetch.
    service.ensureFresh();
    await flush();
    expect(fetcher.calls).toBe(1);
    // Advance past the TTL → next ensureFresh triggers a refresh.
    await vi.advanceTimersByTimeAsync(11_000);
    service.ensureFresh();
    await flush();
    expect(fetcher.calls).toBe(2);
    service.dispose();
  });

  test("LazyLoad does NOT install a recurring timer", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, PollingMode.LazyLoad, {
      cacheTtlMs: 1000,
    });
    await flush();
    const before = fetcher.calls;
    // Advance well past several TTL windows without invoking ensureFresh.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetcher.calls).toBe(before);
    service.dispose();
  });
});

describe("ManualPoll mode — never auto-fires", () => {
  test("no fetch occurs at construction or after advancing time", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, PollingMode.ManualPoll, {
      pollIntervalMs: 1000,
    });
    await flush();
    expect(fetcher.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(fetcher.calls).toBe(0);
    service.dispose();
  });

  test("forceRefreshAsync is the only way to trigger a fetch", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, PollingMode.ManualPoll, {});
    await flush();
    expect(fetcher.calls).toBe(0);
    const result = await service.forceRefreshAsync();
    expect(result.isSuccess).toBe(true);
    expect(fetcher.calls).toBe(1);
    service.dispose();
  });
});

describe("Polling hooks — configChanged + clientReady", () => {
  test("configChanged fires on 200 fetch", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service, hooks } = makeService(fetcher, PollingMode.AutoPoll, {
      pollIntervalMs: 60_000,
    });
    const events: IConfig[] = [];
    hooks.on("configChanged", (cfg) => {
      events.push(cfg);
    });
    await flush();
    expect(events.length).toBe(1);
    service.dispose();
  });

  test("clientReady fires after first fetch settles", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service, hooks } = makeService(fetcher, PollingMode.AutoPoll, {
      pollIntervalMs: 60_000,
    });
    const promise = service.waitForReady();
    let readyHookFired = false;
    hooks.on("clientReady", () => {
      readyHookFired = true;
    });
    await flush();
    const state = await promise;
    expect(state).toBe(ClientCacheState.HasUpToDateFlagData);
    expect(readyHookFired).toBe(true);
    service.dispose();
  });
});

describe("Stale-on-error", () => {
  test("failed fetch preserves the previous good config", async () => {
    const outcomes: FetchOutcome[] = [
      { status: "fetched", configJson: makeConfig("v1"), eTag: '"e1"' },
      { status: "failed", errorCode: "FETCH_FAILED", errorMessage: "boom" },
    ];
    const fetcher = new StubFetcher(async (call) => outcomes[Math.min(call, outcomes.length) - 1]!);
    const { service } = makeService(fetcher, PollingMode.AutoPoll, {
      pollIntervalMs: 1000,
    });
    await flush();
    const firstGood = service.getCurrent().configJson;
    expect(firstGood).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(fetcher.calls).toBe(2);
    // Failure does NOT wipe the cache.
    expect(service.getCurrent().configJson).toBe(firstGood);
    service.dispose();
  });
});

describe("Offline mode", () => {
  test("constructed offline → no fetches; setOnline() unsticks AutoPoll", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfig("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, PollingMode.AutoPoll, {
      offline: true,
      pollIntervalMs: 60_000,
    });
    await flush();
    expect(fetcher.calls).toBe(0);
    service.setOffline(false);
    await flush();
    expect(fetcher.calls).toBe(1);
    service.dispose();
  });
});
