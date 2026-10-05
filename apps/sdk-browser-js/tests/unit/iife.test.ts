// SPDX-License-Identifier: MIT

/**
 * IIFE bundle smoke test (FR-024 + US3).
 *
 * Loads the built IIFE bundle into a happy-dom sandbox via
 * `vm.runInNewContext` (avoids polluting the test process's globals)
 * and asserts the `Confeature` global carries all public exports.
 *
 * Skipped when `dist/index.iife.js` is absent — the test fails
 * meaningfully only after `vp pack` has run.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";
import { describe, expect, test } from "vitest";

const BUNDLE_PATH = fileURLToPath(new URL("../../dist/index.iife.js", import.meta.url));

const REQUIRED_EXPORTS = [
  "ConfeatureClient",
  "ConfigCatClient", // configcat-js parity alias
  "getClient",
  "disposeAllClients",
  "PollingMode",
  "LogLevel",
  "User",
  "FlagOverrides",
  "MapOverrideDataSource",
  "createFlagOverridesFromMap",
  "OverrideBehaviour",
  "DEFAULT_BASE_URL",
  "DEFAULT_POLL_INTERVAL_SECONDS",
  "CONFEATURE_SDK_VERSION",
];

describe("IIFE bundle global surface (FR-024)", () => {
  const bundleExists = existsSync(BUNDLE_PATH);

  test.skipIf(!bundleExists)("Confeature global is constructable", () => {
    const code = readFileSync(BUNDLE_PATH, "utf8");
    const sandbox = vm.createContext({});
    vm.runInContext(code, sandbox);
    const confeature = (sandbox as Record<string, unknown>).Confeature;
    expect(confeature).toBeDefined();
    expect(typeof confeature).toBe("object");
  });

  test.skipIf(!bundleExists)("every required export is present on the global", () => {
    const code = readFileSync(BUNDLE_PATH, "utf8");
    const sandbox = vm.createContext({});
    vm.runInContext(code, sandbox);
    const confeature = (sandbox as Record<string, unknown>).Confeature as Record<string, unknown>;
    for (const name of REQUIRED_EXPORTS) {
      expect(confeature[name], `missing ${name} on Confeature IIFE global`).toBeDefined();
    }
  });
});
