// SPDX-License-Identifier: MIT

/**
 * Admin REST handlers for /admin/reset, /admin/seed, /admin/inject-fault,
 * and /admin/state.
 *
 * No handler checks its caller itself: proxy-server.ts `route()` asks
 * `enforceAdminCaller` (below) once for every /admin/* path before dispatch
 * (FR-014, plan 680 decision row 11).
 *
 * See contracts/admin-api.md for the wire surface.
 */

import { readFile } from "node:fs/promises";
import { resolve as pathResolve, isAbsolute, sep as pathSep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// __dirname equivalent under ESM — used to anchor the harness's own seeds/ root.
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(fileURLToPath(import.meta.url));
import type { IncomingMessage, ServerResponse } from "node:http";
import { setFaultIn } from "./fault-state.js";
import { applySeed } from "./seed-applier.js";
import { SeedSchema, SeededKeySchema, FaultMarkerSchema } from "./seed-schema.js";
import { SeedValidationError } from "./seed-loader.js";
import type { AdminRequestsResponse, FaultMarker, RecordedRequest, Seed } from "./types.js";
import type { WranglerHost } from "./wrangler-host.js";

const ALLOWED_LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Per-key cap of the request log. */
export const MAX_REQUESTS_PER_KEY = 100;

export class AdminState {
  /** sdkKey → currently-attached fault marker (none → not in map). */
  readonly faults = new Map<string, FaultMarker>();
  /** Tracked count of seeded keys (informational; mirrors KV size). */
  seededKeys = 0;
  /** Bind address surfaced by /admin/state for debugging. */
  bindAddress = "";
  /**
   * The seeded key names, reported by `GET /admin/state` so a runner that is
   * not TypeScript learns the case set from the harness instead of
   * recomputing it (#783). Maintained by applySeed only.
   */
  readonly keys = new Set<string>();
  /**
   * Every config request the proxy served for a SEEDED key, in arrival
   * order — how a live SDK runner observes the request its SDK actually sent
   * (#783 Q1). Read through `GET /admin/requests`; cleared by a replacing
   * seed. Unseeded keys are not logged: any loopback caller can name any key,
   * and the log must stay bounded by the seed, not by the callers.
   */
  readonly requests = new Map<string, RecordedRequest[]>();
  /**
   * How many config requests for a seeded key the proxy has served since
   * boot. Never reset, never bounded: exec mode reads it to refuse a suite
   * that exited 0 without asking the harness anything (#793 review).
   */
  served = 0;
  /**
   * The same count per seeded key, never reset either: exec mode refuses a
   * suite that left a key its seed declares unasked (#926 A1), which the
   * request log cannot tell, since a replacing seed clears it and it is
   * capped per key.
   */
  readonly servedByKey = new Map<string, number>();

  recordRequest(sdkKey: string, request: RecordedRequest): void {
    if (!this.keys.has(sdkKey)) return;
    this.served++;
    this.servedByKey.set(sdkKey, (this.servedByKey.get(sdkKey) ?? 0) + 1);
    const log = this.requests.get(sdkKey) ?? [];
    log.push(request);
    // Bounded: a long-lived CLI session must not grow without limit. A runner
    // reads the most recent requests, so the oldest are the ones dropped.
    if (log.length > MAX_REQUESTS_PER_KEY) log.splice(0, log.length - MAX_REQUESTS_PER_KEY);
    this.requests.set(sdkKey, log);
  }

  /** The keys of `declared` no config request has asked for since boot, in order. */
  unserved(declared: readonly string[]): string[] {
    return declared.filter((k) => (this.servedByKey.get(k) ?? 0) === 0);
  }

  getFault(sdkKey: string): FaultMarker | undefined {
    return this.faults.get(sdkKey);
  }

  setFault(sdkKey: string, fault: FaultMarker): FaultMarker | null {
    return setFaultIn(this.faults, sdkKey, fault);
  }

  /** Swap in a whole fault map — only `applySeed` (seed-applier.ts) calls this. */
  replaceFaults(next: ReadonlyMap<string, FaultMarker>): void {
    this.faults.clear();
    for (const [k, v] of next) this.faults.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Loopback guard
// ---------------------------------------------------------------------------

/** Host names a loopback caller may address the harness by. */
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Who may call the admin API — decided here and only here (plan 680, decision
 * row 11). proxy-server.ts `route()` asks it once, before ANY /admin/* path
 * is dispatched — so a handler added later cannot be left unguarded. Returns true if the request
 * SHOULD continue, false if it was already answered with 403.
 *
 * A loopback source address alone is not enough: a page open in the
 * developer's browser also connects from 127.0.0.1, and with the `status`
 * fault it could make the harness serve whatever it likes. So the caller must
 * also look like a test client, not a browser:
 *  - no `Origin` header (browsers send it on cross-origin and on POST),
 *  - `Sec-Fetch-Site` absent or `none` (browsers send `cross-site` etc.),
 *  - a `Host` naming a loopback host on the bound port (DNS rebinding sends
 *    the attacker's host name).
 * Node `fetch` and python `requests` send none of the first two and a
 * loopback Host, so every legitimate client passes.
 */
export function enforceAdminCaller(req: IncomingMessage, res: ServerResponse): boolean {
  const refusal = adminCallerRefusal(req);
  if (refusal === null) return true;
  res.writeHead(403, { "content-type": "text/plain" });
  res.end(`Forbidden: ${refusal}`);
  return false;
}

function adminCallerRefusal(req: IncomingMessage): string | null {
  const remote = req.socket.remoteAddress ?? "";
  if (!ALLOWED_LOOPBACK.has(remote)) return "admin endpoints are loopback-only";
  if (req.headers.origin !== undefined) return "admin endpoints refuse browser (Origin) requests";
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "none") {
    return "admin endpoints refuse browser (Sec-Fetch-Site) requests";
  }
  const host = req.headers.host ?? "";
  const sep = host.lastIndexOf(":");
  const name = sep === -1 ? host : host.slice(0, sep);
  const port = sep === -1 ? "" : host.slice(sep + 1);
  if (!LOOPBACK_HOST_NAMES.has(name) || port !== String(req.socket.localPort)) {
    return "admin endpoints require a loopback Host on the bound port";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

/** Thrown by readJsonBody when the request body exceeds the cap (#341). */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

const DEFAULT_MAX_ADMIN_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * Hard cap on admin request-body size (#341). Configurable via
 * `LC_HARNESS_MAX_BODY_BYTES`, but always enforced (a missing/invalid value
 * falls back to the 1 MiB default — it can never be disabled). Read per-call
 * so tests can vary it. Even though admin endpoints are loopback-only
 * (FR-014), an unbounded buffer is a latent OOM/DoS surface.
 */
export function maxAdminBodyBytes(): number {
  const raw = process.env.LC_HARNESS_MAX_BODY_BYTES;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ADMIN_BODY_BYTES;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const cap = maxAdminBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > cap) {
      // Stop draining the socket and reject — handlers map this to 413.
      req.destroy();
      throw new PayloadTooLargeError(`admin request body exceeds ${cap} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Handler dependencies — passed in by proxy-server
// ---------------------------------------------------------------------------

export type AdminDeps = {
  host: WranglerHost;
  state: AdminState;
  /** Working directory used to resolve relative seedFile paths in /admin/reset. */
  cwd: string;
};

// ---------------------------------------------------------------------------
// POST /admin/reset
// ---------------------------------------------------------------------------

export async function handleReset(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return jsonResponse(res, 413, { ok: false, error: err.message });
    }
    return jsonResponse(res, 400, {
      ok: false,
      error: `invalid JSON body: ${(err as Error).message}`,
    });
  }

  let seed: Seed;
  try {
    seed = await resolveSeedInput(body, deps.cwd);
  } catch (err) {
    return jsonResponse(res, 400, {
      ok: false,
      error: err instanceof SeedValidationError ? err.message : (err as Error).message,
    });
  }

  try {
    // A reset replaces the whole state: KV, and the fault map with the seed's
    // own faults — faults injected before the reset do not survive it.
    await applySeed(deps, seed.keys, "replace");
    return jsonResponse(res, 200, { ok: true, seededKeys: seed.keys.length });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: `KV reset failed: ${(err as Error).message}`,
    });
  }
}

async function resolveSeedInput(body: unknown, cwd: string): Promise<Seed> {
  if (!body || typeof body !== "object") {
    throw new SeedValidationError("body must be an object", "");
  }
  const { seedFile, seed } = body as { seedFile?: unknown; seed?: unknown };
  if (seedFile && seed) {
    throw new SeedValidationError("exactly one of seedFile / seed must be provided", "");
  }
  if (seedFile) {
    if (typeof seedFile !== "string") {
      throw new SeedValidationError("seedFile must be a string", "seedFile");
    }
    // Path-traversal guard (security-critical, FR-014 spirit). The
    // admin endpoint is loopback-only, but any in-process attacker
    // (compromised test dep) could otherwise read arbitrary files
    // through this code path. We restrict seedFile to the cwd subtree
    // (typically the workspace root or the calling test's package
    // root) plus the harness's own `seeds/` directory. Absolute paths
    // outside both roots are refused.
    const resolved = isAbsolute(seedFile) ? seedFile : pathResolve(cwd, seedFile);
    const harnessSeedsRoot = pathResolve(__dirname, "..", "seeds");
    const cwdRoot = pathResolve(cwd) + pathSep;
    const seedsRootWithSep = harnessSeedsRoot + pathSep;
    if (!resolved.startsWith(cwdRoot) && !resolved.startsWith(seedsRootWithSep)) {
      throw new SeedValidationError(
        `seedFile must be under cwd (${cwd}) or the harness seeds/ dir`,
        "seedFile",
      );
    }
    const raw = await readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw);
    return parseSeedStrict(parsed);
  }
  if (seed) {
    return parseSeedStrict(seed);
  }
  throw new SeedValidationError("either seedFile or seed is required", "");
}

function parseSeedStrict(value: unknown): Seed {
  const result = SeedSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const pointer = first?.path.join("/") ?? "";
    throw new SeedValidationError(
      `${pointer ? pointer + ": " : ""}${first?.message ?? "invalid seed"}`,
      pointer,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// POST /admin/seed
// ---------------------------------------------------------------------------

export async function handleSeed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return jsonResponse(res, 413, { ok: false, error: err.message });
    }
    return jsonResponse(res, 400, {
      ok: false,
      error: `invalid JSON body: ${(err as Error).message}`,
    });
  }
  if (!body || typeof body !== "object" || !("keys" in body)) {
    return jsonResponse(res, 400, {
      ok: false,
      error: "body must contain a `keys` array",
    });
  }
  const parsed = SeededKeySchema.array().safeParse((body as { keys: unknown }).keys);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return jsonResponse(res, 400, {
      ok: false,
      error: `keys/${first?.path.join("/")}: ${first?.message}`,
    });
  }
  const keys = parsed.data;
  try {
    await applySeed(deps, keys, "merge");
    return jsonResponse(res, 200, { ok: true, appliedKeys: keys.length });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: `KV seed failed: ${(err as Error).message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/inject-fault
// ---------------------------------------------------------------------------

export async function handleInjectFault(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return jsonResponse(res, 413, { ok: false, error: err.message });
    }
    return jsonResponse(res, 400, {
      ok: false,
      error: `invalid JSON body: ${(err as Error).message}`,
    });
  }
  if (!body || typeof body !== "object" || !("sdkKey" in body) || !("fault" in body)) {
    return jsonResponse(res, 400, {
      ok: false,
      error: "body must contain `sdkKey` and `fault`",
    });
  }
  const { sdkKey, fault } = body as { sdkKey: unknown; fault: unknown };
  if (typeof sdkKey !== "string" || sdkKey.length === 0) {
    return jsonResponse(res, 400, { ok: false, error: "sdkKey must be a non-empty string" });
  }
  const faultParsed = FaultMarkerSchema.safeParse(fault);
  if (!faultParsed.success) {
    return jsonResponse(res, 400, {
      ok: false,
      error: `fault: ${faultParsed.error.issues[0]?.message ?? "invalid"}`,
    });
  }
  const previousFault = deps.state.setFault(sdkKey, faultParsed.data);
  return jsonResponse(res, 200, { ok: true, previousFault: previousFault ?? "none" });
}

// ---------------------------------------------------------------------------
// GET /admin/state
// ---------------------------------------------------------------------------

export function handleState(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): void {
  // fromEntries defines own properties, so an sdkKey such as "__proto__"
  // cannot reach the prototype of the object it builds.
  const faults: Record<string, FaultMarker> = Object.fromEntries(deps.state.faults);
  return jsonResponse(res, 200, {
    ok: true,
    seededKeys: deps.state.seededKeys,
    faults,
    bindAddress: deps.state.bindAddress,
    keys: [...deps.state.keys].sort(),
  });
}

// ---------------------------------------------------------------------------
// GET /admin/requests?sdkKey=<key> — read-only request log (#783)
// ---------------------------------------------------------------------------

export function handleRequests(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
  url: URL,
): void {
  const sdkKey = url.searchParams.get("sdkKey");
  if (!sdkKey) {
    return jsonResponse(res, 400, { ok: false, error: "query parameter `sdkKey` is required" });
  }
  const body: AdminRequestsResponse = {
    ok: true,
    requests: deps.state.requests.get(sdkKey) ?? [],
  };
  return jsonResponse(res, 200, body);
}
