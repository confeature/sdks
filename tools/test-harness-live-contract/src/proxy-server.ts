// SPDX-License-Identifier: MIT

/**
 * Proxy HTTP server — owns the single bound loopback port.
 *
 *   /admin/reset, /admin/seed, /admin/inject-fault, /admin/state
 *     → handlers in admin-routes.ts (loopback-guarded)
 *   everything else
 *     → forwarded to Miniflare via MiniflareHost.dispatchFetch, optionally
 *       substituted by fault-injector when the requested key has an
 *       attached fault.
 *
 * Bind: { host: "127.0.0.1", port: 0 } — OS-assigned ephemeral port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AdminState,
  enforceAdminCaller,
  handleReset,
  handleSeed,
  handleInjectFault,
  handleState,
  handleRequests,
  type AdminDeps,
} from "./admin-routes.js";
import { applyFault, sdkKeyFromUrl, truncationPlan } from "./fault-injector.js";
import { NULL_BODY_STATUSES } from "./seed-schema.js";
import type { WranglerHost } from "./wrangler-host.js";

export type ProxyServer = {
  url: string;
  state: AdminState;
  close(): Promise<void>;
};

export async function startProxyServer(
  host: WranglerHost,
  cwd: string,
  bindPort: number,
  state: AdminState = new AdminState(),
): Promise<ProxyServer> {
  const deps: AdminDeps = { host, state, cwd };

  const server: Server = createServer((req, res) => {
    void route(req, res, deps).catch((err) => {
      // Last-resort handler — should be unreachable; route() catches per-route.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `internal: ${(err as Error).message}` }));
      } else {
        res.destroy(err as Error);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bindPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server.address() returned unexpected shape");
  }
  const url = `http://127.0.0.1:${addr.port}`;
  state.bindAddress = `127.0.0.1:${addr.port}`;

  return {
    url,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Force-close lingering connections so close() doesn't hang on
        // open keep-alive sockets from test clients.
        server.closeAllConnections?.();
      }),
  };
}

async function route(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  // Defensively normalise the URL. req.url is always present on a Node http server.
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

  if (requestUrl.pathname.startsWith("/admin/")) {
    // The one place the admin caller is checked (plan 680, decision row 11):
    // before ANY /admin/* path is dispatched, including unknown ones.
    if (!enforceAdminCaller(req, res)) return;
    if (requestUrl.pathname === "/admin/reset" && req.method === "POST") {
      return handleReset(req, res, deps);
    }
    if (requestUrl.pathname === "/admin/seed" && req.method === "POST") {
      return handleSeed(req, res, deps);
    }
    if (requestUrl.pathname === "/admin/inject-fault" && req.method === "POST") {
      return handleInjectFault(req, res, deps);
    }
    if (requestUrl.pathname === "/admin/state" && req.method === "GET") {
      return handleState(req, res, deps);
    }
    if (requestUrl.pathname === "/admin/requests" && req.method === "GET") {
      return handleRequests(req, res, deps, requestUrl);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: `unknown admin route ${req.method} ${requestUrl.pathname}`,
      }),
    );
    return;
  }

  // Non-admin: forward to Miniflare with optional fault substitution.
  const sdkKey = sdkKeyFromUrl(requestUrl);
  const fault = sdkKey ? deps.state.getFault(sdkKey) : undefined;
  if (sdkKey) {
    const inm = req.headers["if-none-match"];
    deps.state.recordRequest(sdkKey, {
      url: requestUrl.pathname + requestUrl.search,
      ifNoneMatch: typeof inm === "string" ? inm : null,
    });
  }

  // Build an in-process Request to hand to Miniflare. Streaming the body
  // through is fine for GET/HEAD (no body); for write methods we'd need
  // to buffer, but the CDN Worker's read path is GET-only.
  const fetchHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") fetchHeaders.set(k, v);
    else if (Array.isArray(v)) fetchHeaders.set(k, v.join(", "));
  }
  const fetchReq = new Request(requestUrl.toString(), {
    method: req.method ?? "GET",
    headers: fetchHeaders,
  });

  let upstream: Response;
  try {
    upstream = await deps.host.dispatchFetch(fetchReq);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `upstream failed: ${(err as Error).message}` }));
    return;
  }

  const result = applyFault(upstream, fault);
  if (result.kind === "timeout") {
    // Hold the socket open for the requested duration, then end with a 504.
    // The SDK side typically aborts via its own client-side timeout before
    // we reach the end of the window; `req.aborted` is deprecated since
    // Node 18 and removed in 22, so we listen on the request's "close"
    // event instead (fires for both clean end and client abort).
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, result.ms);
      const onClose = (): void => {
        clearTimeout(t);
        resolve();
      };
      req.once("close", onClose);
    });
    if (!res.writableEnded) {
      res.writeHead(504, { "content-type": "text/plain" });
      res.end("");
    }
    return;
  }

  if (result.kind === "truncate") {
    await writeTruncated(req, res, result.upstream);
    return;
  }

  await writeResponse(res, result.response);
}

/**
 * Execute a `close-mid-response` fault. The cut is decided by
 * `truncationPlan` (fault-injector.ts); this only carries it out: the full
 * length is advertised, a strict prefix of the REAL body is written, and the
 * socket is destroyed without `end()` — so the client sees a transport
 * failure, not a short-but-complete body. `end()` is never reached on this
 * path: a write after `end()` is an uncaught ERR_STREAM_WRITE_AFTER_END.
 */
