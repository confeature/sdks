// SPDX-License-Identifier: MIT

/**
 * Internal SDK error codes used as `eventId` in logger calls.
 *
 * Stable across releases so customers can filter / alert by event.
 * Reference: research.md §R4 (Confeature) — same code list configcat-js
 * uses internally for its own log lines.
 *
 * This module is the shared subset of the original `apps/sdk-node/src/types.ts`.
 * Runtime-specific helpers (e.g. `OptionsForPollingMode`) stay in each
 * SDK package because they reference per-runtime option shapes.
 */
export const SdkErrorCode = {
  /** Network throw, non-2xx (other than 304), or DNS failure. */
  FETCH_FAILED: "FETCH_FAILED",
  /** AbortError caused by the SDK's request timeout (NOT dispose()). */
  FETCH_TIMEOUT: "FETCH_TIMEOUT",
  /** `JSON.parse` threw, or top-level shape was not `{p, f, s}`. */
  PARSE_FAILED: "PARSE_FAILED",
  /** Eval for a key that is not present in the current config. */
  KEY_NOT_FOUND: "KEY_NOT_FOUND",
  /** Non-boolean setting (v1 supports boolean only) or default-type mismatch. */
  TYPE_MISMATCH: "TYPE_MISMATCH",
  /** Catch-all for any other throw inside the eval path. */
  EVAL_FAILED: "EVAL_FAILED",
  /** SDK key failed format validation or CDN returned 403/404. */
  INVALID_SDK_KEY: "INVALID_SDK_KEY",
  /** Construction-time warning (e.g. LazyLoad/ManualPoll routed to AutoPoll in v1). */
  CONFIG_WARN: "CONFIG_WARN",
} as const;
export type SdkErrorCode = (typeof SdkErrorCode)[keyof typeof SdkErrorCode];
