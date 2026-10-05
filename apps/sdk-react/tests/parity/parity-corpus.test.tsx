// SPDX-License-Identifier: MIT

/**
 * Parity tier — `@confeature/sdk-react`'s `useFeatureFlag` returns
 * byte-identical values vs `configcat-react@^4.x` across two corpora
 * imported READ-ONLY from `@confeature/test-fixtures-sdk-parity`:
 *
 *  - `CORPUS` — the 58-tuple boolean parity corpus (SC-003 / T027).
 *  - `CORPUS_TYPED` — the 13-tuple `SettingType × value` extension
 *    corpus (spec 068 / #255): `string`, `int`, and `double` settings
 *    plus their edge cases (empty string, zero, negative, a
 *    precision-sensitive double, typed `TYPE_MISMATCH`). It proves the
 *    React `useFeatureFlag` hook surfaces correctly-typed values for
 *    every `SettingType`, not only `boolean`.
 *
 * Both providers receive the same `flagOverrides + LocalOnly` config
 * so neither hits the network. Each tuple's hook is mounted via
 * `renderHook`; the assertion compares the resolved `value`.
 *
 * Spec 036 §R8: `snapshot()` honours `flagOverrides + LocalOnly`
 * synchronously, so the Confeature hook returns the correct value on
 * the FIRST render. We assert synchronously BEFORE the `waitFor` to
 * pin the regression: if the snapshot path regresses in the future,
 * the synchronous assertion fires immediately rather than silently
 * passing thanks to the `waitFor` mask.
 *
 * The `waitFor` remains for the configcat-react side because v4.x
 * drives its hook value off the async `getValueAsync` path; without
 * the wait, configcat-react would still return `loading: true`.
 */

import { CORPUS, CORPUS_TYPED, getConfig } from "@confeature/test-fixtures-sdk-parity";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  ConfigCatProvider as ConfigCatReactProvider,
  createFlagOverridesFromMap as configcatCreateOverrides,
  OverrideBehaviour as ConfigCatOverrideBehaviour,
  PollingMode as ConfigCatPollingMode,
  useFeatureFlag as configcatUseFeatureFlag,
} from "configcat-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConfigCatProvider as ConfeatureProvider,
  createFlagOverridesFromMap as confeatureCreateOverrides,
  disposeAllClients,
  OverrideBehaviour as ConfeatureOverrideBehaviour,
  PollingMode as ConfeaturePollingMode,
  useFeatureFlag as confeatureUseFeatureFlag,
} from "../../src/index.ts";

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
  cleanup();
  disposeAllClients();
});

describe("Parity vs configcat-react@^4.x (SC-003 / T027)", () => {
  test.each(CORPUS)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const overrides = mapOverrides(configId);

      function ConfeatureWrapper({ children }: { children: ReactNode }): JSX.Element {
        return (
          <ConfeatureProvider
            sdkKey={SDK_KEY}
            pollingMode={ConfeaturePollingMode.ManualPoll}
            options={{
              flagOverrides: confeatureCreateOverrides(
                overrides,
                ConfeatureOverrideBehaviour.LocalOnly,
              ),
            }}
          >
            {children}
          </ConfeatureProvider>
        );
      }

      function ConfigCatWrapper({ children }: { children: ReactNode }): JSX.Element {
        return (
          <ConfigCatReactProvider
            sdkKey={SDK_KEY}
            pollingMode={ConfigCatPollingMode.ManualPoll}
            options={{
              flagOverrides: configcatCreateOverrides(
                overrides,
                ConfigCatOverrideBehaviour.LocalOnly,
              ),
            }}
          >
            {children}
          </ConfigCatReactProvider>
        );
      }

      const confeatureHook = renderHook(
        () => confeatureUseFeatureFlag(key, defaultValue as never, user),
        { wrapper: ConfeatureWrapper },
      );
      const configcatHook = renderHook(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => configcatUseFeatureFlag(key, defaultValue as never, user as any),
        { wrapper: ConfigCatWrapper },
      );

      // Spec 036 §R8: Confeature snapshot honours flagOverrides
      // synchronously — the hook MUST return the correct value on the
      // first render. Asserting this BEFORE `waitFor` makes the
      // regression visible: if the snapshot path regresses, this fires
      // immediately rather than silently passing under the wait.
      expect(confeatureHook.result.current.loading).toBe(false);
      expect(confeatureHook.result.current.value).toBe(expected);

      // configcat-react@^4.x still drives the hook off the async
      // getValueAsync path — wait for its initial async resolve.
      await waitFor(() => {
        expect(configcatHook.result.current.loading).toBe(false);
      });

      expect(confeatureHook.result.current.value).toBe(configcatHook.result.current.value);
      expect(confeatureHook.result.current.value).toBe(expected);
    },
  );

  test("corpus is non-empty (at least 50 tuples per SC-003)", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(50);
  });
});

