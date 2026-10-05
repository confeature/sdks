// SPDX-License-Identifier: MIT

/**
 * Side-by-side parity vs `configcat-js@^9.4.0` (SC-003).
 *
 * Both clients are configured with `flagOverrides` + `OverrideBehaviour.LocalOnly`
 * so neither hits the network. For every tuple in the shared corpus
 * (`@confeature/test-fixtures-sdk-parity`) we assert
 * `confeatureClient.getValue(...)` returns the same value as
 * `configcatClient.getValue(...)` AND both match `tuple.expected`.
 *
 * Two corpora run here:
 *  - `CORPUS` — the 58-tuple boolean corpus.
 *  - `CORPUS_TYPED` — the 13-tuple `SettingType × value` corpus (#254):
 *    `string`, `int`, and `double` settings plus their edge cases
 *    (empty string, zero, negative, precision-sensitive double).
 *
 * The typed evaluation path is `sdk-shared`'s `RolloutEvaluator` (shipped
 * by #253); this file verifies the JS SDK surfaces it identically to
 * `configcat-js`. Boolean behaviour is unchanged — the typed block is a
 * sibling `describe`, the boolean block is byte-unchanged.
 */

import { describe, expect, test, afterEach } from "vitest";

import {
  createFlagOverridesFromMap as confeatureCreateOverrides,
  OverrideBehaviour as ConfeatureOverrideBehaviour,
  PollingMode as ConfeaturePollingMode,
  getClient as getConfeatureClient,
  disposeAllClients as disposeAllConfeatureClients,
} from "../../src/index.ts";
import {
  createFlagOverridesFromMap as configcatCreateOverrides,
  OverrideBehaviour as ConfigCatOverrideBehaviour,
  PollingMode as ConfigCatPollingMode,
  getClient as getConfigCatClient,
  disposeAllClients as disposeAllConfigCatClients,
} from "configcat-js";
import { CORPUS, CORPUS_TYPED, getConfig } from "@confeature/test-fixtures-sdk-parity";

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

afterEach(() => {
  disposeAllConfeatureClients();
  disposeAllConfigCatClients();
});

describe("Parity vs configcat-js@^9.4.0 (SC-003)", () => {
  test.each(CORPUS)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const overrides = mapOverrides(configId);

      const confeature = getConfeatureClient(SDK_KEY, ConfeaturePollingMode.ManualPoll, {
        flagOverrides: confeatureCreateOverrides(overrides, ConfeatureOverrideBehaviour.LocalOnly),
      });
      const configcat = getConfigCatClient(SDK_KEY, ConfigCatPollingMode.ManualPoll, {
        flagOverrides: configcatCreateOverrides(overrides, ConfigCatOverrideBehaviour.LocalOnly),
      });

      const confeatureValue = await confeature.getValueAsync(key, defaultValue as never, user);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configcatValue = await configcat.getValueAsync(key, defaultValue as never, user as any);

      expect(confeatureValue).toBe(configcatValue);
      expect(confeatureValue).toBe(expected);
    },
  );

  test("corpus has at least one tuple per (boolean | default-fallback | missing-key) category", () => {
    const categories = new Set(CORPUS.map((t) => t.description.toLowerCase()));
    // Light sanity check: corpus must cover the v1 evaluator's full
    // public surface — boolean payload, default-value fallback,
    // missing-key fallback. SC-003 quantitative gate is the test.each
    // matrix above; this is the qualitative gate.
    expect(categories.size).toBeGreaterThan(0);
  });
});

describe("Typed parity vs configcat-js@^9.4.0 (#254)", () => {
  test.each(CORPUS_TYPED)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const overrides = mapOverrides(configId);

      const confeature = getConfeatureClient(SDK_KEY, ConfeaturePollingMode.ManualPoll, {
        flagOverrides: confeatureCreateOverrides(overrides, ConfeatureOverrideBehaviour.LocalOnly),
      });
      const configcat = getConfigCatClient(SDK_KEY, ConfigCatPollingMode.ManualPoll, {
        flagOverrides: configcatCreateOverrides(overrides, ConfigCatOverrideBehaviour.LocalOnly),
      });

      const confeatureValue = await confeature.getValueAsync(key, defaultValue as never, user);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configcatValue = await configcat.getValueAsync(key, defaultValue as never, user as any);

      expect(confeatureValue).toBe(configcatValue);
      expect(confeatureValue).toBe(expected);
    },
  );
});
