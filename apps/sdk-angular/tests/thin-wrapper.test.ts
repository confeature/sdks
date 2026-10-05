// SPDX-License-Identifier: MIT

/**
 * Thin-wrapper transparency — FR-024 / SC-002 / T015.
 *
 * Asserts that `ConfeatureService.getValue(k, d, u)` returns the same
 * value as the underlying `ConfeatureClient.getValueAsync(k, d, u)`
 * across ≥ 5 representative scenarios:
 *
 *   1. boolean=true override
 *   2. boolean=false override
 *   3. string override
 *   4. number (int) override
 *   5. override-precedence: LocalOnly takes priority over remote (no
 *      remote present in test → result is the override)
 *   6. missing-key fallback: when the key is not in the override map,
 *      the consumer-supplied defaultValue is returned by both paths.
 *
 * Strategy: configure flagOverrides + LocalOnly so the snapshot is
 * authoritative. Compare service.getValue (Observable, take 1) with
 * client.getValueAsync (Promise) — both MUST resolve to the same
 * value for every scenario.
 */

import { TestBed } from "@angular/core/testing";
import {
  ConfeatureClient,
  createFlagOverridesFromMap,
  OverrideBehaviour,
  PollingMode,
} from "@confeature/sdk-browser-js";
import { firstValueFrom } from "rxjs";
import { describe, expect, test } from "vitest";

import { ConfeatureService } from "../src/confeature.service";
import type { ConfeatureConfig } from "../src/config";
import { CONFEATURE_CONFIG } from "../src/internal/confeature-config.token";

const TEST_SDK_KEY =
  "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const OVERRIDE_MAP = {
  "is-on": true,
  "is-off": false,
  name: "alpha",
  count: 42,
  "precedence-key": "local",
} as const;

function makeConfig(): ConfeatureConfig {
  return {
    sdkKey: TEST_SDK_KEY,
    pollingMode: "manualPoll",
    flagOverrides: createFlagOverridesFromMap(OVERRIDE_MAP, OverrideBehaviour.LocalOnly),
  };
}

interface Scenario {
  name: string;
  key: string;
  defaultValue: boolean | string | number;
}

const SCENARIOS: Scenario[] = [
  { name: "boolean=true", key: "is-on", defaultValue: false },
  { name: "boolean=false", key: "is-off", defaultValue: true },
  { name: "string", key: "name", defaultValue: "fallback" },
  { name: "number", key: "count", defaultValue: 0 },
  { name: "override-precedence (LocalOnly wins)", key: "precedence-key", defaultValue: "remote" },
  { name: "missing-key falls back to default", key: "absent", defaultValue: "default-fallback" },
];

describe("ConfeatureService thin-wrapper transparency (T015 / FR-024)", () => {
  for (const scenario of SCENARIOS) {
    test(`scenario: ${scenario.name}`, async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: CONFEATURE_CONFIG, useValue: makeConfig() }],
      });
      const service = TestBed.inject(ConfeatureService);

      // Build a stand-alone reference client with the SAME configuration
      // and compare its async result with the service's observable result.
      const refClient = new ConfeatureClient(TEST_SDK_KEY, PollingMode.ManualPoll, {
        flagOverrides: createFlagOverridesFromMap(OVERRIDE_MAP, OverrideBehaviour.LocalOnly),
      });
      try {
        const fromService = await firstValueFrom(
          service.getValue(scenario.key, scenario.defaultValue),
        );
        const fromClient = await refClient.getValueAsync(scenario.key, scenario.defaultValue);
        expect(fromService).toStrictEqual(fromClient);
      } finally {
        refClient.dispose();
      }
    });
  }

  test("service.getValueSync matches client.snapshot().getValue across 5 keys", () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: CONFEATURE_CONFIG, useValue: makeConfig() }],
    });
    const service = TestBed.inject(ConfeatureService);
    const ref = new ConfeatureClient(TEST_SDK_KEY, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(OVERRIDE_MAP, OverrideBehaviour.LocalOnly),
    });
    try {
      for (const scenario of SCENARIOS) {
        const a = service.getValueSync(scenario.key, scenario.defaultValue);
        const b = ref.snapshot().getValue(scenario.key, scenario.defaultValue);
        expect(a).toStrictEqual(b);
      }
    } finally {
      ref.dispose();
    }
  });
});
