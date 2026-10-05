// SPDX-License-Identifier: MIT

/**
 * Zoneless compatibility — T023 / FR-020 / SC-007.
 *
 * Angular 18 ships an experimental zoneless change-detection mode via
 * `provideExperimentalZonelessChangeDetection()`. Under zoneless,
 * Angular no longer monkey-patches global async APIs through zone.js;
 * instead, components rely on signals, the async pipe, or explicit
 * change-detection triggers.
 *
 * `ConfeatureService` emits through a `BehaviorSubject`, which the
 * async pipe consumes via its own scheduler. That path does NOT need
 * the zone, so the service MUST keep working with zoneless turned on.
 *
 * We assert that `firstValueFrom(service.getValue(...))` resolves to
 * the override value under zoneless — i.e. no zone-dependent code
 * path got accidentally introduced in the emission chain.
 */

import { provideExperimentalZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-browser-js";
import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureService } from "../src/confeature.service";
import { provideConfeature } from "../src/provider";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("Zoneless change detection (T023 / FR-020)", () => {
  test("getValue emits to subscribers under provideExperimentalZonelessChangeDetection", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideExperimentalZonelessChangeDetection(),
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap(
            { is_on: true, name: "zoneless" },
            OverrideBehaviour.LocalOnly,
          ),
        }),
      ],
    });
    const service = TestBed.inject(ConfeatureService);
    await expect(firstValueFrom(service.getValue("is_on", false))).resolves.toBe(true);
    await expect(firstValueFrom(service.getValue("name", ""))).resolves.toBe("zoneless");
  });

  test("getValueSync works synchronously under zoneless", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideExperimentalZonelessChangeDetection(),
        provideConfeature({
          sdkKey: TEST_SDK_KEY,
          pollingMode: "manualPoll",
          flagOverrides: createFlagOverridesFromMap({ k: 42 }, OverrideBehaviour.LocalOnly),
        }),
      ],
    });
    const service = TestBed.inject(ConfeatureService);
    expect(service.getValueSync("k", 0)).toBe(42);
    expect(service.getValueSync("missing", "fallback")).toBe("fallback");
  });
});
