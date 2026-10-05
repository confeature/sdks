// SPDX-License-Identifier: MIT

/**
 * Targeting-rule parity (spec 135 / #383, T025) — `@confeature/sdk-angular`'s
 * `ConfeatureService` resolves the `CORPUS_RULES` corpus through the
 * full-config offline override path.
 *
 * Unlike `parity-corpus.test.ts` (which injects a flat `overridesMap` via
 * `createFlagOverridesFromMap` and cross-checks `configcat-js`), the rule
 * corpus carries the whole `{p,f,s}` config and is injected via
 * `createFlagOverridesFromConfig` + `OverrideBehaviour.LocalOnly`. The service
 * then resolves targeting rules / segments / % options offline through
 * `@confeature/sdk-browser-js`'s real `RolloutEvaluator`.
 *
 * No side-by-side `configcat-js` run: ConfigCat's full-config override is
 * FILE-only, so there is no in-memory equivalent on `configcat-js`. The
 * `expected` values were ported 1:1 from ConfigCat's `evaluationlog` corpus,
 * so asserting the service's public `getValue` (Observable) AND `getValueSync`
 * against `tuple.expected` IS the parity assertion.
 *
 * Per the runner contract (contracts/full-config-override.md §3) a
 * `"full-config"` tuple is resolved via `createFlagOverridesFromConfig` when
 * the SDK exposes it, else SKIPPED with a reason — NEVER on the flat-map path
 * (SC-004). `sdk-angular` re-exports the factory, so all 8 tuples run + pass.
 */

import { TestBed } from "@angular/core/testing";
import { CORPUS_RULES, getConfig } from "@confeature/test-fixtures-sdk-parity";
import { firstValueFrom } from "rxjs";
import { afterEach, describe, expect, test } from "vitest";

import { createFlagOverridesFromConfig, OverrideBehaviour } from "../../src/index";
import type { ConfeatureConfig } from "../../src/config";
import { ConfeatureService } from "../../src/confeature.service";
import { CONFEATURE_CONFIG } from "../../src/internal/confeature-config.token";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Capability probe: does this SDK expose the full-config override factory?
const hasFullConfigOverrides = typeof createFlagOverridesFromConfig === "function";

describe("Targeting-rule parity via full-config overrides (spec 135 / #383)", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // SC-004: the decision is made once, at registration time, off the
  // capability probe. An un-adopted SDK shows `↓ skipped` with the reason
  // rather than a green check — never a silent pass, never a map fallback.
  const runRuleTuple = hasFullConfigOverrides ? test : test.skip;

  runRuleTuple.each(CORPUS_RULES)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const cfg = getConfig(configId);
      expect(cfg.injectionMode).toBe("full-config");

      const config: ConfeatureConfig = {
        sdkKey: SDK_KEY,
        pollingMode: "manualPoll",
        flagOverrides: createFlagOverridesFromConfig(cfg.config, OverrideBehaviour.LocalOnly),
      };

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: CONFEATURE_CONFIG, useValue: config }],
      });
      const service = TestBed.inject(ConfeatureService);

      // The Observable path — `ConfeatureService.getValue`.
      const fromService = await firstValueFrom(
        service.getValue(key, defaultValue as never, user ?? undefined),
      );
      // The synchronous path — `ConfeatureService.getValueSync`.
      const fromSync = service.getValueSync(key, defaultValue as never, user ?? undefined);

      expect(fromService).toBe(expected);
      expect(fromSync).toBe(expected);
    },
  );

  test("the full-config override factory is re-exported by this wrapper (no skips for the JS family)", () => {
    expect(hasFullConfigOverrides).toBe(true);
  });
});
