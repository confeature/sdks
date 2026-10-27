// SPDX-License-Identifier: MIT

/**
 * The redirect policy of the JS family's config fetch (#995, epic #834): a
 * keyed URL is never sent over http after an https request.
 *
 * The fetch mocks here answer `redirect: "manual"` with the 30x itself, the
 * way a server runtime does; the browser branches are told apart by the
 * `isSecureContext` they are handed. That a secure-context browser really
 * blocks the downgrade is observed in a real browser, not here (the issue's
 * acceptance criterion).
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchGuardingRedirects, MAX_REDIRECTS, redirectRuntime } from "../../src/redirect.ts";

const ORIGIN = "https://cdn.example.test/configuration-files/k/config_v6.json?sdk=t";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The URL a `fetch` mock was called with, whatever form it took. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A server-runtime fetch: each URL in `hops` answers a 30x to the next one. */
function hopFetch(hops: Record<string, string>, status = 302) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = urlOf(input);
    const location = hops[url];
    if (location === undefined) return Promise.resolve(new Response("{}", { status: 200 }));
    expect(init?.redirect, "a server runtime must not let fetch follow").toBe("manual");
    return Promise.resolve(new Response(null, { status, headers: { Location: location } }));
  });
}

function urlsOf(spy: ReturnType<typeof hopFetch>): string[] {
  return spy.mock.calls.map(([input]) => urlOf(input));
}

describe("redirectRuntime — which redirect policy a runtime gets", () => {
  test("no isSecureContext (node, bun, deno, workerd) → server", () => {
    expect(redirectRuntime({})).toBe("server");
    expect(redirectRuntime(globalThis)).toBe("server");
  });
  test("isSecureContext true → secure-browser", () => {
    expect(redirectRuntime({ isSecureContext: true })).toBe("secure-browser");
  });
  test("isSecureContext false → insecure-browser", () => {
    expect(redirectRuntime({ isSecureContext: false })).toBe("insecure-browser");
  });
  test("a non-boolean isSecureContext is not a browser", () => {
    expect(redirectRuntime({ isSecureContext: "yes" })).toBe("server");
  });
});

