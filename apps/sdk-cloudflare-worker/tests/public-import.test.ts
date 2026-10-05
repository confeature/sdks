// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.ts";

/**
 * Public-surface smoke test. Every named export listed in
 * `src/index.ts` MUST resolve to a non-undefined runtime value (for
 * values + classes + enums) or a non-undefined type bound (for
 * type-only exports, which TS erases at runtime but whose
 * resolution at this import site already proves the barrel compiles).
 *
 * Catches accidental drift between the barrel and the underlying
 * `@confeature/sdk-browser-js` surface — e.g. a re-export typo or a
 * symbol that was renamed upstream.
 */

const EXPECTED_VALUE_EXPORTS: ReadonlyArray<keyof typeof sdk> = [
  // Worker-specific
  "getConfeatureClient",
  "workersKvCache",
  "CONFEATURE_SDK_VERSION",
  // Re-exports from sdk-browser-js — values / classes / enums
  "ClientCacheState",
  "ConfeatureClient",
  "ConfigCatClient",
  "ConfigOverrideDataSource",
  "createConsoleLogger",
  "createFlagOverridesFromConfig",
  "createFlagOverridesFromMap",
  "DataGovernance",
  "DEFAULT_BASE_URL",
  "DEFAULT_CACHE_TTL_SECONDS",
  "DEFAULT_MAX_INIT_WAIT_TIME_SECONDS",
  "DEFAULT_POLL_INTERVAL_SECONDS",
  "DEFAULT_REQUEST_TIMEOUT_MS",
  "disposeAllClients",
  "FlagOverrides",
  "FormattableLogMessage",
  "getClient",
  "Hooks",
  "LogLevel",
  "MapOverrideDataSource",
  "OverrideBehaviour",
  "PollingMode",
  "PrerequisiteFlagComparator",
  "RefreshResult",
  "SegmentComparator",
  "SettingKeyValue",
  "SettingType",
  "User",
  "UserComparator",
];

describe("public surface", () => {
  for (const name of EXPECTED_VALUE_EXPORTS) {
    it(`exports a non-undefined value for "${name}"`, () => {
      expect(sdk[name]).toBeDefined();
    });
  }

  it("CONFEATURE_SDK_VERSION is a non-empty semver-shaped string", () => {
    expect(typeof sdk.CONFEATURE_SDK_VERSION).toBe("string");
    expect(sdk.CONFEATURE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("getConfeatureClient is a function", () => {
    expect(typeof sdk.getConfeatureClient).toBe("function");
  });

  it("workersKvCache is a function", () => {
    expect(typeof sdk.workersKvCache).toBe("function");
  });
});
