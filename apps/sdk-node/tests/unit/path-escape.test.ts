// SPDX-License-Identifier: MIT

/**
 * #803 FR-001 — a malformed key is escaped into ONE path segment with Go's
 * `url.PathEscape`, exactly. Every expected value below is a LITERAL printed
 * by Go 1.x `net/url.PathEscape` — never built with the library call the code
 * uses, so a drift towards `encodeURIComponent` cannot pass by construction.
 *
 * A key with no UTF-8 encoding (a lone surrogate) must be refused —
 * INVALID_SDK_KEY, no request — and `fetchAsync` must resolve, never reject
 * with a `URIError`.
 *
 * sdk-node builds its URL with `@confeature/sdk-shared`'s `buildConfigUrl`
 * (the federation's one builder). Every case here goes through node's own
 * `HttpConfigFetcher` and asserts the URL it hands to `fetch`, so it pins
 * the shared builder AS NODE USES IT.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { LoggerWrapper, LogLevel } from "@confeature/sdk-shared";

import { HttpConfigFetcher } from "../../src/config-fetcher.ts";
import { SdkErrorCode } from "../../src/types.ts";
import { CONFEATURE_SDK_VERSION } from "../../src/version.ts";

const BASE = "https://cdn.example.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs node's fetcher on `key`; returns the fetch spy, the outcome and the logged event ids. */
async function fetchWith(key: string) {
  const spy = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response("{}", { status: 500 })),
  );
  vi.stubGlobal("fetch", spy);
  const events: string[] = [];
  const logger = new LoggerWrapper({
    level: LogLevel.Debug,
    log: (_level, eventId) => {
      events.push(String(eventId));
    },
  });
  const outcome = await new HttpConfigFetcher(BASE, logger).fetchAsync(
    key,
    null,
    new AbortController().signal,
  );
  return { spy, outcome, events };
}

describe("a malformed key lands in node's request URL as Go url.PathEscape's one segment", () => {
  // Literal Go output: `fmt.Printf("%q", url.PathEscape(s))`.
  test.each([
    ["bad key$&+:=@,;!'()*~/x?y#z%..", "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25.."],
    // Pass-2 corpus key (2-, 3- and 4-byte UTF-8; 😀 is a UTF-16 surrogate pair).
    [
      "bad key$&+:=@,;!'()*~/x?y#z%é€😀..",
      "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25%C3%A9%E2%82%AC%F0%9F%98%80..",
    ],
    ["clé-ü€😀", "cl%C3%A9-%C3%BC%E2%82%AC%F0%9F%98%80"],
    ["%24%2B", "%2524%252B"],
    ["configcat-sdk-1/short", "configcat-sdk-1%2Fshort"],
    ['a"<>\\^`{|}[]', "a%22%3C%3E%5C%5E%60%7B%7C%7D%5B%5D"],
  ])("%j", async (key, goSegment) => {
    const { spy } = await fetchWith(key);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(
      `${BASE}/configuration-files/${goSegment}/config_v6.json?sdk=${CONFEATURE_SDK_VERSION}`,
    );
  });
});

describe("a key no segment can hold is refused, never thrown", () => {
  test.each([
    ["empty key", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["lone high surrogate", "\uD800"],
    ["lone low surrogate inside a key", "bad\uDC00key"],
    ["configcat-shaped with a lone surrogate", "configcat-sdk-1/\uD83DFAKEfixtureKeyNotRea0/x"],
  ])("%s → INVALID_SDK_KEY, no request", async (_name, key) => {
    const { spy, outcome, events } = await fetchWith(key);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "failed",
      errorCode: SdkErrorCode.INVALID_SDK_KEY,
      errorMessage: "SDK key cannot be sent in a request path; no request was made.",
    });
    expect(events).toEqual([SdkErrorCode.INVALID_SDK_KEY]);
  });
});
