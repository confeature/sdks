// SPDX-License-Identifier: MIT

/**
 * Public configuration type for the Angular SDK.
 *
 * Mirrors `@configcat/ng-client`'s configuration shape byte-identically
 * (FR-017 / FR-018). The companion `CONFEATURE_CONFIG` injection
 * token (in `./internal/confeature-config.token.ts`) carries an
 * instance of this interface from `provideConfeature` (or
 * `ConfeatureModule.forRoot`) to `ConfeatureService`'s constructor.
 *
 * Defaults match `@configcat/ng-client` (research §R6):
 *   - pollingMode             : "autoPoll"
 *   - pollIntervalSeconds     : 60
 *   - cacheRefreshIntervalSeconds : 60
 *   - logLevel                : LogLevel.Warn
 *   - baseUrl                 : "https://cdn-global.confeature.io" (sdk-browser-js default)
 */

import type { FlagOverrides, IConfigCatLogger, LogLevel } from "@confeature/sdk-browser-js";

/**
 * Polling strategy string union. Mirrors the ConfigCat ng-client
 * config shape (string literals instead of the runtime `PollingMode`
 * enum) so consumers don't need to import an enum to build config.
 */
export type ConfeaturePollingMode = "autoPoll" | "lazyLoad" | "manualPoll";

/**
 * Immutable record passed to `provideConfeature(config)` or
 * `ConfeatureModule.forRoot(config)`.
 */
export interface ConfeatureConfig {
  /** Confeature SDK key. Required. NEVER logged (FR-025). */
  sdkKey: string;

  /** Polling mode. Default: "autoPoll". */
  pollingMode?: ConfeaturePollingMode;

  /** Auto-poll interval in seconds. Default: 60. */
  pollIntervalSeconds?: number;

  /** Lazy-load cache TTL in seconds. Default: 60. */
  cacheRefreshIntervalSeconds?: number;

  /** Override CDN base URL. Default: sdk-browser-js's DEFAULT_BASE_URL. */
  baseUrl?: string;

  /** Flag overrides (LocalOnly / LocalOverRemote / RemoteOverLocal). */
  flagOverrides?: FlagOverrides;

  /** Custom logger; defaults to sdk-browser-js's console logger. */
  logger?: IConfigCatLogger;

  /** Log level. Default: LogLevel.Warn. */
  logLevel?: LogLevel;
}

/**
 * Default values applied when a field is omitted from `ConfeatureConfig`.
 * Exposed for tests + downstream documentation; consumers should NOT
 * mutate this object.
 */
export const DEFAULT_POLLING_MODE: ConfeaturePollingMode = "autoPoll";
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_CACHE_REFRESH_INTERVAL_SECONDS = 60;
