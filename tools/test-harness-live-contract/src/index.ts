// SPDX-License-Identifier: MIT

/**
 * Public API for in-workspace TS consumers (sdk-node, sdk-browser-js, …).
 *
 * Non-TS consumers (sdk-python, sdk-go, …) launch the harness as a subprocess
 * via the CLI in src/cli.ts — see contracts/cli.md.
 */

export { startHarness, HarnessConfigError, HarnessShutdownTimeout } from "./harness.js";
export { referenceOrigin } from "./upstream.js";
export type { Upstream } from "./upstream.js";
export type {
  Seed,
  SeededKey,
  ConfigV6Body,
  FaultMarker,
  HarnessConfig,
  HarnessHandle,
  AdminResetRequest,
  AdminResetResponse,
  AdminSeedRequest,
  AdminSeedResponse,
  AdminInjectFaultRequest,
  AdminInjectFaultResponse,
  AdminStateResponse,
  AdminRequestsResponse,
  RecordedRequest,
} from "./types.js";
export { SeedValidationError } from "./seed-loader.js";
export { buildCorpusSeed, seededCaseIds, timeoutHoldMs } from "./corpus-seed.js";
export { SeedSchema, SeededKeySchema, FaultMarkerSchema } from "./seed-schema.js";
