// SPDX-License-Identifier: MIT

/**
 * Unit tests for `ConfeatureClient` — Phase 3 (US1) deliverable.
 *
 * Coverage:
 *  - Public API shape: every documented method exists and has the right
 *    arity / return-type contract.
 *  - Lifecycle: `dispose()` is idempotent and releases timers / cache handles.
 *  - SC-006: no log line produced by any failure path contains the raw
 *    SDK key (FR-019).
 *
 * Cache backend: each test uses `cache: "memory"` to keep the SDK
 * filesystem-free under vitest. The Bun-file cache path is covered
 * specifically in `cache.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import keyShapes from "@confeature/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json" with { type: "json" };

import {
  ConfeatureClient,
  ConfigCatClient,
  disposeAllClients,
  type IAutoPollOptions,
  type IConfig,
  type IConfigCatLogger,
  LogLevel,
  PollingMode,
} from "../../src/index.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeBooleanConfig(): IConfig {
  return {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: {
      "feature.dark-mode": { t: 0, v: { b: true }, i: "v-dm", r: [] },
      "feature.beta": { t: 0, v: { b: false }, i: "v-bt", r: [] },
    },
    s: [],
  };
}

/** The URL a `fetch` mock was called with, whatever form it took. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Every string an error can carry: name, message, stack, cause chain. */
function textOf(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 4) return "";
  if (value instanceof Error) {
    return `${value.name} ${value.message} ${value.stack ?? ""} ${textOf(value.cause, depth + 1)}`;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Capture every log line a customer logger receives. */
class CapturingLogger implements IConfigCatLogger {
  public level: LogLevel = LogLevel.Debug;
  public eol = "\n";
  public readonly entries: {
    level: LogLevel;
    eventId: number | string;
    message: string;
    exception?: unknown;
  }[] = [];
  log(
    level: LogLevel,
    eventId: number | string,
    message: string | { toString(): string },
    exception?: unknown,
  ): void {
    this.entries.push({
      level,
      eventId,
      message: typeof message === "string" ? message : message.toString(),
      exception,
    });
  }
}

beforeEach(() => {
  disposeAllClients();
});

afterEach(() => {
  disposeAllClients();
  vi.restoreAllMocks();
});

describe("ConfeatureClient — public surface", () => {
  test("exposes every method from IConfigCatClient", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      cache: "memory",
    });
    // Async eval surface.
    expect(typeof client.getValueAsync).toBe("function");
    expect(typeof client.getValueDetailsAsync).toBe("function");
    expect(typeof client.getAllKeysAsync).toBe("function");
    expect(typeof client.getAllValuesAsync).toBe("function");
    expect(typeof client.getAllValueDetailsAsync).toBe("function");
    expect(typeof client.getKeyAndValueAsync).toBe("function");
    // Refresh + ready.
    expect(typeof client.forceRefreshAsync).toBe("function");
    expect(typeof client.waitForReady).toBe("function");
    // Snapshot + default user.
    expect(typeof client.snapshot).toBe("function");
    expect(typeof client.setDefaultUser).toBe("function");
    expect(typeof client.clearDefaultUser).toBe("function");
    // Online / offline. `isOffline` is a readonly getter (#271 D3 closed).
    expect(typeof client.isOffline).toBe("boolean");
    expect(typeof client.setOnline).toBe("function");
    expect(typeof client.setOffline).toBe("function");
    // Hooks.
    expect(typeof client.on).toBe("function");
    expect(typeof client.once).toBe("function");
    expect(typeof client.off).toBe("function");
    // Lifecycle.
    expect(typeof client.dispose).toBe("function");
    client.dispose();
  });

  test("ConfigCatClient is exported as an alias of ConfeatureClient (drop-in migration)", () => {
    expect(ConfigCatClient).toBe(ConfeatureClient);
  });

  test("getValueAsync returns the default when no config is cached", async () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      cache: "memory",
    });
    const value = await client.getValueAsync("feature.unknown", false);
    expect(value).toBe(false);
    client.dispose();
  });

  test("dispose() is idempotent and clears the singleton slot", () => {
    const client = ConfeatureClient.getInstance(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      cache: "memory",
    });
    expect(() => {
      client.dispose();
      client.dispose();
    }).not.toThrow();
    // After dispose, getInstance creates a new client.
    const next = ConfeatureClient.getInstance(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      cache: "memory",
    });
    expect(next).not.toBe(client);
    next.dispose();
  });

  test("dispose() cancels in-flight AutoPoll timer (no further fetches after dispose)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeBooleanConfig()), {
        status: 200,
        headers: { ETag: '"e1"' },
      }),
    );
    try {
      const client = new ConfeatureClient(SDK_KEY, PollingMode.AutoPoll, {
        pollIntervalSeconds: 1,
        maxInitWaitTimeSeconds: 0,
        cache: "memory",
      } as IAutoPollOptions);
      // Let the initial fetch + scheduleNext register.
      await vi.advanceTimersByTimeAsync(50);
      const before = fetchSpy.mock.calls.length;
      client.dispose();
      // After dispose, no further fetches even after multiple intervals.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchSpy.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConfeatureClient — SC-006 (SDK key never logged)", () => {
  test("invalid SDK key triggers a log line but the raw key never appears", () => {
    const logger = new CapturingLogger();
    const badKey = "not-a-confeature-key-but-long-enough-to-be-a-key-12345";
    const client = new ConfeatureClient(badKey, PollingMode.ManualPoll, {
      offline: true,
      cache: "memory",
      logger,
    });
    // At least one log entry must have been produced (invalidSdkKey).
    expect(logger.entries.length).toBeGreaterThan(0);
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(badKey);
    }
    client.dispose();
  });

  test("fetch failure path does NOT include the raw SDK key in logs", async () => {
    const logger = new CapturingLogger();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network gone"));
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
      logger,
    });
    const result = await client.forceRefreshAsync();
    expect(result.isSuccess).toBe(false);
    // None of the captured log lines may contain the raw key.
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SDK_KEY);
    }
    client.dispose();
  });

  test("HTTP error path does NOT include the raw SDK key in logs", async () => {
    const logger = new CapturingLogger();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server-error", { status: 500 }));
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
      logger,
    });
    await client.forceRefreshAsync();
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SDK_KEY);
    }
    client.dispose();
  });

  test("404 (invalid key) path does NOT include the raw SDK key in logs", async () => {
    const logger = new CapturingLogger();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
      logger,
    });
    await client.forceRefreshAsync();
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SDK_KEY);
    }
    client.dispose();
  });

  test("malformed payload path does NOT include the raw SDK key in logs", async () => {
    const logger = new CapturingLogger();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json-at-all", { status: 200 }),
    );
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
      logger,
    });
    await client.forceRefreshAsync();
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SDK_KEY);
    }
    client.dispose();
  });
});

