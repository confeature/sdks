// SPDX-License-Identifier: MIT

/**
 * #803 FR-002 / FR-004 — the SDK key now travels raw in the request path, so a
 * transport error that quotes the URL would carry it. Each failure below is
 * forced — a timeout, a reset mid-body, a redirect loop — and the full key and
 * each of its 22-character parts must appear in no log line (message, exception,
 * `clientError` hook) and nowhere in the fetch result.
 *
 * Tiers:
 *   - a real `node:http` server, so Node's own `fetch` (undici) produces the
 *     errors a customer would actually hit;
 *   - a mocked `fetch` whose errors QUOTE the URL (Ktor/reqwest-style wording),
 *     so the test bites even though undici's current wording happens to be
 *     key-free: only the fixed reason codes may travel on;
 *   - the last-resort catches that the fetcher contract otherwise rules out —
 *     the client's `forceRefreshAsync` and the AutoPoll loop's `poll()` — each
 *     handed an error quoting the keyed URL, which neither may forward.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  type FormattableLogMessage,
  type IConfigCatLogger,
  LoggerWrapper,
  LogLevel,
  type RefreshResult,
  SdkErrorCode,
} from "@confeature/sdk-shared";
import keyShapes from "@confeature/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json" with { type: "json" };

import { AutoPollConfigService } from "../../src/auto-poll-service.ts";
import { ConfigCatClient, disposeAllClients } from "../../src/client.ts";
import { HttpConfigFetcher, type FetchOutcome } from "../../src/config-fetcher.ts";

const VALID_KEYS = keyShapes.valid.map((c) => c.key);
const CONFIGCAT_KEY = VALID_KEYS.find((k) => k.startsWith("configcat-sdk-1/"))!;

/** The secrets that must not leak: the key itself and every 22-char part. */
function secretsOf(key: string): string[] {
  return [key, ...key.split("/").filter((part) => part.length === 22)];
}

/** Every string reachable from a value: messages, stacks, causes, fields. */
function textsOf(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.toString(), value.message, value.stack ?? "");
    out.push(...textsOf(value.cause, seen));
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    out.push(...textsOf((value as Record<string, unknown>)[name], seen));
  }
  return out;
}

function expectKeyFree(key: string, what: string, values: unknown[]): void {
  const texts = values.flatMap((v) => textsOf(v));
  for (const secret of secretsOf(key)) {
    const leaks = texts.filter((t) => t.includes(secret));
    expect(leaks, `${what}: leaks ${secret.length}-char secret`).toEqual([]);
  }
}

interface Sink {
  logger: IConfigCatLogger;
  lines: Array<{ eventId: string; message: string; exception?: unknown }>;
}

function captureLogger(): Sink {
  const lines: Sink["lines"] = [];
  return {
    lines,
    logger: {
      level: LogLevel.Debug,
      log(
        _level: LogLevel,
        eventId: number | string,
        message: string | FormattableLogMessage,
        exception?: unknown,
      ): void {
        lines.push({ eventId: String(eventId), message: message.toString(), exception });
      },
    },
  };
}

// ---- Tier 1: a real server, Node's real fetch -----------------------------

type Mode = "hang" | "reset-mid-body" | "redirect-loop";

/** A key no case uses: the path a stale request from another case carries. */
const STALE_KEY = "configcat-sdk-1/STALESTALESTALESTALEST/STALESTALESTALESTALEST";

let server: Server;
let baseUrl = "";
let mode: Mode = "hang";
const seenPaths: string[] = [];
const hung: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenPaths.push(req.url ?? "");
    switch (mode) {
      case "hang":
        hung.push(res); // never answers; the SDK's own timeout must end it
        return;
      case "reset-mid-body":
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
        res.write('{"p":{"s":"partial');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      case "redirect-loop":
        // Back to the very URL — key included — until fetch gives up.
        res.writeHead(302, { Location: req.url ?? "/" });
        res.end();
        return;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  for (const res of hung) res.socket?.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  disposeAllClients();
  vi.unstubAllGlobals();
  seenPaths.length = 0;
});

