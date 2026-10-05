// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/sdk-deno`. Mirrors `configcat-js`'s
 * `index.ts` export list verbatim so a `* as configcat` re-import
 * works drop-in (constitution Principle II).
 *
 * Reference: the `configcat-js@^9.4.0` `index.d.ts` is the
 * authoritative source for what MUST be exported here.
 */

// ---- Functions / canonical entries ---------------------------------
export {
  ConfeatureClient,
  ConfigCatClient,
  disposeAllClients,
  getClient,
  type IConfigCatClient,
  type IConfigCatClientSnapshot,
  SettingKeyValue,
} from "./client.ts";

// ---- Polling / governance enums ------------------------------------
export {
  DataGovernance,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_INIT_WAIT_TIME_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type IAutoPollOptions,
  type IConfigCatCache,
  type ILazyLoadingOptions,
  type IManualPollOptions,
  type IOptions,
  PollingMode,
} from "./options.ts";

// ---- Logger --------------------------------------------------------
export { DenoLogger } from "./deno-logger.ts";
export {
  ConfigCatConsoleLogger,
  createConsoleLogger,
  FormattableLogMessage,
  type IConfigCatLogger,
  LogLevel,
} from "@confeature/sdk-shared";

// ---- Hooks ---------------------------------------------------------
export { Hooks, type HookEvents, type IProvidesHooks } from "./hooks.ts";

// ---- Refresh + cache state ----------------------------------------
export { ClientCacheState, RefreshResult } from "@confeature/sdk-shared";

// ---- Flag overrides ------------------------------------------------
export {
  ConfigOverrideDataSource,
  createFlagOverridesFromConfig,
  createFlagOverridesFromMap,
  FlagOverrides,
  type IOverrideDataSource,
  MapOverrideDataSource,
  OverrideBehaviour,
} from "@confeature/sdk-shared";

// ---- User ----------------------------------------------------------
export { User } from "@confeature/sdk-shared";

// ---- Evaluator types ----------------------------------------------
export type { IEvaluationDetails, SettingTypeOf } from "@confeature/sdk-shared";

// ---- Wire types (config_v6) ---------------------------------------
export {
  type IConfig,
  type IPercentageOption,
  type IPreferences,
  type ISegment,
  type ISetting,
  type ISettingValue,
  type ITargetingRule,
  PrerequisiteFlagComparator,
  SegmentComparator,
  SettingType,
  UserComparator,
} from "@confeature/sdk-shared";

// ---- Project config (advanced) ------------------------------------
export { ProjectConfig } from "@confeature/sdk-shared";

// ---- Version -------------------------------------------------------
export { CONFEATURE_SDK_VERSION } from "./version.ts";
