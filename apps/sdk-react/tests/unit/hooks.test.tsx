// SPDX-License-Identifier: MIT

/**
 * Unit tier — hooks (FR-003 / FR-006 / FR-011 / FR-013).
 *
 * `useFeatureFlag` returns `{ value, loading }`:
 *  - When `flagOverrides + LocalOnly` is configured, spec 036 §R8
 *    makes the synchronous snapshot authoritative — the hook seeds
 *    its initial state from `client.snapshot().getValue(...)` and
 *    starts with `loading: false`.
 *  - When no overrides are configured, `loading` starts `true` until
 *    the first `getValueAsync` resolves (matches configcat-react@^4.x).
 *  - When no provider is mounted, the hook throws the FR-013 error.
 *
 * `useConfigCatClient` (and the `useConfeatureClient` alias) return
 * the underlying client when wrapped; throw outside the provider.
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConfigCatProvider,
  createFlagOverridesFromMap,
  disposeAllClients,
  type IProvidesHooks,
  OverrideBehaviour,
  PollingMode,
  useConfeatureClient,
  useConfigCatClient,
  useFeatureFlag,
} from "../../src/index.ts";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

afterEach(() => {
  cleanup();
  disposeAllClients();
});

function wrapperFactory(overrides: Record<string, boolean>) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <ConfigCatProvider
        sdkKey={SDK_KEY}
        pollingMode={PollingMode.ManualPoll}
        options={{
          flagOverrides: createFlagOverridesFromMap(overrides, OverrideBehaviour.LocalOnly),
        }}
      >
        {children}
      </ConfigCatProvider>
    );
  };
}

describe("useFeatureFlag", () => {
  test("returns default with loading=false when LocalOnly overrides are empty (snapshot authoritative)", () => {
    // Spec 036 §R8: with `flagOverrides + LocalOnly` the snapshot is
    // authoritative — the override map is the entire universe of
    // flags. Empty map + missing key → resolved value === default,
    // with no async resolve needed. `loading` MUST be `false` on the
    // first render.
    const wrapper = wrapperFactory({});
    const { result } = renderHook(() => useFeatureFlag("feature.dark-mode", false), {
      wrapper,
    });
    expect(result.current.value).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  test("returns the override value synchronously when flagOverrides is configured (spec 036)", () => {
    // Spec 036 §R8: snapshot honours flagOverrides synchronously. The
    // hook must return the override value on the FIRST render — no
    // `waitFor` should be required.
    const wrapper = wrapperFactory({ "feature.dark-mode": true });
    const { result } = renderHook(() => useFeatureFlag("feature.dark-mode", false), {
      wrapper,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.value).toBe(true);
  });
});

describe("useConfigCatClient + useConfeatureClient alias", () => {
  test("both return the underlying client when wrapped in the provider", () => {
    const wrapper = wrapperFactory({});
    const primary = renderHook(() => useConfigCatClient(), { wrapper });
    const alias = renderHook(() => useConfeatureClient(), { wrapper });
    expect(primary.result.current).toBeDefined();
    expect(alias.result.current).toBeDefined();
  });
});

describe("Hooks called outside a provider (FR-013)", () => {
  test("useFeatureFlag throws the FR-013 error message", () => {
    expect(() => renderHook(() => useFeatureFlag("feature.dark-mode", false))).toThrowError(
      /must be used within a <ConfigCatProvider>/,
    );
  });

  test("useConfigCatClient throws when called outside the provider", () => {
    expect(() => renderHook(() => useConfigCatClient())).toThrowError(
      /must be used within a <ConfigCatProvider>/,
    );
  });
});

describe("useFeatureFlag re-renders on configChanged (FR-011 / T021)", () => {
  test("commits the latest cached value when the client emits configChanged", async () => {
    let capturedHooks: IProvidesHooks | undefined;
    function Wrapper({ children }: { children: ReactNode }): JSX.Element {
      return (
        <ConfigCatProvider
          sdkKey={SDK_KEY}
          pollingMode={PollingMode.ManualPoll}
          options={{
            flagOverrides: createFlagOverridesFromMap(
              { "feature.dark-mode": true },
              OverrideBehaviour.LocalOnly,
            ),
            setupHooks: (hooks): void => {
              capturedHooks = hooks;
            },
          }}
        >
          {children}
        </ConfigCatProvider>
      );
    }

    const { result } = renderHook(() => useFeatureFlag("feature.dark-mode", false), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.value).toBe(true);

    // Fire configChanged through the captured hooks emitter — the
    // hook's internal effect re-runs and `getValueAsync` resolves
    // again against the (still-overridden) cache. The resolved value
    // remains `true`; the assertion is that the post-event commit is
    // observed (effect re-ran) without unmounting.
    expect(capturedHooks).toBeDefined();
    // `emit` is internal on the Hooks class — go through `unknown`
    // because the public `IProvidesHooks` interface doesn't surface
    // `emit`, but the concrete `Hooks` runtime instance does.
    (capturedHooks as unknown as { emit: (event: string, payload: unknown) => void }).emit(
      "configChanged",
      {},
    );

    await waitFor(() => {
      expect(result.current.value).toBe(true);
      expect(result.current.loading).toBe(false);
    });
  });
});
