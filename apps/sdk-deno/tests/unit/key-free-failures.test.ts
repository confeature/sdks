// SPDX-License-Identifier: MIT

/**
 * #803 FR-002 — the SDK key travels raw in the request path, so an error a
 * fetcher throws may quote the URL. The poll service's defensive catch MUST
 * drop that error: the log line, its `exception` argument, the `clientError`
 * callback and the `RefreshResult` carry only the fixed reason. The thrown
 * error below quotes the key in its message AND its cause chain, so forwarding
 * it anywhere fails this test. The client's own `forceRefreshAsync` catch and
 * the AutoPoll loop's `poll()` catch are held to the same rule.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type FetchOutcome,
  type IConfigCatLogger,
  type IConfigFetcher,
  LoggerWrapper,
  LogLevel,
  type RefreshResult,
  SdkErrorCode,
} from "@confeature/sdk-shared";

import { DenoFileConfigCache } from "../../src/deno-file-cache.ts";
import { ConfeatureClient } from "../../src/client.ts";
import { Hooks } from "../../src/hooks.ts";
import { PollingMode, type ResolvedOptions } from "../../src/options.ts";
import { ConfigPollService } from "../../src/poll-service.ts";

const KEY = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";
const SECRETS = [KEY, ...KEY.split("/").filter((part) => part.length === 22)];
const CACHE_KEY = "confeature:cache:v1:abc12345abc12345abc12345abc12345";
const URL_WITH_KEY = `https://cdn.example.test/configuration-files/${KEY}/config_v6.json`;

const OPTIONS: ResolvedOptions = {
  baseUrl: "https://cdn.example.test",
  requestTimeoutMs: 5000,
  pollIntervalMs: 60_000,
  cacheTtlMs: 60_000,
  maxInitWaitTimeMs: 0,
  offline: false,
  defaultUser: undefined,
  flagOverrides: undefined,
  cacheKind: "memory",
};

/** Every string a value can carry: toString, message, stack, cause chain, fields. */
function textsOf(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.toString(), value.message, value.stack ?? "", ...textsOf(value.cause, seen));
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    out.push(...textsOf((value as Record<string, unknown>)[name], seen));
  }
  return out;
}

/** A custom fetcher that breaks the no-reject contract with a URL-quoting error. */
class ThrowingFetcher implements IConfigFetcher {
  public thrown: Error | null = null;
  fetchAsync(): Promise<FetchOutcome> {
    this.thrown = new TypeError(`error sending request for url (${URL_WITH_KEY})`, {
      cause: new Error(`connection reset at ${URL_WITH_KEY}`),
    });
    return Promise.reject(this.thrown);
  }
}

let service: ConfigPollService | null = null;

afterEach(() => {
  service?.dispose();
  service = null;
});

describe("a throwing fetcher leaks no SDK key (FR-002, #803)", () => {
  test("log line + exception argument + clientError + RefreshResult are key-free", async () => {
    const lines: Array<{ eventId: string; message: string; exception: unknown }> = [];
    const clientErrors: unknown[] = [];
    const sink: IConfigCatLogger = {
      level: LogLevel.Debug,
      log: (_level, eventId, message, exception) => {
        lines.push({ eventId: String(eventId), message: message.toString(), exception });
      },
    };
    const logger = new LoggerWrapper(sink, (msg, exception) => clientErrors.push(msg, exception));
    const fetcher = new ThrowingFetcher();
    service = new ConfigPollService(
      KEY,
      fetcher,
      new DenoFileConfigCache(CACHE_KEY, "memory", logger),
      OPTIONS,
      PollingMode.ManualPoll,
      logger,
      new Hooks(),
    );

    const result = await service.forceRefreshAsync();

    // The error really quoted the key — otherwise this test proves nothing.
    expect(textsOf(fetcher.thrown).join("\n")).toContain(KEY);
    expect(result.isSuccess).toBe(false);
    expect(result.errorMessage).toBe("Fetcher threw unexpectedly.");
    // ConfigCat's shape: an errorException is present — a key-free Error.
    expect(result.errorException).toBeInstanceOf(Error);
    expect(result.errorException).not.toBe(fetcher.thrown);
    expect((result.errorException as Error).message).toBe(result.errorMessage);
    // The failure was logged (with the fixed reason), so the log path ran.
    expect(lines.some((l) => l.message.includes("exception"))).toBe(true);

    const texts = [...textsOf(lines), ...textsOf(clientErrors), ...textsOf(result)];
    for (const secret of SECRETS) {
      expect(
        texts.filter((t) => t.includes(secret)),
        `leaks ${secret.length}-char secret`,
      ).toEqual([]);
    }
  });
});