describe("fetchGuardingRedirects — server runtime (own hop loop)", () => {
  test("an https → http hop is not sent: insecure_redirect", async () => {
    const http = ORIGIN.replace("https:", "http:");
    const spy = hopFetch({ [ORIGIN]: http });
    const result = await fetchGuardingRedirects(ORIGIN, { method: "GET" }, "server");
    expect(result).toEqual({ refused: "insecure_redirect" });
    expect(urlsOf(spy)).toEqual([ORIGIN]);
  });

  test("any non-https scheme after https is refused", async () => {
    const spy = hopFetch({ [ORIGIN]: "ftp://cdn.example.test/x" });
    expect(await fetchGuardingRedirects(ORIGIN, {}, "server")).toEqual({
      refused: "insecure_redirect",
    });
    expect(spy).toHaveBeenCalledOnce();
  });

  test("an https → https hop is followed, headers and signal kept", async () => {
    const next = "https://mirror.example.test/c.json";
    const spy = hopFetch({ [ORIGIN]: next });
    const signal = new AbortController().signal;
    const result = await fetchGuardingRedirects(
      ORIGIN,
      { method: "GET", headers: { "If-None-Match": '"e"' }, signal },
      "server",
    );
    expect("response" in result && result.response.status).toBe(200);
    expect(urlsOf(spy)).toEqual([ORIGIN, next]);
    const [, init] = spy.mock.calls[1]!;
    expect(new Headers(init?.headers).get("If-None-Match")).toBe('"e"');
    expect(init?.signal).toBe(signal);
  });

  test("a relative Location resolves against the current URL", async () => {
    const spy = hopFetch({ [ORIGIN]: "/moved/config_v6.json" });
    await fetchGuardingRedirects(ORIGIN, {}, "server");
    expect(urlsOf(spy)).toEqual([ORIGIN, "https://cdn.example.test/moved/config_v6.json"]);
  });

  test("a scheme-relative Location keeps https", async () => {
    const spy = hopFetch({ [ORIGIN]: "//other.example.test/c.json" });
    await fetchGuardingRedirects(ORIGIN, {}, "server");
    expect(urlsOf(spy)[1]).toBe("https://other.example.test/c.json");
  });

  test.each([301, 303, 307, 308])("status %i is a redirect hop too", async (status) => {
    const spy = hopFetch({ [ORIGIN]: ORIGIN.replace("https:", "http:") }, status);
    expect(await fetchGuardingRedirects(ORIGIN, {}, "server")).toEqual({
      refused: "insecure_redirect",
    });
    expect(spy).toHaveBeenCalledOnce();
  });

  test("a configured http base is the operator's choice: http → http is followed", async () => {
    const base = "http://cdn.internal.test/a";
    const spy = hopFetch({ [base]: "http://cdn.internal.test/b" });
    const result = await fetchGuardingRedirects(base, {}, "server");
    expect("response" in result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("the refusal is per hop: http → https → http refuses the second hop", async () => {
    const spy = hopFetch({
      "http://a.test/1": "https://a.test/2",
      "https://a.test/2": "http://a.test/3",
    });
    expect(await fetchGuardingRedirects("http://a.test/1", {}, "server")).toEqual({
      refused: "insecure_redirect",
    });
    expect(urlsOf(spy)).toEqual(["http://a.test/1", "https://a.test/2"]);
  });

  test(`${String(MAX_REDIRECTS)} hops are followed; one more is redirect_loop`, async () => {
    expect(MAX_REDIRECTS).toBe(10);
    const chain = (n: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `https://a.test/${String(i)}`,
          `https://a.test/${String(i + 1)}`,
        ]),
      );
    const ok = hopFetch(chain(MAX_REDIRECTS));
    const followed = await fetchGuardingRedirects("https://a.test/0", {}, "server");
    expect("response" in followed && followed.response.status).toBe(200);
    expect(ok).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    vi.restoreAllMocks();

    const loop = hopFetch(chain(MAX_REDIRECTS + 1));
    expect(await fetchGuardingRedirects("https://a.test/0", {}, "server")).toEqual({
      refused: "redirect_loop",
    });
    expect(loop).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  test("a 30x without Location is the final answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302 }));
    const result = await fetchGuardingRedirects(ORIGIN, {}, "server");
    expect("response" in result && result.response.status).toBe(302);
  });

  test("an unparseable Location is a network error with a fixed, URL-free message", async () => {
    hopFetch({ [ORIGIN]: "https://[not-a-host" });
    const err = await fetchGuardingRedirects(ORIGIN, {}, "server").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as Error).message)).not.toContain("://");
  });
});

describe("fetchGuardingRedirects — browser runtimes", () => {
  test("secure context: fetch follows (mixed-content blocking refuses a downgrade)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const result = await fetchGuardingRedirects(ORIGIN, { method: "GET" }, "secure-browser");
    expect("response" in result).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![1]?.redirect).toBe("follow");
  });

  test("insecure context: manual, and an opaqueredirect is refused — even https → https", async () => {
    const opaque = { type: "opaqueredirect", status: 0, headers: new Headers() } as Response;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(opaque);
    expect(await fetchGuardingRedirects(ORIGIN, {}, "insecure-browser")).toEqual({
      refused: "insecure_redirect",
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  test("insecure context: a non-redirect answer passes through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await fetchGuardingRedirects(ORIGIN, {}, "insecure-browser");
    expect("response" in result && result.response.status).toBe(200);
  });

  test("the runtime defaults to this one's (node → server)", async () => {
    const spy = hopFetch({ [ORIGIN]: ORIGIN.replace("https:", "http:") });
    expect(await fetchGuardingRedirects(ORIGIN, {})).toEqual({ refused: "insecure_redirect" });
    expect(spy).toHaveBeenCalledOnce();
  });
});
