// SPDX-License-Identifier: MIT

import {
  type FlagOverrides,
  type IConfigCatLogger,
  type ProjectConfig,
  type User,
} from "@confeature/sdk-shared";

import type { Hooks } from "./hooks.ts";

/**
 * Polling strategies — values match `configcat-common`'s `PollingMode`
 * exactly so customer code that switches on the enum keeps working.
 */
export const PollingMode = {
  AutoPoll: 0,
  LazyLoad: 1,
  ManualPoll: 2,
} as const;
export type PollingMode = (typeof PollingMode)[keyof typeof PollingMode];

/**
 * Data-governance hint — matches `configcat-common`. v1 accepts both
 * values and uses the same `https://cdn.confeature.io` base URL for
 * both; the runtime configuration option `baseUrl` overrides this.
 */
export const DataGovernance = {
  Global: 0,
  EuOnly: 1,
} as const;
export type DataGovernance = (typeof DataGovernance)[keyof typeof DataGovernance];

/**
 * External-cache interface — mirrors `configcat-common`'s
 * `IConfigCatCache`. Customers can pass a custom impl through
 * `IOptions.cache`. v1 wires this through the filesystem / memory
 * cache layer in `bun-file-cache.ts`.
 */
export interface IConfigCatCache {
  set(key: string, value: string): void | Promise<void>;
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
}

/**
 * Base options shared across all polling modes — matches
 * `configcat-common`'s `IOptions`.
 */
export interface IOptions {
  /** Custom logger. Default: no-op. */
  logger?: IConfigCatLogger;
  /** Override the CDN URL. Default: `https://cdn.confeature.io`. */
  baseUrl?: string;
  /** HTTP request timeout in milliseconds. Default: 10000. Minimum: 1000. */
  requestTimeoutMs?: number;
  /** Accepted, ignored in v1. */
  proxy?: string;
  /** Accepted; both values map to the same CDN in v1. */
  dataGovernance?: DataGovernance;
  /**
   * Cache backend selection. `"filesystem"` (default) persists the
   * config under `${os.tmpdir()}/confeature-cache-v1/` via
   * `Bun.file()`; `"memory"` bypasses disk entirely; a custom
   * `IConfigCatCache` impl is accepted but ignored in v1.
   */
  cache?: "filesystem" | "memory" | IConfigCatCache;
  /** Local flag overrides — applied per `OverrideBehaviour`. */
  flagOverrides?: FlagOverrides;
  /** Default user applied to evaluations when none is passed. */
  defaultUser?: User;
  /** Start in offline mode (no fetches). */
  offline?: boolean;
  /** Hook setup callback — runs synchronously before initial fetch. */
  setupHooks?: (hooks: Hooks) => void;
}

/** AutoPoll-specific options — matches `configcat-common`. */
export interface IAutoPollOptions extends IOptions {
  /** Polling cadence in seconds. Default: 60. Minimum: 1. */
  pollIntervalSeconds?: number;
  /**
   * Maximum time `waitForReady()` will wait for the first successful
   * fetch. Default: 5. Negative = wait forever; 0 = don't wait.
   */
  maxInitWaitTimeSeconds?: number;
}

/** LazyLoad-specific options. */
export interface ILazyLoadingOptions extends IOptions {
  /** Cache TTL in seconds. Default: 60. */
  cacheTimeToLiveSeconds?: number;
}

/** ManualPoll-specific options. */
// Marker interface for ManualPoll — no mode-specific fields beyond
// the base. Disabling the lint rule here because the empty body is
// load-bearing: it preserves shape parity with configcat-common's
// IManualPollOptions for users who reference the type by name.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IManualPollOptions extends IOptions {}

/**
 * Effective resolved options used inside the SDK. `IOptions` is the
 * customer-facing shape; this is the post-defaults internal view.
 */
export interface ResolvedOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  cacheTtlMs: number;
  maxInitWaitTimeMs: number;
  offline: boolean;
  defaultUser: User | undefined;
  flagOverrides: FlagOverrides | undefined;
  cacheKind: "filesystem" | "memory";
}

/** Defaults — match configcat-common's documented values; the
 * `requestTimeoutMs` default of 10 s matches the Bun-spec FR-013. */