describe("a throwing refresh leaks no SDK key through the client (FR-002, #803)", () => {
  test("forceRefreshAsync's catch drops the error: log, clientError and RefreshResult are key-free", async () => {
    const lines: Array<{ eventId: string; message: string; exception: unknown }> = [];
    const clientErrors: unknown[] = [];
    const sink: IConfigCatLogger = {
      level: LogLevel.Debug,
      log: (_level, eventId, message, exception) => {
        lines.push({ eventId: String(eventId), message: message.toString(), exception });
      },
    };
    const thrown = new TypeError(`error sending request for url (${URL_WITH_KEY})`, {
      cause: new Error(`connection reset at ${URL_WITH_KEY}`),
    });
    // The service breaks its no-reject contract with a URL-quoting error, so
    // only the client's own catch stands between that error and the caller.
    const spy = vi
      .spyOn(ConfigPollService.prototype, "forceRefreshAsync")
      .mockRejectedValue(thrown);
    const client = new ConfeatureClient(KEY, PollingMode.ManualPoll, {
      logger: sink,
      setupHooks: (hooks) => hooks.on("clientError", (msg, ex) => clientErrors.push(msg, ex)),
    });
    try {
      const result = await client.forceRefreshAsync();

      // The client's catch really ran with a key-quoting error.
      expect(spy).toHaveBeenCalledOnce();
      expect(textsOf(thrown).join("\n")).toContain(KEY);
      expect(result.isSuccess).toBe(false);
      expect(result.errorMessage).toBe("Unexpected refresh error.");
      // ConfigCat's shape: an errorException is present — a key-free Error.
      expect(result.errorException).toBeInstanceOf(Error);
      expect(result.errorException).not.toBe(thrown);
      expect((result.errorException as Error).message).toBe(result.errorMessage);
      // The failure was logged and reached clientError, so both paths ran.
      expect(lines.some((l) => l.message.includes("refresh-throw"))).toBe(true);
      expect(clientErrors.length).toBeGreaterThan(0);

      const texts = [...textsOf(lines), ...textsOf(clientErrors), ...textsOf(result)];
      for (const secret of SECRETS) {
        expect(
          texts.filter((t) => t.includes(secret)),
          `leaks ${secret.length}-char secret`,
        ).toEqual([]);
      }
    } finally {
      client.dispose();
      spy.mockRestore();
    }
  });
});

