// SPDX-License-Identifier: MIT

/**
 * Spec 076 / #271 D2 — `ClientCacheState.HasLocalOverrideFlagDataOnly`
 * is surfaced by a `LocalOnly` flag-overrides client both through
 * `waitForReady()` and via `snapshot().cacheState`. Mirrors
 * `configcat-common`'s behaviour exactly.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ClientCacheState,
  createFlagOverridesFromMap,
  OverrideBehaviour,
} from "@confeature/sdk-shared";

import { ConfeatureClient, disposeAllClients, PollingMode } from "../../src/index.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

beforeEach(() => {
  globalThis.localStorage.clear();
  disposeAllClients();
});

afterEach(() => {
  disposeAllClients();
  globalThis.localStorage.clear();
});

describe("ClientCacheState.HasLocalOverrideFlagDataOnly (#271 D2)", () => {
  test("snapshot().cacheState is HasLocalOverrideFlagDataOnly on a LocalOnly client", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap({ "feature.x": true }, OverrideBehaviour.LocalOnly),
    });
    expect(client.snapshot().cacheState).toBe(ClientCacheState.HasLocalOverrideFlagDataOnly);
    client.dispose();
  });

  test("waitForReady() resolves to HasLocalOverrideFlagDataOnly on a LocalOnly client", async () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap({ "feature.x": true }, OverrideBehaviour.LocalOnly),
    });
    const state = await client.waitForReady();
    expect(state).toBe(ClientCacheState.HasLocalOverrideFlagDataOnly);
    client.dispose();
  });

  test("the enum carries the four upstream-aligned numeric values", () => {
    expect(ClientCacheState.NoFlagData).toBe(0);
    expect(ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(1);
    expect(ClientCacheState.HasCachedFlagDataOnly).toBe(2);
    expect(ClientCacheState.HasUpToDateFlagData).toBe(3);
  });
});