export const DEFAULT_BASE_URL = "https://cdn.confeature.io";
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_CACHE_TTL_SECONDS = 60;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_INIT_WAIT_TIME_SECONDS = 5;
export const MIN_POLL_INTERVAL_SECONDS = 1;
export const MIN_CACHE_TTL_SECONDS = 1;
export const MIN_REQUEST_TIMEOUT_MS = 1000;

/**
 * Resolve a customer-facing options bundle into the internal
 * `ResolvedOptions` shape. Out-of-range values are clamped (and the
 * caller is expected to log via `LoggerWrapper.configWarn` so the
 * customer sees what happened).
 */
export function resolveOptions(
  options: (IOptions & IAutoPollOptions & ILazyLoadingOptions) | undefined,
  onWarn?: (message: string) => void,
): ResolvedOptions {
  const baseUrl = sanitiseBaseUrl(options?.baseUrl, onWarn);
  const requestTimeoutMs = clampRequestTimeoutMs(options?.requestTimeoutMs, onWarn);
  const pollIntervalMs = clampPollIntervalMs(options?.pollIntervalSeconds, onWarn);
  const cacheTtlMs = clampCacheTtlMs(options?.cacheTimeToLiveSeconds, onWarn);
  const maxInitWaitTimeMs = resolveMaxInitWaitTimeMs(options?.maxInitWaitTimeSeconds);
  const cacheKind: "filesystem" | "memory" = options?.cache === "memory" ? "memory" : "filesystem";
  return {
    baseUrl,
    requestTimeoutMs,
    pollIntervalMs,
    cacheTtlMs,
    maxInitWaitTimeMs,
    offline: options?.offline === true,
    defaultUser: options?.defaultUser,
    flagOverrides: options?.flagOverrides,
    cacheKind,
  };
}

function sanitiseBaseUrl(url: string | undefined, onWarn?: (message: string) => void): string {
  if (url === undefined || url === null || url === "") return DEFAULT_BASE_URL;
  try {
    // Throws on invalid URLs — fall through to the default.
    new URL(url);
    return url.replace(/\/+$/, "");
  } catch {
    onWarn?.(`Invalid baseUrl "${url}"; using default "${DEFAULT_BASE_URL}".`);
    return DEFAULT_BASE_URL;
  }
}

function clampRequestTimeoutMs(
  value: number | undefined,
  onWarn?: (message: string) => void,
): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < MIN_REQUEST_TIMEOUT_MS) {
    onWarn?.(
      `requestTimeoutMs ${String(value)} below minimum ${MIN_REQUEST_TIMEOUT_MS}; clamping.`,
    );
    return MIN_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function clampPollIntervalMs(
  seconds: number | undefined,
  onWarn?: (message: string) => void,
): number {
  if (seconds === undefined) return DEFAULT_POLL_INTERVAL_SECONDS * 1000;
  if (!Number.isFinite(seconds) || seconds < MIN_POLL_INTERVAL_SECONDS) {
    onWarn?.(
      `pollIntervalSeconds ${String(seconds)} below minimum ${MIN_POLL_INTERVAL_SECONDS}; clamping.`,
    );
    return MIN_POLL_INTERVAL_SECONDS * 1000;
  }
  return Math.floor(seconds * 1000);
}

function clampCacheTtlMs(seconds: number | undefined, onWarn?: (message: string) => void): number {
  if (seconds === undefined) return DEFAULT_CACHE_TTL_SECONDS * 1000;
  if (!Number.isFinite(seconds) || seconds < MIN_CACHE_TTL_SECONDS) {
    onWarn?.(
      `cacheTimeToLiveSeconds ${String(seconds)} below minimum ${MIN_CACHE_TTL_SECONDS}; clamping.`,
    );
    return MIN_CACHE_TTL_SECONDS * 1000;
  }
  return Math.floor(seconds * 1000);
}

function resolveMaxInitWaitTimeMs(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_MAX_INIT_WAIT_TIME_SECONDS * 1000;
  if (!Number.isFinite(seconds)) return DEFAULT_MAX_INIT_WAIT_TIME_SECONDS * 1000;
  if (seconds < 0) return -1;
  return Math.floor(seconds * 1000);
}

/**
 * Re-exported here to avoid a circular import in `client.ts` (the
 * snapshot type is intrinsically tied to the cache state).
 */
export type { ProjectConfig };
