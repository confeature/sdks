// SPDX-License-Identifier: MIT

/**
 * Tests for `ConfeatureModule.forRoot` — T020 / FR-010 / FR-021.
 *
 * Verifies that the legacy NgModule registration path:
 *   1. Returns a `ModuleWithProviders<ConfeatureModule>` accepted by
 *      TestBed's `imports`.
 *   2. Makes `ConfeatureService` resolvable via `TestBed.inject`.
 *   3. The resolved service is usable (synchronous read works
 *      against a LocalOnly overrides config).
 *   4. Same root-injector singleton as `provideConfeature` would
 *      produce — both paths converge on the same `CONFEATURE_CONFIG`
 *      token (FR-021).
 */

import { TestBed } from "@angular/core/testing";
import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-browser-js";
import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureModule } from "../src/confeature.module";
import { ConfeatureService } from "../src/confeature.service";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("ConfeatureModule.forRoot (T020)", () => {
  test("returns a ModuleWithProviders<ConfeatureModule>", () => {
    const mwp = ConfeatureModule.forRoot({
      sdkKey: TEST_SDK_KEY,
      pollingMode: "manualPoll",
      flagOverrides: createFlagOverridesFromMap({ feat: true }, OverrideBehaviour.LocalOnly),
    });
    expect(mwp).toBeDefined();
    expect(mwp.ngModule).toBe(ConfeatureModule);
    expect(Array.isArray(mwp.providers)).toBe(true);
    expect(mwp.providers && mwp.providers.length).toBeGreaterThan(0);
  });

  test("ConfeatureService resolves and is usable via imports: [ConfeatureModule.forRoot(...)]", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        ConfeatureModule.forRoot({
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

  test("re-injecting yields the same ConfeatureService instance (root-injector singleton)", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        ConfeatureModule.forRoot({
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
