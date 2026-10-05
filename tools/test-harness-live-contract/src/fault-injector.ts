// SPDX-License-Identifier: MIT

/**
 * Fault injector — given an incoming Request and the upstream Response
 * from Miniflare, optionally substitute the response with a controlled
 * failure mode per the FaultMarker attached to the requested key.
 *
 * Faults are stored in a per-instance map keyed by sdkKey; this module
 * is purely a pure-function-style transformer that takes the map as an
 * argument. The map itself is owned by AdminState.
 *
 * The fault VOCABULARY and its validity rules live in seed-schema.ts. This
 * module decides what each valid fault puts on the wire (plan 680, decision
 * rows 4-6); proxy-server.ts only executes what it is handed.
 */

import type { CannedFaultName } from "./seed-schema.js";
import type { FaultMarker } from "./types.js";

/**
 * Extract the sdkKey from a config URL, in every form the CDN Worker serves (#802):
 *   - /configuration-files/<sdkKey>/config_v6.json — a legacy key, or a
 *     ConfigCat-shaped key sent `%2F`-encoded (decoded here, once, as Hono
 *     decodes the route parameter);
 *   - /configuration-files/configcat-sdk-1/<a>/<b>/config_v6.json — the raw
 *     ConfigCat-shaped key, as stock ConfigCat SDKs send it.
 * Returns null if the URL matches neither. This is the harness's ONE
 * path-to-key home: request recording and fault injection both key on it, and
 * a form it misses would make them silently do nothing.
 */
export function sdkKeyFromUrl(url: URL): string | null {
  const three = /^\/configuration-files\/configcat-sdk-1\/([^/]+)\/([^/]+)\/config_v6\.json$/.exec(
    url.pathname,
  );
  const one = three ? null : /^\/configuration-files\/([^/]+)\/config_v6\.json$/.exec(url.pathname);
  try {
    if (three)
      return `configcat-sdk-1/${decodeURIComponent(three[1]!)}/${decodeURIComponent(three[2]!)}`;
    if (one) return decodeURIComponent(one[1]!);
  } catch {
    return null; // malformed percent-encoding: not a key
  }
  return null;
}

type StatusFault = Extract<FaultMarker, { kind: "status" }>;

/**
 * The canned literals are aliases for `status` faults, byte-for-byte equal to
 * the `server` block of the wire-case each one exists to serve
 * (`packages/test-fixtures-sdk-parity/fixtures/wire-cases.json`). They are
 * data, not code paths: every one is served by `statusResponse` below.
 * `tests/fault-injector.unit.test.ts` asserts the equality against the corpus.
 */
export const CANNED_FAULTS: Readonly<Record<CannedFaultName, StatusFault>> = {
  // wire-cases.json#server-5xx-failure
  "5xx": {
    kind: "status",
    status: 503,
    headers: { "Content-Type": "text/plain" },
    body: "service unavailable",
  },
  // wire-cases.json#invalid-sdk-key-404
  "404": {
    kind: "status",
    status: 404,
    headers: { "Content-Type": "application/json" },
    body: '{"error": "unknown sdk key"}',
  },
  // wire-cases.json#malformed-json-200
  "malformed-json": {
    kind: "status",
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"garbage"' },
    body: "{not valid json",
  },
  // wire-cases.json#wrong-shape-200
  "wrong-shape": {
    kind: "status",
    status: 200,
    headers: { "Content-Type": "application/json", ETag: '"wrong-shape"' },
    body: '{"foo": "bar"}',
  },
};

/**
 * The one builder for a replaced response: exactly the declared headers, and
 * a null body when none is declared — `new Response("", { status: 304 })`
 * throws. Whether a status may carry a body is decided by the schema
 * (seed-schema.ts NULL_BODY_STATUSES); it is not re-checked here.
 */
function statusResponse(fault: StatusFault): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(fault.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  return new Response(fault.body ?? null, { status: fault.status, headers });
}

/**
 * The outcome of applying a fault. `timeout` and `truncate` are markers the
 * proxy executes on the socket itself — neither can be a Response value.
 */
export type FaultResult =
  | { kind: "response"; response: Response }
  | { kind: "timeout"; ms: number }
  | { kind: "truncate"; upstream: Response };

export function applyFault(upstream: Response, fault: FaultMarker | undefined): FaultResult {
  if (fault === undefined || fault === "none") {
    return { kind: "response", response: upstream };
  }
  if (fault === "close-mid-response") {
    return { kind: "truncate", upstream };
  }
  if (typeof fault === "string") {
    return { kind: "response", response: statusResponse(CANNED_FAULTS[fault]) };
  }
  switch (fault.kind) {
    case "status":
      return { kind: "response", response: statusResponse(fault) };
    case "timeout":
      return { kind: "timeout", ms: fault.ms };
    case "etag-mismatch": {
      // Forward upstream body + status but rewrite the ETag header.
      const headers = new Headers(upstream.headers);
      headers.set("etag", fault.newEtag);
      return {
        kind: "response",
        response: new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        }),
      };
    }
    default: {
      const _exhaustive: never = fault;
      void _exhaustive;
      return { kind: "response", response: upstream };
    }
  }
}

/**
 * Where a `close-mid-response` cuts, decided here and only here. The client
 * is promised the whole body (`advertisedLength`) and receives a strict,
 * non-empty prefix of it (`sendBytes`), so it sees a transport failure —
 * never a complete-but-short body it would misread as a JSON error.
 * A body under 2 bytes has no strict non-empty prefix: refused.
 */
export type TruncationPlan =
  | { kind: "cut"; sendBytes: number; advertisedLength: number }
  | { kind: "refuse"; reason: string };

export function truncationPlan(bodyLength: number): TruncationPlan {
  if (bodyLength < 2) {
    return {
      kind: "refuse",
      reason: `close-mid-response needs an upstream body of at least 2 bytes, got ${bodyLength}`,
    };
  }
  return {
    kind: "cut",
    sendBytes: Math.max(1, Math.floor(bodyLength / 2)),
    advertisedLength: bodyLength,
  };
}