describe("forced transport failures leak no SDK key (real fetch)", () => {
  const cases: Array<[Mode, string | null]> = [
    ["hang", null],
    ["reset-mid-body", "connection_reset"],
    ["redirect-loop", "redirect_loop"],
  ];

  for (const key of VALID_KEYS) {
    for (const [forced, reason] of cases) {
      test(`${forced} — ${key.slice(0, 16)}…`, async () => {
        mode = forced;
        // A previous case's late request — a redirect-loop hop landing after
        // afterEach cleared the list — would sit at seenPaths[0] (#866). Seed
        // one deterministically, so reading index 0 always fails, never only
        // under load: the request that counts is this key's own.
        seenPaths.push(`/configuration-files/${STALE_KEY}/config_v6.json`);
        const sink = captureLogger();
        const hookErrors: unknown[] = [];
        const client = new ConfigCatClient(key, 0, {
          baseUrl,
          logger: sink.logger,
          requestTimeoutMs: 300,
          setupHooks: (hooks) => hooks.on("clientError", (...args) => hookErrors.push(args)),
        });
        await client.waitForReady();
        const refresh = await client.forceRefreshAsync();

        // The failure really happened, and on the raw path (FR-001).
        expect(refresh.isSuccess).toBe(false);
        const own = seenPaths
          .map((p) => new URL(p, baseUrl).pathname)
          .filter((p) => p !== `/configuration-files/${STALE_KEY}/config_v6.json`);
        expect(own.length).toBeGreaterThan(0);
        for (const path of own) expect(path).toBe(`/configuration-files/${key}/config_v6.json`);
        if (reason !== null) {
          expect(refresh.errorMessage).toContain(reason);
          expect(sink.lines.map((l) => l.message).join("\n")).toContain(reason);
        }

        expectKeyFree(key, "log lines", sink.lines);
        expectKeyFree(key, "clientError hook", hookErrors);
        // ConfigCat's shape: an errorException is present — a key-free Error (#803).
        expect(refresh.errorException).toBeInstanceOf(Error);
        expect((refresh.errorException as Error).message).toBe(refresh.errorMessage);
        expectKeyFree(key, "RefreshResult", [
          refresh,
          refresh.errorMessage,
          refresh.errorException,
        ]);

        // The fetcher's own result, the layer below the client.
        const outcome = await new HttpConfigFetcher(
          baseUrl,
          new LoggerWrapper(sink.logger),
        ).fetchAsync(key, null, AbortSignal.timeout(300));
        expect(outcome.status).toBe("failed");
        expectKeyFree(key, "FetchOutcome", [outcome]);
        expectKeyFree(key, "log lines (fetcher)", sink.lines);

        client.dispose();
      });
    }
  }
});

// ---- Tier 2: a mocked fetch whose errors quote the URL --------------------

/** Tier 2 adds an error no classifier rule knows: the fallback branch. */
type MockMode = Mode | "unclassified";