describe("a throwing refresh leaks no SDK key through the AutoPoll loop (FR-002, #803)", () => {
  test("poll()'s catch drops the error: log and clientError are key-free", async () => {
    const lines: Array<{ eventId: string; message: string; exception: unknown }> = [];
    const clientErrors: unknown[] = [];
    const sink: IConfigCatLogger = {
      level: LogLevel.Debug,
      log: (_level, eventId, message, exception) => {
        lines.push({ eventId: String(eventId), message: message.toString(), exception });
      },
    };
    const logger = new LoggerWrapper(sink, (msg, exception) => clientErrors.push(msg, exception));
    const thrown = new TypeError(`error sending request for url (${URL_WITH_KEY})`, {
      cause: new Error(`connection reset at ${URL_WITH_KEY}`),
    });
    // refreshAsync breaks its no-reject contract with a URL-quoting error, so
    // only poll()'s own catch stands between that error and the logger.
    const spy = vi
      .spyOn(
        ConfigPollService.prototype as unknown as { refreshAsync(): Promise<RefreshResult> },
        "refreshAsync",
      )
      .mockRejectedValue(thrown);
    try {
      // AutoPoll kicks poll() from the constructor.
      service = new ConfigPollService(
        KEY,
        new ThrowingFetcher(),
        new DenoFileConfigCache(CACHE_KEY, "memory", logger),
        OPTIONS,
        PollingMode.AutoPoll,
        logger,
        new Hooks(),
      );
      await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));

      // poll()'s catch really ran with a key-quoting error.
      expect(spy).toHaveBeenCalledOnce();
      expect(textsOf(thrown).join("\n")).toContain(KEY);
      // The failure reached clientError, so the callback path ran too.
      expect(clientErrors.length).toBeGreaterThan(0);

      const texts = [...textsOf(lines), ...textsOf(clientErrors)];
      for (const secret of SECRETS) {
        expect(
          texts.filter((t) => t.includes(secret)),
          `leaks ${secret.length}-char secret`,
        ).toEqual([]);
      }
      // Logged as a fetch failure with the fixed reason, as the refresh path is.
      expect(lines.map((l) => l.message)).toEqual([expect.stringContaining("status=poll-throw")]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * #841 — the nine `catch` blocks that guard the client's public surface once
 * forwarded the caught error to `logger.evalError(...)`, and through it to the
 * `clientError` hook. None of them can receive a URL-quoting error today (the
 * guarded calls are cache reads, pure evaluation and local lifecycle calls;
 * LazyLoad's `ensureFresh()` only starts a refresh it never awaits, and that
 * refresh drops its own fetch errors), so each is forced here: the guarded
 * call throws an error quoting the keyed URL, and neither the log line, its
 * `exception` argument, the hook nor the returned value may carry it.
 */
describe("the client's evaluation-side catches drop the thrown error (#841)", () => {
  type Service = Record<string, unknown>;
  interface Site {
    /** The catch under test. */
    name: string;
    /** Name of the service method that throws, or null for `setupHooks`. */
    throwingMethod: string | null;
    /** Drives the client into that catch; returns what the caller sees. */
    call: (client: ConfeatureClient) => unknown;
  }

  const sites: Site[] = [
    { name: "setupHooks", throwingMethod: null, call: () => undefined },
    {
      name: "getValueAsync",
      throwingMethod: "getCurrent",
      call: (c) => c.getValueAsync("flag", false),
    },
    {
      name: "getValueDetailsAsync",
      throwingMethod: "getCurrent",
      call: (c) => c.getValueDetailsAsync("flag", false),
    },
    { name: "getAllKeysAsync", throwingMethod: "getCurrent", call: (c) => c.getAllKeysAsync() },
    { name: "getAllValuesAsync", throwingMethod: "getCurrent", call: (c) => c.getAllValuesAsync() },
    {
      name: "getAllValueDetailsAsync",
      throwingMethod: "getCurrent",
      call: (c) => c.getAllValueDetailsAsync(),
    },
    {
      name: "getKeyAndValueAsync",
      throwingMethod: "getCurrent",
      call: (c) => c.getKeyAndValueAsync("v1"),
    },
    { name: "waitForReady", throwingMethod: "waitForReady", call: (c) => c.waitForReady() },
    {
      name: "dispose",
      throwingMethod: "dispose",
      call: (c) => {
        c.dispose();
        return undefined;
      },
    },
  ];

  const modes = [PollingMode.LazyLoad, PollingMode.ManualPoll] as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const site of sites) {
    for (const pollingMode of modes) {
      const modeName = pollingMode === PollingMode.LazyLoad ? "LazyLoad" : "ManualPoll";
      test(`${site.name} (${modeName}) → fixed, key-free log + clientError + result`, async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.resolve(new Response('{"f":{}}', { status: 200 }))),
        );
        const lines: Array<{ eventId: string; message: string; exception: unknown }> = [];
        const clientErrors: unknown[] = [];
        const sink: IConfigCatLogger = {
          level: LogLevel.Debug,
          log: (_level, eventId, message, exception) => {
            lines.push({ eventId: String(eventId), message: message.toString(), exception });
          },
        };
        const thrown = new TypeError(`error sending request for url (${URL_WITH_KEY})`, {
          cause: new Error(`connection reset at ${URL_WITH_KEY}`),
        });
        let throws = 0;
        const raise = (): never => {
          throws += 1;
          throw thrown;
        };

        const client = new ConfeatureClient(KEY, pollingMode, {
          baseUrl: "https://cdn.example.test",
          logger: sink,
          cache: "memory",
          setupHooks: (hooks) => {
            hooks.on("clientError", (msg, ex) => clientErrors.push(msg, ex));
            if (site.throwingMethod === null) raise();
          },
        });
        const clientService = (client as unknown as { service: Service }).service;
        const realDispose = (clientService.dispose as () => void).bind(clientService);
        if (site.throwingMethod !== null) clientService[site.throwingMethod] = raise;
        try {
          const result = await site.call(client);

          // The catch really ran, with an error that quotes the key.
          expect(throws).toBe(1);
          expect(textsOf(thrown).join("\n")).toContain(KEY);
          const evalLines = lines.filter((l) => l.eventId === SdkErrorCode.EVAL_FAILED);
          expect(evalLines).toHaveLength(1);
          expect(clientErrors.length).toBeGreaterThan(0);

          // A fixed message, no exception riding along, nothing keyed anywhere.
          expect(evalLines[0]!.exception).toBeUndefined();
          const texts = [...textsOf(lines), ...textsOf(clientErrors), ...textsOf(result)];
          for (const secret of SECRETS) {
            expect(
              texts.filter((t) => t.includes(secret)),
              `leaks ${secret.length}-char secret`,
            ).toEqual([]);
          }
          if (site.name === "getValueDetailsAsync") {
            // ConfigCat's shape keeps an errorException — a NEW key-free Error.
            const details = result as { errorMessage?: string; errorException?: unknown };
            expect(details.errorException).toBeInstanceOf(Error);
            expect(details.errorException).not.toBe(thrown);
            expect((details.errorException as Error).message).toBe(details.errorMessage);
          }
        } finally {
          // Even when dispose() is the site under test: no timer may outlive it.
          clientService.dispose = realDispose;
          client.dispose();
          realDispose();
        }
      });
    }
  }
});
