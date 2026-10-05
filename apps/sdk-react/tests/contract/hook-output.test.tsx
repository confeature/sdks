// SPDX-License-Identifier: MIT

/**
 * Contract tier — `useFeatureFlag` honours the canned
 * `config-v6.boolean.json` fixture and returns the same value as
 * `client.getValueAsync` (FR-022 / FR-023 / T026).
 *
 * Both code paths feed the same `flagOverrides + LocalOnly` config to
 * the underlying client. After `loading` flips to `false`:
 *   - The hook's `value` is the resolved value.
 *   - `client.getValueAsync(...)` resolves to the same value.
 * Asserting equality at this layer locks in the public contract
 * before the parity tier widens it to the full 58-tuple corpus.
 */

import { CONFIGS } from "@confeature/test-fixtures-sdk-parity";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConfeatureClient,
  ConfigCatProvider,
  createFlagOverridesFromMap,
  disposeAllClients,
  OverrideBehaviour,
  PollingMode,
  useFeatureFlag,
} from "../../src/index.ts";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

afterEach(() => {
  cleanup();
  disposeAllClients();
});

describe("Contract tier — hook output matches client.getValueAsync (FR-022/T026)", () => {
  const canonical = CONFIGS[0];
  if (!canonical) throw new Error("Test fixtures missing canonical boolean config");
  // `overridesMap` is now optional on `CanonicalConfig` (spec 135 — full-config
  // configs omit it), but `CONFIGS[0]` is the `injectionMode: "map"` boolean
  // config, which always carries one. Fail fast if that invariant is broken.
  if (!canonical.overridesMap) throw new Error("Canonical boolean config is missing overridesMap");
  const overrides: Record<string, boolean | string | number> = canonical.overridesMap;

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
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
  }

  test("useFeatureFlag('feature.dark-mode', false) matches client.getValueAsync", async () => {
    const standaloneClient = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(overrides, OverrideBehaviour.LocalOnly),
    });

    const { result } = renderHook(() => useFeatureFlag("feature.dark-mode", false), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const directValue = await standaloneClient.getValueAsync("feature.dark-mode", false);
    expect(result.current.value).toBe(directValue);
  });

  test("useFeatureFlag returns the default for missing keys", async () => {
    const standaloneClient = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(overrides, OverrideBehaviour.LocalOnly),
    });

    const { result } = renderHook(() => useFeatureFlag("feature.does-not-exist", true), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const directValue = await standaloneClient.getValueAsync("feature.does-not-exist", true);
    expect(result.current.value).toBe(directValue);
    expect(result.current.value).toBe(true);
  });
});