describe("Typed parity vs configcat-react@^4.x (#255)", () => {
  // The typed corpus runs the SAME side-by-side comparison as the
  // boolean block above — `confeatureUseFeatureFlag` resolves equal to
  // `configcatUseFeatureFlag` and both equal `tuple.expected` — but
  // exercises `string` / `int` / `double` settings. It proves the
  // React `useFeatureFlag` hook surfaces correctly-typed values for
  // every `SettingType`: a `string` setting → a JS `string`, an `int`
  // / `double` setting → a JS `number`. The typed value path is
  // delegation to `@confeature/sdk-browser-js`'s `ConfeatureClient` →
  // `@confeature/sdk-shared`'s typed `RolloutEvaluator` — no React-layer
  // change is involved. This block is a SIBLING of the boolean block;
  // the boolean `test.each(CORPUS)` block above is byte-unchanged.
  test.each(CORPUS_TYPED)(
    "[$configId] $description",
    async ({ configId, key, defaultValue, user, expected }) => {
      const overrides = mapOverrides(configId);

      function ConfeatureWrapper({ children }: { children: ReactNode }): JSX.Element {
        return (
          <ConfeatureProvider
            sdkKey={SDK_KEY}
            pollingMode={ConfeaturePollingMode.ManualPoll}
            options={{
              flagOverrides: confeatureCreateOverrides(
                overrides,
                ConfeatureOverrideBehaviour.LocalOnly,
              ),
            }}
          >
            {children}
          </ConfeatureProvider>
        );
      }

      function ConfigCatWrapper({ children }: { children: ReactNode }): JSX.Element {
        return (
          <ConfigCatReactProvider
            sdkKey={SDK_KEY}
            pollingMode={ConfigCatPollingMode.ManualPoll}
            options={{
              flagOverrides: configcatCreateOverrides(
                overrides,
                ConfigCatOverrideBehaviour.LocalOnly,
              ),
            }}
          >
            {children}
          </ConfigCatReactProvider>
        );
      }

      const confeatureHook = renderHook(
        () => confeatureUseFeatureFlag(key, defaultValue as never, user),
        { wrapper: ConfeatureWrapper },
      );
      const configcatHook = renderHook(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => configcatUseFeatureFlag(key, defaultValue as never, user as any),
        { wrapper: ConfigCatWrapper },
      );

      // Confeature snapshot honours flagOverrides synchronously — the
      // hook returns the correctly-typed value on the first render.
      expect(confeatureHook.result.current.loading).toBe(false);
      expect(confeatureHook.result.current.value).toBe(expected);

      // configcat-react@^4.x drives its hook off the async path.
      await waitFor(() => {
        expect(configcatHook.result.current.loading).toBe(false);
      });

      expect(confeatureHook.result.current.value).toBe(configcatHook.result.current.value);
      expect(confeatureHook.result.current.value).toBe(expected);
    },
  );

  test("typed corpus covers the full SettingType matrix (13 tuples per #253)", () => {
    expect(CORPUS_TYPED.length).toBe(13);
  });
});