function urlQuotingFailure(forced: MockMode, url: string): Promise<Response> {
  switch (forced) {
    case "hang": {
      const err = new Error(`Request timeout has expired [url=${url}, request_timeout=300 ms]`);
      err.name = "AbortError";
      return Promise.reject(err);
    }
    case "reset-mid-body": {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"p":{"s":"partial'));
          const cause = Object.assign(new Error(`other side closed while reading ${url}`), {
            code: "UND_ERR_SOCKET",
          });
          controller.error(new TypeError(`terminated: ${url}`, { cause }));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    case "redirect-loop":
      return Promise.reject(
        new TypeError(`error following redirect for url (${url})`, {
          cause: new Error(`redirect count exceeded at ${url}`),
        }),
      );
    case "unclassified":
      // Matches no known code or message: classifyFetchError's fallback.
      // Both layers quote the URL, and the cause's `code` does too.
      return Promise.reject(
        new TypeError(`fetch failed for ${url}`, {
          cause: Object.assign(new Error(`proxy refused ${url}`), {
            code: `E_PROXY ${url}`,
            url,
          }),
        }),
      );
  }
}

describe("a URL-quoting library error never reaches a log or a result (mocked fetch)", () => {
  const cases: Array<[MockMode, string, string]> = [
    ["hang", "FETCH_TIMEOUT", "aborted"],
    ["reset-mid-body", "FETCH_FAILED", "connection_reset"],
    ["redirect-loop", "FETCH_FAILED", "redirect_loop"],
    ["unclassified", "FETCH_FAILED", "network_error"],
  ];

  for (const [forced, errorCode, reason] of cases) {
    test(`${forced} → ${errorCode}, fixed reason only`, async () => {
      const fetchSpy = vi.fn((url: string) => urlQuotingFailure(forced, url));
      vi.stubGlobal("fetch", fetchSpy);
      const sink = captureLogger();

      const outcome: FetchOutcome = await new HttpConfigFetcher(
        "https://cdn.example.test",
        new LoggerWrapper(sink.logger),
      ).fetchAsync(CONFIGCAT_KEY, null, new AbortController().signal);

      // The mock really quoted the key — otherwise this test proves nothing.
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(CONFIGCAT_KEY);
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.errorCode).toBe(errorCode);
        if (forced !== "hang") expect(outcome.errorMessage).toContain(reason);
        if (forced === "unclassified") {
          expect(outcome.errorMessage).toBe("Network error while fetching config (network_error).");
        }
      }
      if (forced !== "hang") {
        // The fixed reason reached the log, and no exception rode along.
        expect(sink.lines.map((l) => l.message).join("\n")).toContain(reason);
        expect(sink.lines.map((l) => l.exception)).toEqual(sink.lines.map(() => undefined));
      }
      expectKeyFree(CONFIGCAT_KEY, "FetchOutcome", [outcome]);
      expectKeyFree(CONFIGCAT_KEY, "log lines", sink.lines);
    });

    test(`${forced} through the client → RefreshResult + logs + hooks key-free`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => urlQuotingFailure(forced, url)),
      );
      const sink = captureLogger();
      const hookErrors: unknown[] = [];
      const client = new ConfigCatClient(CONFIGCAT_KEY, 0, {
        baseUrl: "https://cdn.example.test",
        logger: sink.logger,
        setupHooks: (hooks) => hooks.on("clientError", (...args) => hookErrors.push(args)),
      });
      await client.waitForReady();
      const refresh = await client.forceRefreshAsync();

      expect(refresh.isSuccess).toBe(false);
      expectKeyFree(CONFIGCAT_KEY, "log lines", sink.lines);
      expectKeyFree(CONFIGCAT_KEY, "clientError hook", hookErrors);
      expectKeyFree(CONFIGCAT_KEY, "RefreshResult", [refresh]);
      client.dispose();
    });
  }
});

// ---- Tier 3: the client's own last-resort catch ---------------------------

