// SPDX-License-Identifier: MIT

/**
 * Parity tier — `@confeature/sdk-angular`'s `ConfeatureService` resolves
 * byte-identical values across two corpora imported READ-ONLY from
 * `@confeature/test-fixtures-sdk-parity` (spec 068 / #255):
 *
 *  - `CORPUS` — the 58-tuple boolean parity corpus.
 *  - `CORPUS_TYPED` — the 13-tuple `SettingType × value` extension
 *    corpus (#253): `string`, `int`, and `double` settings plus their
 *    edge cases (empty string, zero, negative, a precision-sensitive
 *    double, typed `TYPE_MISMATCH`).
 *
 * `sdk-angular` had NO parity-corpus test before #255 — this file adds
 * one from scratch, so `sdk-angular` gains both a boolean parity net it
 * never had AND the typed-corpus coverage in one go.
 *
 * Parity reference: `configcat-js`. ConfigCat publishes NO official
 * Angular SDK — `@configcat/angular`, `configcat-angular`, `configcat-ng`,
 * `@configcat/ng-client` all return HTTP 404 on npm (verified
 * 2026-05-22). ConfigCat's guidance for Angular is to use `configcat-js`
 * directly, so `configcat-js` IS the official runtime SDK an Angular
 * consumer would otherwise reach for. The test asserts `ConfeatureService`
 * agrees with `configcat-js`'s `getValueAsync` on every tuple, and both
 * equal `tuple.expected`.
 *
 * Strategy (the `thin-wrapper.test.ts` pattern): each tuple resets the
 * `TestBed`, configures it with a `CONFEATURE_CONFIG` carrying
 * `flagOverrides + LocalOnly` so the snapshot is authoritative and no
 * network is hit, then injects `ConfeatureService` and asserts BOTH
 * `getValue` (the Observable) AND `getValueSync` (the synchronous read)
 * resolve to `tuple.expected`. A reference `configcat-js` client built
 * with the SAME overrides cross-checks the result and is disposed in a
 * `finally`. The `*cfFlag` directive and `cfFlag` pipe inherit this
 * typed surface structurally — both read through `ConfeatureService`.
 */

import { TestBed } from "@angular/core/testing";
import { CORPUS, CORPUS_TYPED, getConfig } from "@confeature/test-fixtures-sdk-parity";
import {
  createFlagOverridesFromMap as ccCreateOverrides,
  getClient as ccGetClient,
  OverrideBehaviour as CcOverrideBehaviour,
  PollingMode as CcPollingMode,
} from "configcat-js";
import { firstValueFrom } from "rxjs";
import { afterEach, describe, expect, test } from "vitest";

import { createFlagOverridesFromMap, OverrideBehaviour } from "../../src/index";
import type { ConfeatureConfig } from "../../src/config";
import { ConfeatureService } from "../../src/confeature.service";
import { CONFEATURE_CONFIG } from "../../src/internal/confeature-config.token";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/**
 * Resolve a map-mode config's flat `overridesMap`. `overridesMap` is now
 * optional on `CanonicalConfig` (spec 135 — full-config configs omit it), but
 * every tuple in `CORPUS` / `CORPUS_TYPED` references an `injectionMode: "map"`
 * config, which always carries one. Fail fast if that invariant is ever broken.
 */
function mapOverrides(configId: string): Record<string, boolean | string | number> {
  const overrides = getConfig(configId).overridesMap;
  if (!overrides) throw new Error(`Map-mode config "${configId}" is missing overridesMap`);
  return overrides;
}

describe("Parity vs configcat-js (boolean + typed corpora, #255)", () => {
  // Vitest runs test files in shared workers — the global Angular
  // `TestBed` is process-wide state. Each tuple configures + instantiates
  // it, so without an explicit reset the LAST tuple leaves the TestBed
  // instantiated and that leaks into any test file that runs next in the
  // same worker (its `configureTestingModule` then throws "already
  // instantiated"). Reset after every test so this file leaves the
  // global TestBed pristine, order-independently.
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  test.each([...CORPUS, ...CORPUS_TYPED])(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const overrides = mapOverrides(configId);

      const config: ConfeatureConfig = {
        sdkKey: SDK_KEY,
        pollingMode: "manualPoll",
        flagOverrides: createFlagOverridesFromMap(overrides, OverrideBehaviour.LocalOnly),
      };

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: CONFEATURE_CONFIG, useValue: config }],
      });
      const service = TestBed.inject(ConfeatureService);

      // configcat-js reference client — same flagOverrides + LocalOnly,
      // the same runtime SDK an Angular consumer would otherwise use.
      const ccClient = ccGetClient(SDK_KEY, CcPollingMode.ManualPoll, {
        flagOverrides: ccCreateOverrides(overrides, CcOverrideBehaviour.LocalOnly),
      });

      try {
        // The Observable path — `ConfeatureService.getValue`.
        const fromService = await firstValueFrom(
          service.getValue(key, defaultValue as never, user ?? undefined),
        );
        // The synchronous path — `ConfeatureService.getValueSync`.
        const fromSync = service.getValueSync(key, defaultValue as never, user ?? undefined);
        // The configcat-js reference result.
        const fromConfigcat = await ccClient.getValueAsync(
          key,
          defaultValue as never,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (user ?? undefined) as any,
        );

        expect(fromService).toBe(expected);
        expect(fromSync).toBe(expected);
        expect(fromService).toBe(fromConfigcat);
      } finally {
        ccClient.dispose();
      }
    },
  );

  test("the corpora cover the full matrix (58 boolean + 13 typed tuples)", () => {
    expect(CORPUS.length).toBe(58);
    expect(CORPUS_TYPED.length).toBe(13);
  });
});
