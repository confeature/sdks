// SPDX-License-Identifier: MIT

/**
 * Public types for the live-contract test harness.
 *
 * These types are the shared vocabulary for:
 * - seed files (Seed, SeededKey, FaultMarker)
 * - harness lifecycle (HarnessConfig, HarnessHandle)
 * - admin REST surface (AdminResetRequest, AdminSeedRequest, AdminInjectFaultRequest)
 *
 * Spec 113's data model records the rationale.
 */

import type { z } from "zod";
import type {
  ConfigV6BodySchema,
  FaultMarkerSchema,
  SeedSchema,
  SeededKeySchema,
} from "./seed-schema.js";

// ---------------------------------------------------------------------------
// Fault vocabulary and seed format
//
// Derived from the zod schema in seed-schema.ts, which is the ONLY place the
// vocabulary and its validity rules are decided (plan 680, decision rows 1-2).
// A hand-written union here was a second spelling that drifted silently.
// ---------------------------------------------------------------------------

/**
 * How the proxy substitutes the upstream's real response for a given sdk-key.
 * See `FaultMarkerSchema` for every variant and its rules.
 */
export type FaultMarker = z.infer<typeof FaultMarkerSchema>;

/**
 * Structural shape of a config_v6 body accepted as a payload.
 * Validated structurally only — the CDN Worker owns the deep schema.
 */
export type ConfigV6Body = z.infer<typeof ConfigV6BodySchema>;

/**
 * A single KV record the harness seeds on boot, on /admin/reset or via
 * /admin/seed. A null payload means "absent from KV".
 */
export type SeededKey = z.infer<typeof SeededKeySchema>;

/** The complete harness state for one wire-case scenario. */
export type Seed = z.infer<typeof SeedSchema>;

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

/**
 * Configuration passed to startHarness().
 */
export type HarnessConfig = {
  /**
   * Absolute path to the upstream Worker's entry. Required, with no fallback:
   * `startHarness()` throws a `HarnessConfigError` when it is missing (#858).
   * `referenceOrigin()` in src/upstream.ts supplies it (#861); the private CDN
   * Worker is an explicit opt-in until #795.
   */
  cdnEntry: string;
  /** Absolute path to that Worker's wrangler.toml. Required — Wrangler reads bindings + compat date from it. */
  cdnConfigPath: string;
  /** Optional seed — if absent, KV starts empty. */
  initialSeed?: Seed;
  /** Bind address — hardcoded to 127.0.0.1 in v1; reserved for forward compat. */
  bindAddress?: "127.0.0.1";
  /** Bind port — 0 means OS-assigned (default). */
  bindPort?: number;
  /** Max ms to wait for graceful wrangler teardown on stop(). Default 5000. */
  shutdownGrace?: number;
};

/**
 * The handle returned by startHarness(). Holds the bound address and a
 * lifecycle stop() method.
 */
export type HarnessHandle = {
  /** "http://127.0.0.1:<port>" — ready to receive connections. */
  url: string;
  /** Graceful shutdown — disposes Miniflare, closes the proxy. Resolves when done. */
  stop(): Promise<void>;
  /** Config requests served for a seeded key since boot (AdminState.served). */
  served(): number;
};

// ---------------------------------------------------------------------------
// Admin REST types
// ---------------------------------------------------------------------------

export type AdminResetRequest = {
  /** Relative file path to a seed JSON file. Mutually exclusive with `seed`. */
  seedFile?: string;
  /** Inline seed. Mutually exclusive with `seedFile`. */
  seed?: Seed;
};

export type AdminResetResponse = { ok: true; seededKeys: number } | { ok: false; error: string };

export type AdminSeedRequest = {
  /** Keys to merge additively into current KV state. */
  keys: SeededKey[];
};

export type AdminSeedResponse = { ok: true; appliedKeys: number } | { ok: false; error: string };

export type AdminInjectFaultRequest = {
  /** Which SDK key to attach the fault to. */
  sdkKey: string;
  /** The fault to inject (or "none" to clear). */
  fault: FaultMarker;
};

export type AdminInjectFaultResponse =
  | { ok: true; previousFault: FaultMarker | null }
  | { ok: false; error: string };

/** One config request as the harness proxy received it (#783). */
export type RecordedRequest = {
  /** Path + query, e.g. `/configuration-files/<key>/config_v6.json?sdk=…`. */
  url: string;
  /** The `If-None-Match` header as sent, or null when absent. */
  ifNoneMatch: string | null;
};

export type AdminRequestsResponse =
  | { ok: true; requests: RecordedRequest[] }
  | { ok: false; error: string };

export type AdminStateResponse = {
  ok: true;
  seededKeys: number;
  faults: Record<string, FaultMarker>;
  bindAddress: string;
  /** Seeded key names (the case ids under `--corpus-seed`). */
  keys: string[];
};
