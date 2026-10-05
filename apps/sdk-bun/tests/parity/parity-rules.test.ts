// SPDX-License-Identifier: MIT

/**
 * Targeting-rule parity (spec 135 / #383) — the `CORPUS_RULES` corpus
 * injected through the full-config offline override path.
 *
 * Unlike the flat `CORPUS` / `CORPUS_TYPED` corpora (which feed a value-only
 * `overridesMap` via `createFlagOverridesFromMap`), the rule corpus carries
 * the whole `{p,f,s}` config and is injected via `createFlagOverridesFromConfig`
 * + `OverrideBehaviour.LocalOnly`. The SDK then resolves targeting rules /
 * segments / % options offline through the real `RolloutEvaluator` — no
 * network round-trip.
 *
 * No side-by-side `configcat-js` run here (unlike `parity-corpus.test.ts`):
 * ConfigCat's full-config override is FILE-only, so there is no in-memory
 * `createFlagOverridesFromConfig` on `configcat-js` to compare against. The
 * `expected` values were ported 1:1 from ConfigCat's `evaluationlog` corpus
 * (`stringContainsDogDefaultCat` / `stringIsInDogDefaultCat`), so asserting the
 * public `getValueAsync` against `tuple.expected` IS the parity assertion.
 *
 * Per the runner contract (contracts/full-config-override.md §3) every tuple
 * branches on `cfg.injectionMode`; a `"full-config"` tuple is resolved via
 * `createFlagOverridesFromConfig` when the SDK exposes it, else SKIPPED with a
 * reason — NEVER on the flat-map path (SC-004). `sdk-browser-js` has adopted
 * the full-config path, so all 8 tuples run and pass with no skips.
 */

import { describe, expect, test, afterEach } from "vitest";

import {
  createFlagOverridesFromConfig,
  OverrideBehaviour,
  PollingMode,
  getClient,
  disposeAllClients,
} from "../../src/index.ts";
import { CORPUS_RULES, getConfig } from "@confeature/test-fixtures-sdk-parity";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Capability probe: does this SDK expose the full-config override factory?
const hasFullConfigOverrides = typeof createFlagOverridesFromConfig === "function";

afterEach(() => {
  disposeAllClients();
});

describe("Targeting-rule parity via full-config overrides (spec 135 / #383)", () => {
  // SC-004: a `"full-config"` tuple is NEVER resolved on the flat-map path. When
  // the SDK lacks `createFlagOverridesFromConfig`, the tuple is SKIPPED with a
  // reason (a reported skip, not a silent pass). The decision is made once, at
  // registration time, off the capability probe.
  const runRuleTuple = hasFullConfigOverrides ? test : test.skip;

  runRuleTuple.each(CORPUS_RULES)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const cfg = getConfig(configId);
      expect(cfg.injectionMode).toBe("full-config");

      const client = getClient(SDK_KEY, PollingMode.ManualPoll, {
        flagOverrides: createFlagOverridesFromConfig(cfg.config, OverrideBehaviour.LocalOnly),
        cache: "memory",
      });
      const value = await client.getValueAsync(key, defaultValue as never, user);
      expect(value).toBe(expected);
    },
  );

  test("the full-config override factory is exposed on this SDK (no skips for the JS family)", () => {
    expect(hasFullConfigOverrides).toBe(true);
  });
});
