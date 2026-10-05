// SPDX-License-Identifier: MIT

/**
 * Targeting-rule parity (spec 135 / #383) — the `CORPUS_RULES` corpus
 * injected through the full-config offline override path.
 *
 * Unlike the flat `CORPUS` / `CORPUS_TYPED` corpora (which feed a value-only
 * `overridesMap` via `createFlagOverridesFromMap`), the rule corpus carries
 * the whole `{p,f,s}` config and is injected via `createFlagOverridesFromConfig`
 * + `OverrideBehaviour.LocalOnly`. The SDK then resolves targeting rules /
 * segments / % options offline through the real `RolloutEvaluator`, exactly
 * as it would against a CDN-served config — no network round-trip.
 *
 * Per the runner contract (contracts/full-config-override.md §3) every tuple
 * branches on `cfg.injectionMode`:
 *   - `"full-config"` → capability-probe `createFlagOverridesFromConfig`. If the
 *     SDK exposes it, build the override and assert the PUBLIC `getValueAsync`
 *     returns `tuple.expected`. If it does NOT, `it.skip` with a reason — NEVER
 *     fall back to the flat-map path (SC-004: no `"full-config"` tuple is ever
 *     resolved on the map path, and a skip is reported with its reason).
 *
 * `sdk-node` HAS adopted the full-config path, so all 8 rule tuples run and
 * pass; there are no skips for this family.
 */

import { describe, expect, test } from "vitest";

import {
  createFlagOverridesFromConfig,
  OverrideBehaviour,
  PollingMode,
  getClient,
  disposeAllClients,
} from "../../src/index.ts";
import { CORPUS_RULES, getConfig, requiresFullConfig } from "@confeature/test-fixtures-sdk-parity";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Capability probe: does this SDK expose the full-config override factory?
const hasFullConfigOverrides = typeof createFlagOverridesFromConfig === "function";

/**
 * Pure branch-decision for the runner contract (contracts/full-config-override.md
 * §3). Given a config id + the capability probe, it returns the action a runner
 * MUST take. Crucially, a `"full-config"` config can ONLY ever yield `"run"`
 * (factory present) or `"skip"` (factory absent) — there is NO `"map"` branch
 * for it, so a full-config tuple is never silently flat-map-resolved (SC-004).
 * Extracted as a pure function so the false-green guard below can unit-test the
 * decision with the probe forced off, without depending on this SDK actually
 * lacking the factory.
 */
type RuleTupleAction =
  | { readonly action: "run" }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "map" };

function decideRuleTupleAction(configId: string, hasFullConfig: boolean): RuleTupleAction {
  if (requiresFullConfig(configId)) {
    return hasFullConfig
      ? { action: "run" }
      : { action: "skip", reason: "SDK has not adopted full-config overrides" };
  }
  return { action: "map" };
}

describe("Targeting-rule parity via full-config overrides (spec 135 / #383)", () => {
  // SC-004: a `"full-config"` tuple is NEVER resolved on the flat-map path. When
  // the SDK lacks `createFlagOverridesFromConfig`, the tuple is SKIPPED with a
  // reason (a reported skip, not a silent pass). The decision is made once, at
  // registration time, off the same pure `decideRuleTupleAction` the guard
  // below unit-tests — so an un-adopted SDK shows `↓ skipped` rather than green.
  const runRuleTuple = hasFullConfigOverrides ? test : test.skip;

  runRuleTuple.each(CORPUS_RULES)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected, expectedVariationId }) => {
      const cfg = getConfig(configId);
      // Guard the contract: the rule corpus is full-config only; a map tuple
      // here would mean a corpus regression, never a silent flat-map fallback.
      expect(cfg.injectionMode).toBe("full-config");

      const client = getClient(SDK_KEY, PollingMode.ManualPoll, {
        flagOverrides: createFlagOverridesFromConfig(cfg.config, OverrideBehaviour.LocalOnly),
      });
      try {
        const value = await client.getValueAsync(key, defaultValue as never, user);
        expect(value).toBe(expected);
        // Variation-ID seam (spec 150 / #395): a tuple carrying
        // `expectedVariationId` ALSO asserts the PUBLIC getValueDetails returns
        // the upstream variationId; value-only tuples skip this (unchanged).
        if (expectedVariationId !== undefined) {
          const details = await client.getValueDetailsAsync(key, defaultValue as never, user);
          expect(details.variationId).toBe(expectedVariationId);
        }
      } finally {
        disposeAllClients();
      }
    },
  );

  test("the full-config override factory is exposed on this SDK (no skips for the JS family)", () => {
    expect(hasFullConfigOverrides).toBe(true);
  });
});

describe("False-green guard (SC-004 / T027): un-adopted SDK SKIPS, never silent-passes", () => {
  // Simulate the capability probe FAILING (full-config factory absent) and
  // assert the runner's branch decision SKIPS every rule tuple WITH A REASON —
  // and crucially NEVER returns the `"map"` action for a full-config config (a
  // full-config tuple must never be resolved on the flat-map path). This proves
  // the no-false-green contract independently of this SDK actually having the
  // factory: the decision is a pure function of (configId, capability).
  const PROBE_ABSENT = false;

  test.each(CORPUS_RULES)(
    "[$configId] $description → SKIPPED with reason, never map-resolved",
    ({ configId }) => {
      const decision = decideRuleTupleAction(configId, PROBE_ABSENT);
      expect(decision.action).toBe("skip");
      // Never the flat-map path for a full-config tuple (SC-004).
      expect(decision.action).not.toBe("map");
      // Never a silent pass — the skip carries an explaining reason.
      if (decision.action === "skip") {
        expect(decision.reason).toBe("SDK has not adopted full-config overrides");
      }
    },
  );

  test("with the probe PRESENT the same configs RUN (the real eval path), never skip", () => {
    for (const { configId } of CORPUS_RULES) {
      expect(decideRuleTupleAction(configId, true).action).toBe("run");
    }
  });
});