async function writeTruncated(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: Response,
): Promise<void> {
  const body = Buffer.from(await upstream.arrayBuffer());
  const plan = truncationPlan(body.byteLength);
  if (plan.kind === "refuse") {
    await writeResponse(
      res,
      new Response(JSON.stringify({ ok: false, error: plan.reason }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    return;
  }
  res.writeHead(upstream.status, toWireHeaders(upstream, plan.advertisedLength));
  await new Promise<void>((resolve) => {
    // Resolve on whichever comes first: the prefix flushed, or the client gone.
    const onClose = (): void => resolve();
    req.once("close", onClose);
    res.write(body.subarray(0, plan.sendBytes), () => {
      req.off("close", onClose);
      res.destroy();
      resolve();
    });
  });
}

/**
 * Response headers -> Node wire headers, decided once and used by every
 * writer (plan 680, decision row 7). undici has already decoded any
 * content-encoding applied by wrangler / Miniflare, so the encoding and
 * framing headers are dropped and Content-Length is recomputed by the caller:
 * framing is never forwarded, never author-controlled.
 */
export function toWireHeaders(
  response: Response,
  contentLength: number | null,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding")
      return;
    // Set-Cookie MUST NOT be comma-folded (#342): RFC 6265 §3 — an Expires
    // attribute legally contains commas, so joining multiple cookies with
    // ", " corrupts them. Headers.forEach() folds duplicates into one
    // comma-joined string, so skip it here and re-attach the un-folded list
    // below via getSetCookie(). (Other list-valued headers such as
    // WWW-Authenticate / Proxy-Authenticate are likewise unsafe to fold, but
    // the Headers object has already folded them and exposes no un-fold API;
    // The CDN Worker emits none today — revisit if a cookie/auth-bearing origin lands.)
    if (lower === "set-cookie") return;
    headers[key] = value;
  });
  // getSetCookie() returns each Set-Cookie as a distinct element; Node's
  // writeHead emits one header line per array element.
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }
  if (contentLength !== null) {
    headers["content-length"] = String(contentLength);
  }
  return headers;
}

export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  // Read the full body and re-emit it verbatim with harness-computed framing.
  const bodyBuf = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  // Framing is always explicit (plan 680 FR-002): a bodyless response that MAY
  // carry a body says `Content-Length: 0`, or Node falls back to chunked
  // encoding. A null-body status (204/205/304, decided in seed-schema.ts)
  // carries no Content-Length at all.
  const contentLength = bodyBuf
    ? bodyBuf.byteLength
    : NULL_BODY_STATUSES.has(response.status)
      ? null
      : 0;
  res.writeHead(response.status, toWireHeaders(response, contentLength));
  if (bodyBuf) res.write(bodyBuf);
  res.end();
}
