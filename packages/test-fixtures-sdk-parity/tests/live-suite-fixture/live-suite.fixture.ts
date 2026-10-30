// SPDX-License-Identifier: MIT

/**
 * A defineLiveWireSuite() run against the fake harness of
 * ../live-wire-suite-count.test.ts, which spawns vitest on this file alone.
 * Its fetcher answers every key with the Worker's unknown-key failure: US4
 * passes, and every seeded case fails, so each is declared a known bug and
 * runs as a passing `test.fails`. The run is green exactly when every test
 * ran; which tests run is the parent's `-t`.
 */

import { SdkErrorCode } from "@confeature/sdk-shared";

import { defineLiveWireSuite } from "../../src/wire-test-helpers.ts";

const keys = (process.env.FIXTURE_KEYS ?? "").split(",");

await defineLiveWireSuite({
  sdkName: "fixture-926",
  sdkVersion: "0.0.0",
  createFetcher: () => ({
    fetchAsync: () =>
      Promise.resolve({
        status: "failed",
        errorCode: SdkErrorCode.INVALID_SDK_KEY,
        errorMessage: "invalid SDK key (HTTP 403)",
      }),
  }),
  knownSdkBugs: Object.fromEntries(keys.map((k) => [k, "#926"])),
});
