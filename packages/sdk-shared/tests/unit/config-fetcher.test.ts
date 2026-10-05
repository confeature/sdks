// SPDX-License-Identifier: MIT

/**
 * Unit tests for the shared `HttpConfigFetcher` (spec 034).
 *
 * Coverage (research §R4):
 *  - URL shape (FR-001, #803): `<baseUrl>/configuration-files/<sdkKey>/config_v6.json?sdk=<version>`,
 *    a well-shaped key raw, a malformed one in ONE segment, "" / "." / ".." refused.
 *  - Request method MUST be GET.
 *  - `If-None-Match` header is sent when an ETag is provided.
 *  - 200 path: parses + returns `{ status: "fetched", configJson, eTag }`.
 *  - 304 path: returns `{ status: "notModified", eTag }` without body parse.
 *  - 404 path: returns `INVALID_SDK_KEY` failure.
 *  - 4xx / 5xx path: returns `FETCH_FAILED` failure with the HTTP status in the message.
 *  - Network throw: returns `FETCH_FAILED` failure (fixed reason, exception NOT forwarded).
 *  - AbortController-driven timeout (caller signal + internal `requestTimeoutMs`).
 *  - Bad JSON / wrong shape: returns `PARSE_FAILED`.
 *  - SC-006: raw SDK key NEVER appears in returned messages OR captured logger args.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { readFileSync } from "node:fs";

import { type IConfig } from "../../src/config-json.ts";
import { type IConfigCatLogger, LoggerWrapper, LogLevel, NullLogger } from "../../src/logger.ts";
import { buildConfigUrl, HttpConfigFetcher } from "../../src/config-fetcher.ts";
import * as publicEntry from "../../src/index.ts";

// The one accept/reject list every SDK's validator is tested from (#802). Read
// by relative path: sdk-shared must not depend on the fixtures package (#417).
const keyShapes = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json", import.meta.url),
    "utf8",
  ),
) as { valid: Array<{ name: string; key: string }> };

// The shared wire corpus's malformed-key case (#803, FR-001): its key and its
// path are real `go run` url.PathEscape output, so this test tracks the corpus
// rather than a copy of it. Same relative-path read as above (#417).
const malformedKeyCase = (
  JSON.parse(
    readFileSync(
      new URL("../../../test-fixtures-sdk-parity/fixtures/wire-cases.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: Array<{ id: string; given: { sdkKey: string }; expected: { requestPath?: string } }>;
  }
).cases.find((c) => c.id === "request-path-malformed-key");

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE_URL = "https://cdn.example.test";
const SDK_VERSION = "confeature-sdk-test/0.1.0";

function makeConfig(): IConfig {
  return {
    p: { u: "https://cdn.example.test", r: 0, s: "v1" },
    f: { "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] } },
    s: [],
  };
}

function makeFetcher(requestTimeoutMs?: number): HttpConfigFetcher {
  const logger = new LoggerWrapper(new NullLogger());
  return new HttpConfigFetcher(BASE_URL, SDK_KEY, SDK_VERSION, logger, requestTimeoutMs);
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HttpConfigFetcher — URL + headers", () => {
  // FR-001 / FR-004 (#803): the PARSED path is pinned (the query is #807's),
  // written out literally — never derived from the code under test.
  const NEW_KEY = "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02";

  async function requestFor(sdkKey: string): Promise<{ raw: string; url: URL; init: RequestInit }> {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(makeConfig()), { status: 200 }));
    const logger = new LoggerWrapper(new NullLogger());
    await new HttpConfigFetcher(BASE_URL, sdkKey, SDK_VERSION, logger).fetchAsync(
      null,
      new AbortController().signal,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = spy.mock.calls[0]!;
    const raw = urlOf(calledUrl);
    return { raw, url: new URL(raw), init: init as RequestInit };
  }

  test("a legacy key: GET <baseUrl>/configuration-files/<key>/config_v6.json?sdk=<version>", async () => {
    const { url, init } = await requestFor(SDK_KEY);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe(`/configuration-files/${SDK_KEY}/config_v6.json`);
    expect(url.searchParams.get("sdk")).toBe(SDK_VERSION);
    expect(init.method).toBe("GET");
  });

  test("a ConfigCat-shaped key travels RAW — ConfigCat's exact bytes, no %2F", async () => {
    const { url } = await requestFor(NEW_KEY);
    expect(url.pathname).toBe(
      "/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/config_v6.json",
    );
    expect(url.href).not.toContain("%2F");
    expect(url.href).not.toContain("/v2/");
  });

  test.each(keyShapes.valid.map((c) => [c.name, c.key]))(
    "every valid key (%s) is its own raw path",
    async (_name, key) => {
      const { url } = await requestFor(key);
      expect(url.pathname).toBe(`/configuration-files/${key}/config_v6.json`);
    },
  );

  test.each([
    ["proxy form", "configcat-proxy/my-proxy-key", "configcat-proxy%2Fmy-proxy-key"],
    ["query/fragment characters", "a?b#c", "a%3Fb%23c"],
    ["a dot-segment inside", "../admin", "..%2Fadmin"],
    ["whitespace", " k", "%20k"],
    // Literals copied from Go `url.PathEscape` output — never computed here.
    [
      "Go url.PathEscape keep set",
      "bad key$&+:=@,;!'()*~/x?y#z%..",
      "bad%20key$&+:=@%2C%3B%21%27%28%29%2A~%2Fx%3Fy%23z%25..",
    ],
    ["UTF-8 bytes, uppercase hex", "clé", "cl%C3%A9"],
  ])("a malformed key (%s) is escaped into ONE segment", async (_name, key, segment) => {
    const { url } = await requestFor(key);
    expect(url.pathname).toBe(`/configuration-files/${segment}/config_v6.json`);
  });

  test("the corpus case request-path-malformed-key: its key goes out as its exact path", async () => {
    expect(malformedKeyCase, "wire-cases.json lost request-path-malformed-key").toBeDefined();
    const key = malformedKeyCase!.given.sdkKey;
    const expectedPath = malformedKeyCase!.expected.requestPath;
    // The corpus key really is the 2-, 3- and 4-byte UTF-8 one (a 4-byte code
    // point is a UTF-16 surrogate pair) — otherwise this test proves less.
    expect(key).toContain("\u00E9\u20AC\u{1F600}");
    expect(expectedPath).toContain("%C3%A9%E2%82%AC%F0%9F%98%80");
    const { raw, url } = await requestFor(key);
    // The string handed to fetch, origin and query cut — byte for byte.
    expect(raw.startsWith(BASE_URL)).toBe(true);
    expect(raw.slice(BASE_URL.length).split("?")[0]).toBe(expectedPath);
    // And the parsed path the URL parser yields from it is still the same bytes.
    expect(url.pathname).toBe(expectedPath);
  });

  test.each([
    ["empty", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["lone surrogate", "\uD800"],
  ])("a key no segment can hold (%s) is refused: no request, INVALID_SDK_KEY", async (_n, key) => {
    const spy = vi.spyOn(globalThis, "fetch");
    const logger = new LoggerWrapper(new NullLogger());
    const invalidSpy = vi.spyOn(logger, "invalidSdkKey");
    const out = await new HttpConfigFetcher(BASE_URL, key, SDK_VERSION, logger).fetchAsync(
      null,
      new AbortController().signal,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(invalidSpy).toHaveBeenCalledOnce();
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.errorCode).toBe("INVALID_SDK_KEY");
  });

  test("sends If-None-Match when an ETag is provided", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(makeConfig()), { status: 200 }));
    const fetcher = makeFetcher();
    await fetcher.fetchAsync('"prev-etag"', new AbortController().signal);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ "If-None-Match": '"prev-etag"' });
  });

  test("does NOT send If-None-Match when ETag is null", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(makeConfig()), { status: 200 }));
    const fetcher = makeFetcher();
    await fetcher.fetchAsync(null, new AbortController().signal);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({});
  });
});

describe("HttpConfigFetcher — status code branches", () => {
  test("200 returns 'fetched' + parsed config + ETag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeConfig()), {
        status: 200,
        headers: { ETag: '"e1"' },
      }),
    );
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("fetched");
    if (out.status === "fetched") {
      expect(out.eTag).toBe('"e1"');
      expect(out.configJson.f["feature.x"]?.v.b).toBe(true);
    }
  });

  test("304 returns 'notModified' WITHOUT parsing a body", async () => {
    const textSpy = vi.fn().mockResolvedValue("should-not-be-called");
    const mockResponse = {
      status: 304,
      headers: new Headers({ ETag: '"prev-etag"' }),
      text: textSpy,
      ok: false,
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);
    const out = await makeFetcher().fetchAsync('"prev-etag"', new AbortController().signal);
    expect(out.status).toBe("notModified");
    if (out.status === "notModified") {
      expect(out.eTag).toBe('"prev-etag"');
    }
    // Body must not have been consumed.
    expect(textSpy).not.toHaveBeenCalled();
  });

  test("404 returns INVALID_SDK_KEY failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("INVALID_SDK_KEY");
    }
  });

  test("500 returns FETCH_FAILED with status in the message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server-error", { status: 500 }));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_FAILED");
      expect(out.errorMessage).toContain("500");
    }
  });

  test("429 (rate-limited) returns FETCH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate-limited", { status: 429 }));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_FAILED");
      expect(out.errorMessage).toContain("429");
    }
  });
});

describe("HttpConfigFetcher — error transport branches", () => {
  test("network throw returns FETCH_FAILED — a fixed reason, the exception NOT forwarded (FR-002)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DNS lookup failed"));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_FAILED");
      expect(out.errorMessage).toBe("Network error while fetching config.");
      expect(out.exception).toBeUndefined();
    }
  });

  test("AbortError → FETCH_TIMEOUT", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_TIMEOUT");
    }
  });

  test("caller AbortController firing mid-flight surfaces FETCH_TIMEOUT", async () => {
    const ac = new AbortController();
    // Fetch reads the signal — simulate it by rejecting with AbortError
    // when the signal is aborted.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            const err = Object.assign(new Error("aborted"), { name: "AbortError" });
            reject(err);
          });
        }),
    );
    const promise = makeFetcher().fetchAsync(null, ac.signal);
    ac.abort();
    const out = await promise;
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_TIMEOUT");
    }
  });

  test("internal requestTimeoutMs fires at the configurable threshold", async () => {
    vi.useFakeTimers();
    let abortedFromSignal = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            abortedFromSignal = true;
            const err = Object.assign(new Error("aborted"), { name: "AbortError" });
            reject(err);
          });
        }),
    );
    // 50 ms timeout — well below the default 10_000.
    const promise = makeFetcher(50).fetchAsync(null, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60);
    const out = await promise;
    expect(abortedFromSignal).toBe(true);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("FETCH_TIMEOUT");
    }
  });
});

describe("HttpConfigFetcher — parse failure branches", () => {
  test("body is not valid JSON → PARSE_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("definitely not json", { status: 200 }),
    );
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("PARSE_FAILED");
    }
  });

  test("body shape is not {p,f,s} → PARSE_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.errorCode).toBe("PARSE_FAILED");
    }
  });
});

describe("HttpConfigFetcher — SC-006 (SDK key never leaks)", () => {
  test("404 failure message does NOT include the raw SDK key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    if (out.status === "failed") {
      expect(out.errorMessage).not.toContain(SDK_KEY);
    }
  });

  test("500 failure message does NOT include the raw SDK key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const out = await makeFetcher().fetchAsync(null, new AbortController().signal);
    if (out.status === "failed") {
      expect(out.errorMessage).not.toContain(SDK_KEY);
    }
  });

  test("captured log arguments NEVER contain the raw SDK key (every failure path)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Spy on the LoggerWrapper helpers that the fetcher uses on the
    // failure paths (fetchFailed, invalidSdkKey, parseError). Every
    // argument captured by either spy MUST NOT be the raw SDK key.
    const logger = new LoggerWrapper(new NullLogger());
    const fetchFailedSpy = vi.spyOn(logger, "fetchFailed");
    const invalidSdkKeySpy = vi.spyOn(logger, "invalidSdkKey");
    const parseErrorSpy = vi.spyOn(logger, "parseError");

    const fetcher = new HttpConfigFetcher(BASE_URL, SDK_KEY, SDK_VERSION, logger);

    const assertNoLeak = (): void => {
      const everyCall = [
        ...fetchFailedSpy.mock.calls,
        ...invalidSdkKeySpy.mock.calls,
        ...parseErrorSpy.mock.calls,
      ];
      for (const call of everyCall) {
        for (const arg of call) {
          const text = typeof arg === "string" ? arg : JSON.stringify(arg);
          // The first arg to each helper IS the raw SDK key (the helper
          // routes it through `redactSdkKey()` before emitting). What we
          // assert is that NO STRINGIFIED arg leaks the key — i.e. that
          // the helpers themselves don't echo it into another arg or
          // into the formatted message.
          if (arg === SDK_KEY) continue;
          expect(text).not.toContain(SDK_KEY);
        }
      }
    };

    // 1. Network error path.
    fetchSpy.mockRejectedValueOnce(new Error("DNS lookup failed"));
    await fetcher.fetchAsync(null, new AbortController().signal);
    assertNoLeak();

    // 2. 404 path.
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await fetcher.fetchAsync(null, new AbortController().signal);
    assertNoLeak();

    // 3. 500 path.
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await fetcher.fetchAsync(null, new AbortController().signal);
    assertNoLeak();

    // 4. Bad JSON path.
    fetchSpy.mockResolvedValueOnce(new Response("definitely not json", { status: 200 }));
    await fetcher.fetchAsync(null, new AbortController().signal);
    assertNoLeak();

    // 5. Bad shape path.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    await fetcher.fetchAsync(null, new AbortController().signal);
    assertNoLeak();
  });
});

describe("HttpConfigFetcher — forced failures never leak the key (FR-002 / FR-004, #803)", () => {
  // The key is IN the URL now, and a runtime's fetch error may quote that URL
  // (Deno: "error sending request for url (…)"). Each mock below fails the
  // way a real transport does AND quotes the full URL in its error, so the
  // test fails the moment the fetcher logs or forwards a library error.
  const KEYS = [
    ["ConfigCat-shaped", "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02"],
    ["legacy", SDK_KEY],
  ] as const;

  type Failure = (url: string, init: RequestInit | undefined) => Promise<Response>;
  const FAILURES: ReadonlyArray<readonly [string, Failure]> = [
    [
      "timeout",
      (url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error(`The operation was aborted while fetching ${url}`);
            err.name = "AbortError";
            reject(err);
          });
        }),
    ],
    [
      "mid-body reset",
      (url) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"p":{"s":"partial'));
            controller.error(new TypeError(`error reading a body from connection: ${url}`));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    ],
    [
      "redirect loop",
      (url) =>
        Promise.reject(
          new TypeError(`error sending request for url (${url}): too many redirects`, {
            cause: new Error(`redirect loop at ${url}`),
          }),
        ),
    ],
  ];

  for (const [keyName, key] of KEYS) {
    for (const [failureName, failure] of FAILURES) {
      test(`${failureName} with a ${keyName} key`, async () => {
        const lines: string[] = [];
        const capture: IConfigCatLogger = {
          level: LogLevel.Debug,
          log: (_level, eventId, message, exception) => {
            lines.push(`${eventId} ${String(message)} ${textOf(exception)}`);
          },
        };
        const logger = new LoggerWrapper(capture, (msg, exception) => {
          lines.push(`clientError ${msg} ${textOf(exception)}`);
        });
        const spy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation((input, init) => failure(urlOf(input), init));

        const out = await new HttpConfigFetcher(BASE_URL, key, SDK_VERSION, logger, 20).fetchAsync(
          null,
          new AbortController().signal,
        );

        // Sanity: the key really was in the URL the mock quoted.
        expect(urlOf(spy.mock.calls[0]![0])).toContain(key);
        expect(out.status).toBe("failed");
        const forbidden = [
          key,
          encodeURIComponent(key),
          ...key.split(/[/-]/).filter((p) => p.length >= 22),
        ];
        const result = textOf(out) + (out.status === "failed" ? textOf(out.exception) : "");
        for (const secret of forbidden) {
          expect(result, "fetch result").not.toContain(secret);
          for (const line of lines) expect(line, "log line").not.toContain(secret);
        }
      });
    }
  }
});

beforeEach(() => {
  // Defensive — should already be clean from afterEach.
  vi.restoreAllMocks();
});

describe("buildConfigUrl — public entry (#803)", () => {
  // sdk-node builds its URL with this function; a second copy would drift.
  test("the package entry re-exports the one URL builder", () => {
    expect(publicEntry.buildConfigUrl).toBe(buildConfigUrl);
    expect(
      publicEntry.buildConfigUrl(
        "https://cdn.example.test",
        "configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02",
        "1.2.3",
      ),
    ).toBe(
      "https://cdn.example.test/configuration-files/configcat-sdk-1/FAKEfixtureKeyNotRea01/FAKEfixtureKeyNotRea02/config_v6.json?sdk=1.2.3",
    );
  });
});
