// SPDX-License-Identifier: MIT

/**
 * Spec 036 — `snapshot().getValue()` now honours `flagOverrides + LocalOnly`
 * SYNCHRONOUSLY. Pre-spec the snapshot path bypassed the override map
 * entirely (only `getValueAsync` consulted it); customers using framework
 * adapters like sdk-react had to `await loading === false` even when the
 * override map was already in memory.
 *
 * These tests pin the new synchronous behaviour. If they fail in the
 * future, the snapshot+overrides extraction has regressed.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFlagOverridesFromMap, OverrideBehaviour } from "@confeature/sdk-shared";

import { ConfeatureClient, disposeAllClients, PollingMode } from "../../src/index.ts";

const SDK_KEY =
  "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

beforeEach(() => {
  globalThis.localStorage.clear();
  disposeAllClients();
});

afterEach(() => {
  disposeAllClients();
  globalThis.localStorage.clear();
});

describe("snapshot() honours flagOverrides synchronously (spec 036)", () => {
  test("snapshot().getValue returns the override value WITHOUT awaiting", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.a": true, "feature.b": false },
        OverrideBehaviour.LocalOnly,
      ),
    });
    // CRITICAL: no `await`. The snapshot must return the override
    // synchronously, NOT the supplied default.
    const snap = client.snapshot();
    expect(snap.getValue("feature.a", false)).toBe(true);
    expect(snap.getValue("feature.b", true)).toBe(false);
    client.dispose();
  });

  test("snapshot().getValue returns the default when key is absent from the override map (LocalOnly contract)", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap({ "feature.a": true }, OverrideBehaviour.LocalOnly),
    });
    const snap = client.snapshot();
    // LocalOnly: do not consult the cache for missing keys; return default.
    expect(snap.getValue("feature.missing", false)).toBe(false);
    expect(snap.getValue("feature.missing", true)).toBe(true);
    client.dispose();
  });

  test("snapshot().getValue returns the default on TYPE_MISMATCH", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap(
        // String override but the call site asks for a boolean.
        { "feature.theme": "dark" },
        OverrideBehaviour.LocalOnly,
      ),
    });
    const snap = client.snapshot();
    expect(snap.getValue("feature.theme", false)).toBe(false);
    client.dispose();
  });

  test("snapshot().getValue falls through to the cache when behaviour is NOT LocalOnly", () => {
    const client = new ConfeatureClient(SDK_KEY, PollingMode.ManualPoll, {
      offline: true,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.a": true },
        OverrideBehaviour.LocalOverRemote,
      ),
    });
    const snap = client.snapshot();
    // Non-LocalOnly: override is ignored; without a cached config the
    // snapshot just returns the supplied default.
    expect(snap.getValue("feature.a", false)).toBe(false);
    client.dispose();
  });
});
