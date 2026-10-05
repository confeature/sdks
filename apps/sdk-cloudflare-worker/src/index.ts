// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/sdk-cloudflare-worker`.
 *
 * The Worker-specific value-add is small on purpose:
 *  - `getConfeatureClient(options)` — Workers-friendly factory that
 *    forwards into `ConfeatureClient.getInstance(...)` from
 *    `@confeature/sdk-browser-js`. Mirrors
 *    `@configcat/cloudflare-worker-client`'s `getClient`.
 *  - `workersKvCache(env.KV, options?)` — `IConfigCatCache` adapter
 *    over the Cloudflare KV API.
 *
 * Everything else is re-exported verbatim from
 * `@confeature/sdk-browser-js` so customers can still drop down to
 * the lower-level `ConfeatureClient` / `getClient` entry if they want
 * full parity with `configcat-js` (constitution Principle II — every
 * symbol that ConfigCat exports MUST be exported here too).
 */

// ---- Worker-specific factory --------------------------------------
export { type CloudflareWorkerClientOptions, getConfeatureClient } from "./client.ts";

// ---- Worker-specific cache adapter --------------------------------
export { type WorkersKvCacheOptions, workersKvCache } from "./kv-cache.ts";

// ---- Version ------------------------------------------------------
export { CONFEATURE_SDK_VERSION } from "./version.ts";

// ---- Re-exports from @confeature/sdk-browser-js -------------------
// Mirrors `@configcat/cloudflare-worker-client`'s public surface 1:1
// so `import * as configcat from "@confeature/sdk-cloudflare-worker"`
// works for a migrating customer.
export {
  ClientCacheState,
  ConfeatureClient,
  ConfigCatClient,
  ConfigOverrideDataSource,
  createConsoleLogger,
  createFlagOverridesFromConfig,
  createFlagOverridesFromMap,
  DataGovernance,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_INIT_WAIT_TIME_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  disposeAllClients,
  FlagOverrides,
  FormattableLogMessage,
  getClient,
  type HookEvents,
  Hooks,
  type IAutoPollOptions,
  type IConfig,
  type IConfigCatCache,
  type IConfigCatClient,
  type IConfigCatClientSnapshot,
  type IConfigCatLogger,
  type IEvaluationDetails,
  type ILazyLoadingOptions,
  type IManualPollOptions,
  type IOptions,
  type IOverrideDataSource,
  type IPercentageOption,
  type IPreferences,
  type IProvidesHooks,
  type ISegment,
  type ISetting,
  type ISettingValue,
  type ITargetingRule,
  LogLevel,
  MapOverrideDataSource,
  OverrideBehaviour,
  PollingMode,
  PrerequisiteFlagComparator,
  type ProjectConfig,
  RefreshResult,
  SegmentComparator,
  SettingKeyValue,
  SettingType,
  type SettingTypeOf,
  User,
  UserComparator,
} from "@confeature/sdk-browser-js";
