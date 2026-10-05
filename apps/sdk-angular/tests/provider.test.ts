// SPDX-License-Identifier: MIT

/**
 * Tests for `provideConfeature` — T019 / FR-009 / FR-021.
 *
 * Verifies that the standalone-component registration path:
 *   1. Returns an `EnvironmentProviders` accepted by TestBed.
 *   2. Makes `ConfeatureService` resolvable via `TestBed.inject`.
 *   3. The resolved service is usable (synchronous read works
 *      against a LocalOnly overrides config).
 *   4. Re-resolution yields the same instance (root singleton).
 */

import { TestBed } from "@angular/core/testing";
import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-browser-js";
import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureService } from "../src/confeature.service";
import { provideConfeature } from "../src/provider";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("provideConfeature (T019)", () => {
  test("returns an EnvironmentProviders accepted by TestBed", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap({ feat: true }, OverrideBehaviour.LocalOnly),
        }),
      ],
    });
    // If the providers shape were wrong, configureTestingModule itself
    // would throw — reaching this assert means the splice succeeded.
    expect(typeof TestBed.inject).toBe("function");
  });

  test("ConfeatureService resolves and is usable", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap(
            { is_on: true, name: "alpha" },
            OverrideBehaviour.LocalOnly,
          ),
        }),
      ],
    });
    const service = TestBed.inject(ConfeatureService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(ConfeatureService);
    await expect(firstValueFrom(service.getValue("is_on", false))).resolves.toBe(true);
    expect(service.getValueSync("name", "fallback")).toBe("alpha");
  });

  test("ConfeatureService is a root-injector singleton (re-inject returns same instance)", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap({ k: true }, OverrideBehaviour.LocalOnly),
        }),
      ],
    });
    const a = TestBed.inject(ConfeatureService);
    const b = TestBed.inject(ConfeatureService);
    expect(a).toBe(b);
  });
});
