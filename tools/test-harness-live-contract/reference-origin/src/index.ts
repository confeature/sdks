// SPDX-License-Identifier: MIT

/**
 * The reference origin (ADR 0006 Q1): the config read path the SDKs use, and
 * nothing else. It stands in for the private CDN Worker as the live-contract
 * harness's upstream, runs locally only, and is never deployed (#861).
 *
 * It is bound to the real Worker by data, not by code:
 * packages/contract/read-path-transcript.json is recorded from that Worker, a
 * private test fails when the Worker drifts from it, and
 * tests/reference-origin-transcript.test.ts replays it against this file, byte
 * for byte. A behaviour this file has and the transcript lacks is unverified,
 * so it implements exactly the recorded semantics:
 *   - GET (and HEAD) of `/configuration-files/configcat-sdk-1/<a>/<b>/config_v6.json`
 *     or `/configuration-files/<sdkKey>/config_v6.json`;
 *   - one KV read; a miss, or a KV key over 512 UTF-8 bytes, is a 403 XML
 *     AccessDenied;
 *   - a hit is a 200 with `Cache-Control`, plus `ETag` / `Last-Modified` when
 *     stored, and a 304 when `If-None-Match` equals the stored ETag verbatim;
 *   - anything else is a 404 `404 Not Found`, and an unexpected failure is the
 *     real Worker's `onError` 500 (not recordable: the transcript cannot make
 *     KV fail, so tests/reference-origin-transcript.test.ts holds it to the
 *     transcript's `runtime` block, which the CDN Worker is held to privately).
 * Path decoding follows the router the real Worker uses: the path is
 * `decodeURI`d (so `%2F` stays a separator-free segment), then each segment
 * is `decodeURIComponent`d once.
 */

/** The KV metadata stored beside a config entry. */
export interface ConfigKvMetadata {
  etag?: string;
  lastModified?: string;
}

interface ConfigKv {
  getWithMetadata<M>(
    key: string,
    type: "text",
  ): Promise<{ value: string | null; metadata: M | null }>;
}

interface Env {
  CONFIG_KV: ConfigKv;
}

/**
 * The KV key a config is stored under. A copy of `configKey` in
 * packages/contract/src/kv-keys.ts: that source stays private (ADR 0006), so
 * this file may not import it. packages/contract/tests/contract.test.ts holds
 * the copy byte-equal to its home (#811, #861).
 */
function configKey(sdkKey: string): string {
  return `sdk:${sdkKey}:config_v6`;
}

const ACCESS_DENIED =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
const KV_MAX_KEY_BYTES = 512;
const CACHE_CONTROL = "max-age=0, must-revalidate";

/** Decode with `decoder`, or decode each `%XX` run that can be, leaving the rest. */
function tryDecode(text: string, decoder: (s: string) => string): string {
  try {
    return decoder(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decoder(run);
      } catch {
        return run;
      }
    });
  }
}

/** The SDK key a config path names, or null when the path is no config route. */
function sdkKeyOf(url: string): string | null {
  const start = url.indexOf("/", url.indexOf(":") + 4);
  const end = url.slice(start).search(/[?#]/);
  let path = end === -1 ? url.slice(start) : url.slice(start, start + end);
  if (path.includes("%")) path = tryDecode(path.replace(/%25/g, "%2525"), decodeURI);
  const param = (s: string) => (s.includes("%") ? tryDecode(s, decodeURIComponent) : s);
  const seg = path.split("/");
  if (seg[0] !== "" || seg[1] !== "configuration-files" || seg.at(-1) !== "config_v6.json") {
    return null;
  }
  if (seg.length === 6 && seg[2] === "configcat-sdk-1" && seg[3] && seg[4]) {
    return `configcat-sdk-1/${param(seg[3])}/${param(seg[4])}`;
  }
  return seg.length === 4 && seg[2] ? param(seg[2]) : null;
}

async function serve(request: Request, env: Env, sdkKey: string): Promise<Response> {
  const kvKey = configKey(sdkKey);
  if (new TextEncoder().encode(kvKey).byteLength > KV_MAX_KEY_BYTES) {
    return new Response(ACCESS_DENIED, {
      status: 403,
      headers: { "Content-Type": "application/xml" },
    });
  }
  const { value, metadata } = await env.CONFIG_KV.getWithMetadata<ConfigKvMetadata>(kvKey, "text");
  if (value === null) {
    return new Response(ACCESS_DENIED, {
      status: 403,
      headers: { "Content-Type": "application/xml" },
    });
  }
  const headers: Record<string, string> = { "Cache-Control": CACHE_CONTROL };
  if (metadata?.etag !== undefined) headers["ETag"] = metadata.etag;
  if (metadata?.lastModified !== undefined) headers["Last-Modified"] = metadata.lastModified;
  if (metadata?.etag !== undefined && request.headers.get("If-None-Match") === metadata.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const isRead = request.method === "GET" || request.method === "HEAD";
  const sdkKey = isRead ? sdkKeyOf(request.url) : null;
  if (sdkKey === null) {
    return new Response("404 Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
    });
  }
  return serve(request, env, sdkKey);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch {
      // An unexpected failure answers what the real Worker's onError answers:
      // a 500 with a correlation id and nothing internal (no stack, no key).
      const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
      response = Response.json(
        { error: "internal_error", message: "An unexpected error occurred.", requestId },
        { status: 500 },
      );
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
  },
};
