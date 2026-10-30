// SPDX-License-Identifier: MIT

/**
 * The JS family's redirect policy for the config fetch (#995, epic #834).
 *
 * The config URL holds the SDK key, so a redirect that downgrades an `https`
 * request to `http` would send the key in clear text. Left to itself, every
 * server runtime's `fetch` (undici, bun, deno, workerd) follows such a hop;
 * only a secure-context browser refuses it (mixed-content blocking). So the
 * SDK picks the redirect mode per runtime and, where the runtime would
 * follow, walks the hops itself.
 *
 * Shared by `HttpConfigFetcher` here (browser, bun, deno, cloudflare-worker,
 * angular, react) and sdk-node's own fetcher, so the rule has one home.
 */

/** Redirects a server runtime follows before giving up (`redirect_loop`). */
export const MAX_REDIRECTS = 10;

/**
 * How a runtime is redirected:
 *  - `server`           — node, bun, deno, workerd: `"manual"` + the SDK's own hop loop;
 *  - `secure-browser`   — `"follow"`: the platform's mixed-content blocking turns
 *                         a downgrade into a network error;
 *  - `insecure-browser` — `"manual"`: the browser hides the `Location`
 *                         (`opaqueredirect`), so every redirect is refused.
 */
export type RedirectRuntime = "server" | "secure-browser" | "insecure-browser";

/**
 * The one predicate that tells a browser from a server runtime. A browser
 * (window or worker) exposes a boolean `isSecureContext`; node, bun, deno and
 * workerd do not. Anything that is not a boolean is a server runtime — the
 * branch that walks the hops itself, so a wrong guess never follows a
 * downgrade.
 */
export function redirectRuntime(scope: object = globalThis): RedirectRuntime {
  const secure = "isSecureContext" in scope ? scope.isSecureContext : undefined;
  if (secure === true) return "secure-browser";
  if (secure === false) return "insecure-browser";
  return "server";
}

/**
 * The fixed, key-free reasons a redirect is refused. Never the `Location` or
 * the URL: both hold the SDK key (#803, FR-002).
 */
export type RedirectRefusal = "insecure_redirect" | "redirect_loop";

/** The final response, or the reason the redirect chain was not followed. */
export type GuardedFetchResult = { response: Response } | { refused: RedirectRefusal };

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch(url, init)` under the runtime's redirect policy. A transport error
 * (including an abort) rejects exactly as `fetch` does; the caller classifies
 * it. Per hop: when the request just sent was `https`, a `Location` whose
 * scheme is not `https` is never sent. A configured `http` base is the
 * operator's choice, so `http` hops are followed.
 */
export async function fetchGuardingRedirects(
  url: string,
  init: RequestInit,
  runtime: RedirectRuntime = redirectRuntime(),
): Promise<GuardedFetchResult> {
  if (runtime === "secure-browser") {
    return { response: await fetch(url, { ...init, redirect: "follow" }) };
  }
  const manual: RequestInit = { ...init, redirect: "manual" };
  if (runtime === "insecure-browser") {
    const response = await fetch(url, manual);
    // Same-scheme redirects are lost here too: the Location is hidden, so a
    // downgrade cannot be told apart (the accepted tradeoff, epic #834).
    if (response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status)) {
      return { refused: "insecure_redirect" };
    }
    return { response };
  }

  let current = new URL(url);
  for (let followed = 0; ; followed++) {
    const response = await fetch(current.href, manual);
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("Location")
      : null;
    // Not a redirect — or a 30x with no Location, which fetch also returns as is.
    if (location === null) return { response };
    // The hop's body is never read; release the connection.
    await response.body?.cancel();
    if (followed === MAX_REDIRECTS) return { refused: "redirect_loop" };
    const next = parseLocation(location, current);
    if (current.protocol === "https:" && next.protocol !== "https:") {
      return { refused: "insecure_redirect" };
    }
    current = next;
  }
}

/**
 * Resolve a `Location` against the URL it answered (a relative one is legal).
 * The URL parser's error carries the input, which may hold the key, so an
 * unparseable value rejects with a fixed message instead — a network error,
 * as `fetch` itself reports it.
 */
function parseLocation(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch {
    throw new TypeError("fetch failed: the redirect Location is not a valid URL");
  }
}
