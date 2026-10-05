// SPDX-License-Identifier: MIT

/**
 * Spec 076 / #271 D2 — `ClientCacheState.HasLocalOverrideFlagDataOnly`
 * is surfaced by a `LocalOnly` flag-overrides client both through
 * `waitForReady()` and via `snapshot().cacheState`. This mirrors
 * `configcat-common`'s behaviour exactly: a client configured with
 * `OverrideBehaviour.LocalOnly` is "ready" the moment it is built (no
 * remote fetch is ever issued), so its cache state must distinguish
 * "local override only" from "no flag data at all".
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  ClientCacheState,
  createFlagOverridesFromMap,
  OverrideBehaviour,
} from "@confeature/sdk-shared";

import { disposeAllClients, getClient } from "../../src/client.ts";
import { PollingMode } from "../../src/options.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("ClientCacheState.HasLocalOverrideFlagDataOnly (#271 D2)", () => {
  afterEach(() => {
    disposeAllClients();
  });

  test("snapshot().cacheState is HasLocalOverrideFlagDataOnly on a LocalOnly client", () => {
    const client = getClient(SDK_KEY, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap({ "feature.x": true }, OverrideBehaviour.LocalOnly),
    });
    expect(client.snapshot().cacheState).toBe(ClientCacheState.HasLocalOverrideFlagDataOnly);
  });

  test("waitForReady() resolves to HasLocalOverrideFlagDataOnly on a LocalOnly client", async () => {
    const client = getClient(SDK_KEY, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap({ "feature.x": true }, OverrideBehaviour.LocalOnly),
    });
    const state = await client.waitForReady();
    expect(state).toBe(ClientCacheState.HasLocalOverrideFlagDataOnly);
  });

  test("the enum carries the four upstream-aligned numeric values", () => {
    expect(ClientCacheState.NoFlagData).toBe(0);
    expect(ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(1);
    expect(ClientCacheState.HasCachedFlagDataOnly).toBe(2);
    expect(ClientCacheState.HasUpToDateFlagData).toBe(3);
  });
});
