// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LoggerWrapper, LogLevel } from "@confeature/sdk-shared";
import keyShapes from "@confeature/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json" with { type: "json" };

import { ConfigCatClient, disposeAllClients } from "../../src/client.ts";
import { HttpConfigFetcher } from "../../src/config-fetcher.ts";
import { SdkErrorCode } from "../../src/types.ts";
import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE_URL = "https://cdn.example.test";

function jsonResponse(body: unknown, init: ResponseInit & { etag?: string } = {}): Response {
  const headers = new Headers(init.headers ?? {});
  if (init.etag) headers.set("ETag", init.etag);
  headers.set("Content-Type", "application/json");
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

/** The path as sent — still percent-encoded, query excluded. */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

async function fetchOnce(key: string): Promise<void> {
  const logger = new LoggerWrapper({ level: LogLevel.Off, log: () => {} });
  await new HttpConfigFetcher(BASE_URL, logger).fetchAsync(key, null, new AbortController().signal);
}

const VALID_PAYLOAD = {
  p: { u: BASE_URL, r: 0, s: "v1" },
  f: { "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] } },
  s: [],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  disposeAllClients();
  vi.unstubAllGlobals();
});

describe("URL + headers contract", () => {
  test("first fetch uses <baseUrl>/configuration-files/<sdkKey>/config_v6.json?sdk=<version>", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD, { etag: '"e1"' }));
    vi.stubGlobal("fetch", spy);

    const client = new ConfigCatClient(SDK_KEY, 0, { baseUrl: BASE_URL });
    await client.waitForReady();

    expect(spy).toHaveBeenCalled();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toBe(
      `${BASE_URL}/configuration-files/${SDK_KEY}/config_v6.json?sdk=${CONFEATURE_SDK_VERSION}`,
    );

    client.dispose();
  });

  // #803 FR-001/FR-004: the PARSED path is compared, never the full URL
  // string, so a later query change (#807) cannot break these pins.
  test.each(keyShapes.valid.map((c) => [c.name, c.key]))(
    "a well-shaped key (%s) travels RAW, as configcat-common sends it — no /v2/, no escaping, no hash",
    async (_name, key) => {
      const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD, { etag: '"e1"' }));
      vi.stubGlobal("fetch", spy);

      const client = new ConfigCatClient(key, 0, { baseUrl: BASE_URL });
      await client.waitForReady();

      const url = String(spy.mock.calls[0]?.[0]);
      expect(pathOf(url)).toBe(`/configuration-files/${key}/config_v6.json`);
      expect(new URL(url).searchParams.get("sdk")).toBe(CONFEATURE_SDK_VERSION);

      client.dispose();
    },
  );

  test("a ConfigCat-shaped key keeps its three parts as three path segments", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD));
    vi.stubGlobal("fetch", spy);
    const key = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";

    await fetchOnce(key);

    const segments = pathOf(String(spy.mock.calls[0]?.[0])).split("/");
    expect(segments).toEqual([
      "",
      "configuration-files",
      "configcat-sdk-1",
      "FAKEfixtureKeyNotRea01",
      "FAKEfixtureKeyNotRea02",
      "config_v6.json",
    ]);
  });

  test.each(keyShapes.invalid.filter((c) => c.key !== "").map((c) => [c.name, c.key]))(
    "a malformed key (%s) is escaped into ONE path segment",
    async (_name, key) => {
      const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD));
      vi.stubGlobal("fetch", spy);

      await fetchOnce(key);

      expect(spy).toHaveBeenCalledOnce();
      const path = pathOf(String(spy.mock.calls[0]?.[0]));
      const prefix = "/configuration-files/";
      const suffix = "/config_v6.json";
      expect(path.startsWith(prefix) && path.endsWith(suffix)).toBe(true);
      const segment = path.slice(prefix.length, -suffix.length);
      expect(segment).not.toContain("/");
      expect(decodeURIComponent(segment)).toBe(key);
    },
  );

  test.each([
    ["empty", ""],
    ["dot", "."],
    ["dot-dot", ".."],
  ])(
    "a key no escaper keeps in its segment (%s) is never fetched — INVALID_SDK_KEY",
    async (_name, key) => {
      const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD));
      vi.stubGlobal("fetch", spy);
      const events: string[] = [];
      const logger = new LoggerWrapper({
        level: LogLevel.Debug,
        log: (_level, eventId) => {
          events.push(String(eventId));
        },
      });

      const outcome = await new HttpConfigFetcher(BASE_URL, logger).fetchAsync(
        key,
        null,
        new AbortController().signal,
      );

      expect(spy).not.toHaveBeenCalled();
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.errorCode).toBe(SdkErrorCode.INVALID_SDK_KEY);
      }
      expect(events).toEqual([SdkErrorCode.INVALID_SDK_KEY]);
    },
  );

  test("follow-up fetch (after 304) sends If-None-Match with the cached ETag", async () => {
    let call = 0;
    const spy = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse(VALID_PAYLOAD, { etag: '"e1"' });
      return new Response(null, { status: 304, headers: { ETag: '"e1"' } });
    });
    vi.stubGlobal("fetch", spy);

    const client = new ConfigCatClient(SDK_KEY, 0, { baseUrl: BASE_URL });
    await client.waitForReady();
    // Force a second fetch — this should be the one that carries
    // If-None-Match.
    await client.forceRefreshAsync();

    expect(spy).toHaveBeenCalledTimes(2);
    const calls = spy.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const secondCallInit = calls[1]?.[1];
    expect(secondCallInit).toBeDefined();
    const headers = secondCallInit?.headers as Record<string, string> | undefined;
    expect(headers?.["If-None-Match"]).toBe('"e1"');
    client.dispose();
  });

  test("trailing slash on baseUrl is stripped (no double-slash in path)", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(VALID_PAYLOAD, { etag: '"e1"' }));
    vi.stubGlobal("fetch", spy);
    const client = new ConfigCatClient(SDK_KEY, 0, { baseUrl: `${BASE_URL}/` });
    await client.waitForReady();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url.startsWith(`${BASE_URL}/configuration-files/`)).toBe(true);
    expect(url.includes("//configuration-files/")).toBe(false);
    client.dispose();
  });
});