describe("ConfeatureClient — SDK key shapes (#802)", () => {
  // Minted today: ConfigCat's own shape, with two `/` separators.
  const NEW_KEY = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";
  const [, SEGMENT_A, SEGMENT_B] = NEW_KEY.split("/") as [string, string, string];

  test.each(keyShapes.valid.map((c) => [c.name, c.key]))(
    "a valid %s key logs no INVALID_SDK_KEY",
    (_name, key) => {
      const logger = new CapturingLogger();
      const client = new ConfeatureClient(key, PollingMode.ManualPoll, {
        offline: true,
        cache: "memory",
        logger,
      });
      expect(logger.entries.map((e) => e.eventId)).not.toContain("INVALID_SDK_KEY");
      client.dispose();
    },
  );

  // The counter-check: without it the test above would pass on a logger
  // that captured nothing.
  test.each(keyShapes.invalid.map((c) => [c.name, c.key]))(
    "an invalid key (%s) does log INVALID_SDK_KEY",
    (_name, key) => {
      const logger = new CapturingLogger();
      const client = new ConfeatureClient(key, PollingMode.ManualPoll, {
        offline: true,
        cache: "memory",
        logger,
      });
      expect(logger.entries.map((e) => e.eventId)).toContain("INVALID_SDK_KEY");
      client.dispose();
    },
  );

  // FR-001 / FR-004 (#803): ConfigCat's path, the key RAW — compared on the
  // PARSED path, so #807's query cannot break the pin.
  test("the fetch URL carries the key raw, exactly as a stock ConfigCat SDK sends it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeBooleanConfig()), {
        status: 200,
        headers: { ETag: '"e1"' },
      }),
    );
    const client = new ConfeatureClient(NEW_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
    });
    await client.forceRefreshAsync();
    const url = new URL(urlOf(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe(
      "/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/config_v6.json",
    );
    expect(url.searchParams.get("sdk")).not.toBeNull();
    client.dispose();
  });

  // FR-002 / FR-004 (#803): the key is in the URL, and a runtime's fetch error
  // may quote it. Each mock fails like a real transport AND quotes the URL; no
  // log line (message or exception) and no RefreshResult may carry the key.
  test.each(["timeout", "mid-body reset", "redirect loop"])(
    "a forced %s never leaks the key or a 22-char part to a log or the result",
    async (failure) => {
      const logger = new CapturingLogger();
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = urlOf(input);
        if (failure === "timeout") {
          const err = new Error(`The operation was aborted while fetching ${url}`);
          err.name = "AbortError";
          return Promise.reject(err);
        }
        if (failure === "redirect loop") {
          return Promise.reject(
            new TypeError(`error sending request for url (${url}): too many redirects`),
          );
        }
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"p":{"s":"partial'));
            controller.error(new TypeError(`error reading a body from connection: ${url}`));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      const client = new ConfeatureClient(NEW_KEY, PollingMode.ManualPoll, {
        offline: false,
        cache: "memory",
        logger,
      });
      const result = await client.forceRefreshAsync();
      expect(result.isSuccess).toBe(false);
      const texts = [
        String(result.errorMessage),
        textOf(result.errorException),
        ...logger.entries.map((e) => `${e.message} ${textOf(e.exception)}`),
      ];
      for (const text of texts) {
        for (const secret of [NEW_KEY, SEGMENT_A, SEGMENT_B]) expect(text).not.toContain(secret);
      }
      client.dispose();
    },
  );

  test("failure logs never carry the raw key nor either secret segment", async () => {
    const logger = new CapturingLogger();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const client = new ConfeatureClient(NEW_KEY, PollingMode.ManualPoll, {
      offline: false,
      cache: "memory",
      logger,
    });
    await client.forceRefreshAsync();
    expect(logger.entries.length).toBeGreaterThan(0);
    for (const entry of logger.entries) {
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(NEW_KEY);
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SEGMENT_A);
      expect(`${entry.message} ${textOf(entry.exception)}`).not.toContain(SEGMENT_B);
    }
    client.dispose();
  });
});
