// SPDX-License-Identifier: MIT

/**
 * Targeting-rule parity (spec 135 / #383, T025) — `@confeature/sdk-react`'s
 * `useFeatureFlag` resolves the `CORPUS_RULES` corpus through the full-config
 * offline override path.
 *
 * Unlike `parity-corpus.test.tsx` (which injects a flat `overridesMap` via
 * `createFlagOverridesFromMap` and cross-checks `configcat-react`), the rule
 * corpus carries the whole `{p,f,s}` config and is injected via
 * `createFlagOverridesFromConfig` + `OverrideBehaviour.LocalOnly`. The hook
 * then resolves targeting rules / segments / % options offline through
 * `@confeature/sdk-browser-js`'s real `RolloutEvaluator`.
 *
 * No side-by-side `configcat-react` run: ConfigCat's full-config override is
 * FILE-only, so there is no in-memory equivalent to compare against. The
 * `expected` values were ported 1:1 from ConfigCat's `evaluationlog` corpus,
 * so asserting `useFeatureFlag`'s resolved `value` against `tuple.expected` IS
 * the parity assertion. Spec 036 §R8: the Confeature snapshot honours
 * `flagOverrides` synchronously, so the hook returns the correct value on the
 * FIRST render — asserted directly (no `waitFor` mask).
 *
 * Per the runner contract (contracts/full-config-override.md §3) a
 * `"full-config"` tuple is resolved via `createFlagOverridesFromConfig` when
 * the SDK exposes it, else SKIPPED with a reason — NEVER on the flat-map path
 * (SC-004). `sdk-react` re-exports the factory (`export *`), so all 8 tuples
 * run and pass.
 */

import { CORPUS_RULES, getConfig } from "@confeature/test-fixtures-sdk-parity";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConfigCatProvider as ConfeatureProvider,
  createFlagOverridesFromConfig,
  disposeAllClients,
  OverrideBehaviour as ConfeatureOverrideBehaviour,
  PollingMode as ConfeaturePollingMode,
  useFeatureFlag as confeatureUseFeatureFlag,
} from "../../src/index.ts";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Capability probe: does this SDK expose the full-config override factory?
const hasFullConfigOverrides = typeof createFlagOverridesFromConfig === "function";

afterEach(() => {
  cleanup();
  disposeAllClients();
});

describe("Targeting-rule parity via full-config overrides (spec 135 / #383)", () => {
  // SC-004: the decision is made once, at registration time, off the
  // capability probe — an un-adopted SDK shows `↓ skipped` with the reason,
  // never a green check, never a silent map fallback.
  const runRuleTuple = hasFullConfigOverrides ? test : test.skip;

  runRuleTuple.each(CORPUS_RULES)(
    "[$configId] $description",
    ({ configId, key, defaultValue, user, expected }) => {
      const cfg = getConfig(configId);
      expect(cfg.injectionMode).toBe("full-config");

      function ConfeatureWrapper({ children }: { children: ReactNode }): JSX.Element {
        return (
          <ConfeatureProvider
            sdkKey={SDK_KEY}
            pollingMode={ConfeaturePollingMode.ManualPoll}
            options={{
              flagOverrides: createFlagOverridesFromConfig(
                cfg.config,
                ConfeatureOverrideBehaviour.LocalOnly,
              ),
            }}
          >
            {children}
          </ConfeatureProvider>
        );
      }

      const confeatureHook = renderHook(
        () => confeatureUseFeatureFlag(key, defaultValue as never, user),
        { wrapper: ConfeatureWrapper },
      );

      // The Confeature snapshot honours flagOverrides synchronously — the hook
      // returns the correct rule-resolved value on the first render.
      expect(confeatureHook.result.current.loading).toBe(false);
      expect(confeatureHook.result.current.value).toBe(expected);
    },
  );

  test("the full-config override factory is re-exported by this wrapper (no skips for the JS family)", () => {
    expect(hasFullConfigOverrides).toBe(true);
  });
});
