// SPDX-License-Identifier: MIT

/**
 * Public surface of `@confeature/sdk-shared`.
 *
 * Every Confeature SDK (`apps/sdk-*`) imports from here. The package is
 * runtime-agnostic by construction (no `node:*`, no DOM globals,
 * no Cloudflare bindings); per-runtime glue lives inside each SDK
 * package.
 *
 * Re-export discipline: single named-export entry — sub-paths are NOT
 * exported (research §R12) so bundlers can tree-shake against one
 * stable path.
 */

// ---- Evaluator + evaluator types -----------------------------------
export type {
  ConditionOutcome,
  EvaluateContext,
  IEvaluationDetails,
  SettingResult,
  SettingTypeOf,
} from "./evaluator.ts";
export { RolloutEvaluator } from "./evaluator.ts";

// ---- Project config (cache unit) -----------------------------------
export { ProjectConfig } from "./project-config.ts";

// ---- Wire types (config_v6.json) -----------------------------------
export {
  type IConfig,
  type ICondition,
  type IPercentageOption,
  type IPreferences,
  type IPrerequisiteFlagCondition,
  type ISegment,
  type ISegmentCondition,
  type IServedValue,
  type ISetting,
  type ISettingValue,
  type ITargetingRule,
  type IUserCondition,
  isConfigShape,
  PrerequisiteFlagComparator,
  SegmentComparator,
  SettingType,
  UserComparator,
} from "./config-json.ts";

// ---- Hashing (vendored pure-JS SHA-1 / SHA-256) --------------------
export { hashComparisonValue, percentageBucket, sha1, sha256 } from "./hash.ts";

// ---- Semver (vendored common-js semantics) -------------------------
export { parseSemVer, SemVer } from "./semver.ts";

// ---- SDK-key helpers -----------------------------------------------
export {
  CONFEATURE_SDK_KEY_PATTERN,
  deriveCacheKey,
  deriveCacheKeySync,
  isValidConfeatureKeyFormat,
  redactSdkKey,
} from "./sdk-key.ts";

// ---- User context ---------------------------------------------------
export { getUserAttribute, User } from "./user.ts";

// ---- Evaluation-log trace (ADR 0003 / #495, #497) ------------------
export {
  EVAL_LOG_EVENT_ID,
  EvaluateLogBuilder,
  formatUserComparator,
  settingValueToString,
} from "./eval-log.ts";

// ---- Logger ---------------------------------------------------------
export {
  ConfigCatConsoleLogger,
  createConsoleLogger,
  FormattableLogMessage,
  type IConfigCatLogger,
  LoggerWrapper,
  LogLevel,
  NullLogger,
} from "./logger.ts";

// ---- Refresh + cache state -----------------------------------------
export { ClientCacheState, RefreshResult } from "./refresh-result.ts";

// ---- Flag overrides ------------------------------------------------
export {
  ConfigOverrideDataSource,
  createFlagOverridesFromConfig,
  createFlagOverridesFromMap,
  FlagOverrides,
  type IOverrideDataSource,
  MapOverrideDataSource,
  OverrideBehaviour,
} from "./flag-overrides.ts";

// ---- Query-param flag overrides (spec 078 / #271 D5) ---------------
export {
  createFlagOverridesFromQueryParams,
  type IQueryStringProvider,
} from "./query-param-overrides.ts";

// ---- Synchronous override evaluation (shared by WHATWG-fetch SDKs) -
export {
  evaluateFullConfigOverrideDetailsSync,
  evaluateFullConfigOverrideSync,
  evaluateOverride,
  evaluateOverrideDetails,
  evaluateOverrideSync,
} from "./override-eval.ts";

// ---- Shared internal types -----------------------------------------
export { SdkErrorCode } from "./types.ts";

// ---- HTTP config fetcher (WHATWG fetch) ----------------------------
export {
  buildConfigUrl,
  type FetchOutcome,
  HttpConfigFetcher,
  type IConfigFetcher,
} from "./config-fetcher.ts";

// ---- Version constant ----------------------------------------------
export { CONFEATURE_SDK_VERSION } from "./version.ts";