describe("forceRefreshAsync's last-resort catch drops the thrown error (#803 FR-002)", () => {
  test("a refresh that throws a URL-quoting error → fixed, key-free RefreshResult + log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response('{"f":{}}', { status: 200 }))),
    );
    const sink = captureLogger();
    const hookErrors: unknown[] = [];
    // ManualPoll (2): no fetch until forceRefreshAsync.
    const client = new ConfigCatClient(CONFIGCAT_KEY, 2, {
      baseUrl: "https://cdn.example.test",
      logger: sink.logger,
      setupHooks: (hooks) => hooks.on("clientError", (...args) => hookErrors.push(args)),
    });
    // Force the path the fetcher contract otherwise rules out: the config
    // service itself rejects, with a library-style error quoting the URL.
    const url = `https://cdn.example.test/configuration-files/${CONFIGCAT_KEY}/config_v6.json`;
    const thrown = new TypeError(`fetch failed for ${url}`, {
      cause: Object.assign(new Error(`proxy refused ${url}`), { url }),
    });
    const service = (client as unknown as { service: { forceRefreshAsync: () => unknown } })
      .service;
    service.forceRefreshAsync = () => Promise.reject(thrown);

    const refresh = await client.forceRefreshAsync();

    expect(refresh.isSuccess).toBe(false);
    expect(refresh.errorMessage).toBe("Unexpected refresh error.");
    // ConfigCat's shape: an errorException is present — a NEW key-free Error,
    // never the caught one or anything chained to it.
    expect(refresh.errorException).toBeInstanceOf(Error);
    expect(refresh.errorException).not.toBe(thrown);
    expect((refresh.errorException as Error).message).toBe("Unexpected refresh error.");
    expect((refresh.errorException as Error).cause).toBeUndefined();
    expectKeyFree(CONFIGCAT_KEY, "RefreshResult", [
      refresh,
      refresh.errorMessage,
      refresh.errorException,
    ]);

    // The fixed reason was logged, with no exception riding along.
    const refreshLines = sink.lines.filter((l) => l.message.includes("refresh-throw"));
    expect(refreshLines).toHaveLength(1);
    expect(refreshLines[0]!.exception).toBeUndefined();
    expectKeyFree(CONFIGCAT_KEY, "log lines", sink.lines);
    expectKeyFree(CONFIGCAT_KEY, "clientError hook", hookErrors);
    client.dispose();
  });
});

// ---- Tier 4: the AutoPoll loop's own catch --------------------------------

describe("the AutoPoll loop's poll() catch drops the thrown error (#803 FR-002)", () => {
  test("a refresh that throws a URL-quoting error → fixed, key-free log + clientError", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{"f":{}}', { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);
    const sink = captureLogger();
    const hookErrors: unknown[] = [];
    const url = `https://cdn.example.test/configuration-files/${CONFIGCAT_KEY}/config_v6.json`;
    const thrown = new TypeError(`error sending request for url (${url})`, {
      cause: Object.assign(new Error(`connection reset at ${url}`), { url }),
    });
    // refreshAsync breaks its no-reject contract with a URL-quoting error, so
    // only poll()'s own catch stands between that error and the logger.
    const spy = vi
      .spyOn(
        AutoPollConfigService.prototype as unknown as {
          refreshAsync(): Promise<RefreshResult>;
        },
        "refreshAsync",
      )
      .mockRejectedValue(thrown);
    let client: ConfigCatClient | undefined;
    try {
      // AutoPoll (0) kicks poll() from the service constructor.
      client = new ConfigCatClient(CONFIGCAT_KEY, 0, {
        baseUrl: "https://cdn.example.test",
        logger: sink.logger,
        setupHooks: (hooks) => hooks.on("clientError", (...args) => hookErrors.push(args)),
      });
      // Wait on ANY error line, not the expected one, so a regression that
      // forwards the raw error fails on the leak checks below.
      await vi.waitFor(() => {
        expect(sink.lines.length).toBeGreaterThan(0);
        expect(hookErrors.length).toBeGreaterThan(0);
      });

      // poll()'s catch really ran, with an error that quotes the key.
      expect(spy).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(textsOf(thrown).join("\n")).toContain(CONFIGCAT_KEY);

      // Nothing the logger or clientError received carries the key.
      expectKeyFree(CONFIGCAT_KEY, "log lines", sink.lines);
      expectKeyFree(CONFIGCAT_KEY, "clientError hook", hookErrors);
      expect(sink.lines.map((l) => l.exception)).toEqual(sink.lines.map(() => undefined));

      // Logged as a fetch failure with the fixed reason, as the refresh path is.
      const pollLines = sink.lines.filter((l) => l.message.includes("status=poll-throw"));
      expect(pollLines).toHaveLength(1);
      expect(pollLines[0]!.eventId).toBe(String(SdkErrorCode.FETCH_FAILED));
    } finally {
      // Even on a failed assertion: no AutoPoll timer may outlive the test.
      client?.dispose();
      spy.mockRestore();
    }
  });
});

