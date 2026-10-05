// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ConfigCatClient, disposeAllClients } from "../../src/client.ts";
import type { FormattableLogMessage, IConfigCatLogger, LogLevel } from "@confeature/sdk-shared";
import { SdkErrorCode } from "../../src/types.ts";

import goodPayload from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.boolean.json" with { type: "json" };
import malformedPayload from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.malformed.json" with { type: "json" };
import keyShapes from "@confeature/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json" with { type: "json" };

const VALID_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const INVALID_KEY = "not-a-valid-sdk-key";
const BASE_URL = "https://cdn.example.test";

interface CapturedLine {
  level: LogLevel;
  eventId: number | string;
  message: string;
  exception?: unknown;
}

function captureLogger(): { logger: IConfigCatLogger; eventIds: () => string[] } {
  const lines: CapturedLine[] = [];
  const logger: IConfigCatLogger = {
    level: 4 as LogLevel, // Debug — capture everything
    eol: "\n",
    log(
      level: LogLevel,
      eventId: number | string,
      message: string | FormattableLogMessage,
      exception?: unknown,
    ): void {
      lines.push({
        level,
        eventId,
        message: typeof message === "string" ? message : message.toString(),
        exception,
      });
    },
  };
  return {
    logger,
    eventIds: () => lines.map((l) => String(l.eventId)),
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  disposeAllClients();
  vi.unstubAllGlobals();
});

describe("Fail-closed contract (US3) — every pathological input returns default + no throw", () => {
  test("invalid SDK key format → default + INVALID_SDK_KEY log; no throw", async () => {
    const sink = captureLogger();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const client = new ConfigCatClient(INVALID_KEY, 0, {
      baseUrl: BASE_URL,
      logger: sink.logger,
    });
    await client.waitForReady();
    const value = await client.getValueAsync("feature.x", false);
    expect(value).toBe(false);
    expect(sink.eventIds()).toContain(SdkErrorCode.INVALID_SDK_KEY);
    client.dispose();
  });

  // #802: every shape the shared list calls valid (ConfigCat-shaped +
  // legacy) passes the construction-time format check; every invalid one
  // is flagged — the counter-check that keeps the first assertion honest.
  test.each(keyShapes.valid.map((c) => [c.name, c.key]))(
    "valid SDK key shape (%s) → no INVALID_SDK_KEY log",
    async (_name, key) => {
      const sink = captureLogger();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(goodPayload))));
      const client = new ConfigCatClient(key, 0, { baseUrl: BASE_URL, logger: sink.logger });
      await client.waitForReady();
      expect(sink.eventIds()).not.toContain(SdkErrorCode.INVALID_SDK_KEY);
      client.dispose();
    },
  );

  test.each(keyShapes.invalid.map((c) => [c.name, c.key]))(
    "invalid SDK key shape (%s) → INVALID_SDK_KEY log",
    async (_name, key) => {
      const sink = captureLogger();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(goodPayload))));
      const client = new ConfigCatClient(key, 0, { baseUrl: BASE_URL, logger: sink.logger });
      await client.waitForReady();
      expect(sink.eventIds()).toContain(SdkErrorCode.INVALID_SDK_KEY);
      client.dispose();
    },
  );

  test("fetch throws synchronously → default + FETCH_FAILED log", async () => {
    const sink = captureLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("sync boom");
      }),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, {
      baseUrl: BASE_URL,
      logger: sink.logger,
    });
    await client.waitForReady();
    const value = await client.getValueAsync("feature.x", false);
    expect(value).toBe(false);
    expect(sink.eventIds()).toContain(SdkErrorCode.FETCH_FAILED);
    client.dispose();
  });

  test("fetch rejects (network error) → default + FETCH_FAILED log", async () => {
    const sink = captureLogger();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = new ConfigCatClient(VALID_KEY, 0, {
      baseUrl: BASE_URL,
      logger: sink.logger,
    });
    await client.waitForReady();
    const value = await client.getValueAsync("feature.x", false);
    expect(value).toBe(false);
    expect(sink.eventIds()).toContain(SdkErrorCode.FETCH_FAILED);
    client.dispose();
  });

  test("non-JSON response body → default + PARSE_FAILED log", async () => {
    const sink = captureLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, {
      baseUrl: BASE_URL,
      logger: sink.logger,
    });
    await client.waitForReady();
    const value = await client.getValueAsync("feature.x", false);
    expect(value).toBe(false);
    expect(sink.eventIds()).toContain(SdkErrorCode.PARSE_FAILED);
    client.dispose();
  });

  test("valid JSON but wrong shape (top-level array) → default + PARSE_FAILED log", async () => {
    const sink = captureLogger();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(malformedPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, {
      baseUrl: BASE_URL,
      logger: sink.logger,
    });
    await client.waitForReady();
    const value = await client.getValueAsync("feature.x", false);
    expect(value).toBe(false);
    expect(sink.eventIds()).toContain(SdkErrorCode.PARSE_FAILED);
    client.dispose();
  });

  test("getValueAsync called before first fetch completes → default, no block", async () => {
    // Fetch is a promise that never resolves on this turn — but the
    // eval call must NOT wait for it.
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, { baseUrl: BASE_URL });
    // Note: deliberately NOT awaiting waitForReady() — we want to race
    // the eval against the in-flight fetch.
    const value = await client.getValueAsync("feature.x", true);
    expect(value).toBe(true);
    // Release the fetch so dispose can proceed cleanly.
    resolveFetch(
      new Response(JSON.stringify(goodPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    client.dispose();
  });

  test("getValueAsync called after dispose() → default, no throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(goodPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, { baseUrl: BASE_URL });
    await client.waitForReady();
    client.dispose();
    const value = await client.getValueAsync("feature.dark-mode", false);
    expect(value).toBe(false);
  });

  test("previous-good config preserved after a malformed-payload poll", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify(goodPayload), {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: '"e1"' },
          });
        }
        return new Response(JSON.stringify(malformedPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const client = new ConfigCatClient(VALID_KEY, 0, { baseUrl: BASE_URL });
    await client.waitForReady();
    expect(await client.getValueAsync("feature.dark-mode", false)).toBe(true);
    // Force the malformed poll — must NOT replace the cache.
    const r = await client.forceRefreshAsync();
    expect(r.isSuccess).toBe(false);
    // Cache preserved.
    expect(await client.getValueAsync("feature.dark-mode", false)).toBe(true);
    client.dispose();
  });
});
