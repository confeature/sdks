// SPDX-License-Identifier: MIT

/**
 * Public-import smoke test — T032 / SC-010 / FR-013.
 *
 * Imports every documented public symbol via the package barrel
 * (`src/index.ts` — the runtime entry that ng-packagr funnels into
 * `dist/fesm2022/*.mjs`) and asserts it is defined + has the
 * expected shape (class / function / token).
 *
 * Catches:
 *   - Missing re-exports in src/index.ts
 *   - Accidental rename / deletion of a public symbol
 *   - Tree-shaken-into-undefined exports
 */

import { InjectionToken } from "@angular/core";
import { describe, expect, test } from "vitest";

import {
  CONFEATURE_CONFIG,
  ConfeatureClient,
  ConfeatureFlagDirective,
  ConfeatureFlagPipe,
  ConfeatureModule,
  ConfeatureService,
  ConfigOverrideDataSource,
  createFlagOverridesFromConfig,
  createFlagOverridesFromMap,
  DEFAULT_CACHE_REFRESH_INTERVAL_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLLING_MODE,
  FlagOverrides,
  LogLevel,
  MapOverrideDataSource,
  OverrideBehaviour,
  PollingMode,
  provideConfeature,
  SDK_VERSION,
  User,
} from "../src/index";

describe("Public-import smoke (T032 / SC-010 / FR-013)", () => {
  test("version stamp is exported", () => {
    expect(typeof SDK_VERSION).toBe("string");
    expect(SDK_VERSION.length).toBeGreaterThan(0);
  });

  test("Angular-flavoured config defaults are exported", () => {
    expect(DEFAULT_POLLING_MODE).toBe("autoPoll");
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(60);
    expect(DEFAULT_CACHE_REFRESH_INTERVAL_SECONDS).toBe(60);
  });

  test("CONFEATURE_CONFIG is an InjectionToken", () => {
    expect(CONFEATURE_CONFIG).toBeInstanceOf(InjectionToken);
  });

  test("ConfeatureService is a class", () => {
    expect(typeof ConfeatureService).toBe("function");
    expect(ConfeatureService.name).toBe("ConfeatureService");
  });

  test("provideConfeature is a function", () => {
    expect(typeof provideConfeature).toBe("function");
  });

  test("ConfeatureModule has a forRoot static method", () => {
    expect(typeof ConfeatureModule).toBe("function");
    expect(typeof ConfeatureModule.forRoot).toBe("function");
  });

  test("Directive + Pipe classes are exported", () => {
    expect(typeof ConfeatureFlagDirective).toBe("function");
    expect(ConfeatureFlagDirective.name).toBe("ConfeatureFlagDirective");
    expect(typeof ConfeatureFlagPipe).toBe("function");
    expect(ConfeatureFlagPipe.name).toBe("ConfeatureFlagPipe");
  });

  test("re-exports from sdk-browser-js are present", () => {
    expect(typeof ConfeatureClient).toBe("function");
    expect(typeof User).toBe("function");
    expect(typeof FlagOverrides).toBe("function");
    expect(typeof MapOverrideDataSource).toBe("function");
    expect(typeof createFlagOverridesFromMap).toBe("function");
    // Full-config offline override surface (spec 135 / #383).
    expect(typeof createFlagOverridesFromConfig).toBe("function");
    expect(typeof ConfigOverrideDataSource).toBe("function");
    expect(typeof OverrideBehaviour).toBe("object"); // enum
    expect(typeof PollingMode).toBe("object"); // enum
    expect(typeof LogLevel).toBe("object"); // enum
  });
});