// ---- Tier 5: the client's evaluation-side catches (#841) ------------------

/**
 * #841 — the nine `catch` blocks that guard the client's public surface once
 * forwarded the caught error to `logger.evalError(...)`, and through it to the
 * `clientError` hook. None of them can receive a URL-quoting error today (the
 * guarded calls are cache reads and pure evaluation; LazyLoad and ManualPoll
 * are routed to AutoPoll, whose fetch errors are dropped in the service), so
 * each is forced here: the guarded call throws an error quoting the keyed URL,
 * and neither the log line, its `exception` argument, the hook nor the
 * returned value may carry it.
 */
describe("the client's evaluation-side catches drop the thrown error (#841)", () => {
  type Service = Record<string, unknown>;
  interface Site {
    /** The catch under test. */
    name: string;
    /** Name of the service method that throws, or null for `setupHooks`. */
    throwingMethod: string | null;
    /** Drives the client into that catch; returns what the caller sees. */
    call: (client: ConfigCatClient) => unknown;
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

  const modes: Array<[string, 1 | 2]> = [
    ["LazyLoad", 1],
    ["ManualPoll", 2],
  ];

  for (const site of sites) {
    for (const [modeName, pollingMode] of modes) {
      test(`${site.name} (${modeName}) → fixed, key-free log + clientError + result`, async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.resolve(new Response('{"f":{}}', { status: 200 }))),
        );
        const sink = captureLogger();
        const hookErrors: unknown[] = [];
        const url = `https://cdn.example.test/configuration-files/${CONFIGCAT_KEY}/config_v6.json`;
        const thrown = new TypeError(`error sending request for url (${url})`, {
          cause: Object.assign(new Error(`connection reset at ${url}`), { url }),
        });
        let throws = 0;
        const raise = (): never => {
          throws += 1;
          throw thrown;
        };

        const client = new ConfigCatClient(CONFIGCAT_KEY, pollingMode, {
          baseUrl: "https://cdn.example.test",
          logger: sink.logger,
          setupHooks: (hooks) => {
            hooks.on("clientError", (...args) => hookErrors.push(args));
            if (site.throwingMethod === null) raise();
          },
        });
        const service = (client as unknown as { service: Service }).service;
        const realDispose = (service.dispose as () => void).bind(service);
        if (site.throwingMethod !== null) service[site.throwingMethod] = raise;
        try {
          const result = await site.call(client);

          // The catch really ran, with an error that quotes the key.
          expect(throws).toBe(1);
          expect(textsOf(thrown).join("\n")).toContain(CONFIGCAT_KEY);
          const evalLines = sink.lines.filter((l) => l.eventId === SdkErrorCode.EVAL_FAILED);
          expect(evalLines).toHaveLength(1);
          expect(hookErrors.length).toBeGreaterThan(0);

          // A fixed message, no exception riding along, nothing keyed anywhere.
          expect(evalLines[0]!.exception).toBeUndefined();
          expectKeyFree(CONFIGCAT_KEY, "log lines", sink.lines);
          expectKeyFree(CONFIGCAT_KEY, "clientError hook", hookErrors);
          expectKeyFree(CONFIGCAT_KEY, "returned value", [result]);
          if (site.name === "getValueDetailsAsync") {
            // ConfigCat's shape keeps an errorException — a NEW key-free Error.
            const details = result as { errorMessage?: string; errorException?: unknown };
            expect(details.errorException).toBeInstanceOf(Error);
            expect(details.errorException).not.toBe(thrown);
            expect((details.errorException as Error).message).toBe(details.errorMessage);
          }
        } finally {
          // Even when dispose() is the site under test: no timer may outlive it.
          service.dispose = realDispose;
          client.dispose();
          realDispose();
        }
      });
    }
  }
});
