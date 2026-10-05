// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AutoPollConfigService } from "../../src/auto-poll-service.ts";
import type { FetchOutcome, IConfigFetcher } from "../../src/config-fetcher.ts";
import { ClientCacheState, LoggerWrapper, NullLogger, type IConfig } from "@confeature/sdk-shared";
import { Hooks } from "../../src/hooks.ts";
import type { ResolvedOptions } from "../../src/options.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeConfigJson(version: string): IConfig {
  return {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: {
      [`feature.${version}`]: { t: 0, v: { b: true }, i: "v", r: [] },
    },
    s: [],
  };
}

function makeOptions(partial: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    baseUrl: "https://cdn.example.test",
    requestTimeoutMs: 5000,
    pollIntervalMs: 60_000,
    maxInitWaitTimeMs: 5000,
    offline: false,
    defaultUser: undefined,
    flagOverrides: undefined,
    ...partial,
  };
}

function makeService(
  fetcher: IConfigFetcher,
  opts: Partial<ResolvedOptions> = {},
): { service: AutoPollConfigService; hooks: Hooks } {
  const logger = new LoggerWrapper(new NullLogger());
  const hooks = new Hooks();
  return {
    service: new AutoPollConfigService(SDK_KEY, fetcher, makeOptions(opts), logger, hooks),
    hooks,
  };
}

class StubFetcher implements IConfigFetcher {
  public calls = 0;
  public lastETagSent: string | null | undefined;
  constructor(private readonly responder: (call: number) => Promise<FetchOutcome>) {}
  async fetchAsync(_sdkKey: string, eTag: string | null): Promise<FetchOutcome> {
    this.calls++;
    this.lastETagSent = eTag;
    return this.responder(this.calls);
  }
}

/**
 * Drain pending microtasks. The polling loop is `await fetcher() →
 * scheduleNext()`; once the fetcher's promise settles we still owe one
 * microtask for the `then` to run + one for `scheduleNext` to register
 * its timer. A handful of `Promise.resolve()` ticks is enough.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoPollConfigService", () => {
  test("cold-start triggers one fetch immediately", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfigJson("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, { pollIntervalMs: 60_000 });
    await flushMicrotasks();
    expect(fetcher.calls).toBe(1);
    expect(service.getCurrent().configJson).not.toBeNull();
    service.dispose();
  });

  test("subsequent ticks fire one fetch per pollIntervalMs", async () => {
    let v = 0;
    const fetcher = new StubFetcher(async () => {
      v++;
      return {
        status: "fetched",
        configJson: makeConfigJson(`v${String(v)}`),
        eTag: `"e${String(v)}"`,
      };
    });
    const { service } = makeService(fetcher, { pollIntervalMs: 1000 });
    await flushMicrotasks();
    expect(fetcher.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher.calls).toBe(3);
    service.dispose();
  });

  test("forceRefreshAsync triggers a fetch outside the timer cadence", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfigJson("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, { pollIntervalMs: 60_000 });
    await flushMicrotasks();
    expect(fetcher.calls).toBe(1);
    const result = await service.forceRefreshAsync();
    expect(result.isSuccess).toBe(true);
    expect(fetcher.calls).toBe(2);
    // The next tick should still be at the original cadence — advancing
    // by less than the interval should NOT trigger another fetch.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher.calls).toBe(2);
    service.dispose();
  });

  test("dispose() cancels the pending timer", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfigJson("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, { pollIntervalMs: 1000 });
    await flushMicrotasks();
    const before = fetcher.calls;
    service.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(fetcher.calls).toBe(before);
  });

  test("pending fetch rejection post-dispose is swallowed", async () => {
    const fetcher = new StubFetcher(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("network gone"));
          }, 50);
        }),
    );
    const { service } = makeService(fetcher, { pollIntervalMs: 60_000 });
    // Let the constructor's immediate fetch kick off.
    await Promise.resolve();
    service.dispose();
    // Drain the pending rejection — must not throw.
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(service.getCurrent().configJson).toBeNull();
  });

  test("stale-on-error preserves the previous good config after a failed poll", async () => {
    const outcomes: FetchOutcome[] = [
      { status: "fetched", configJson: makeConfigJson("v1"), eTag: '"e1"' },
      {
        status: "failed",
        errorCode: "FETCH_FAILED",
        errorMessage: "boom",
      },
    ];
    const fetcher = new StubFetcher(async (call) => outcomes[Math.min(call, outcomes.length) - 1]!);
    const { service } = makeService(fetcher, { pollIntervalMs: 1000 });
    await flushMicrotasks();
    const firstGood = service.getCurrent().configJson;
    expect(firstGood).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher.calls).toBe(2);
    // Failure preserves the previously-cached config.
    expect(service.getCurrent().configJson).toBe(firstGood);
    service.dispose();
  });

  test("304 Not Modified preserves the previously-parsed payload", async () => {
    const fetcher = new StubFetcher(async (call) =>
      call === 1
        ? { status: "fetched", configJson: makeConfigJson("v1"), eTag: '"e1"' }
        : { status: "notModified", eTag: '"e1"' },
    );
    const { service } = makeService(fetcher, { pollIntervalMs: 1000 });
    await flushMicrotasks();
    const firstRef = service.getCurrent().configJson;
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher.lastETagSent).toBe('"e1"');
    // ETag preserved + same JSON reference.
    expect(service.getCurrent().configJson).toBe(firstRef);
    expect(service.getCurrent().eTag).toBe('"e1"');
    service.dispose();
  });

  test("waitForReady resolves after the first fetch settles", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "fetched",
      configJson: makeConfigJson("v1"),
      eTag: '"e1"',
    }));
    const { service } = makeService(fetcher, { pollIntervalMs: 60_000 });
    const promise = service.waitForReady();
    await flushMicrotasks();
    const state = await promise;
    expect(state).toBe(ClientCacheState.HasUpToDateFlagData);
    service.dispose();
  });

  test("waitForReady resolves with NoFlagData when fetch fails on the cold start", async () => {
    const fetcher = new StubFetcher(async () => ({
      status: "failed",
      errorCode: "FETCH_FAILED",
      errorMessage: "down",
    }));
    const { service } = makeService(fetcher, { maxInitWaitTimeMs: 1000, pollIntervalMs: 60_000 });
    const promise = service.waitForReady();
    await flushMicrotasks();
    const state = await promise;
    expect(state).toBe(ClientCacheState.NoFlagData);
    service.dispose();
  });
});
