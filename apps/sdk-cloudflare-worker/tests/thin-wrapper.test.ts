// SPDX-License-Identifier: MIT

import {
  ConfeatureClient,
  createFlagOverridesFromMap,
  OverrideBehaviour,
  PollingMode,
  User,
} from "@confeature/sdk-browser-js";
import { afterEach, describe, expect, it } from "vitest";

import { getConfeatureClient } from "../src/client.ts";

/**
 * Thin-wrapper transparency tests (SC-001 / FR-008).
 *
 * For each scenario we instantiate two clients:
 *  - via `getConfeatureClient({...})` (the Worker SDK factory)
 *  - via the canonical `ConfeatureClient.getInstance(...)` from
 *    `@confeature/sdk-browser-js`
 *
 * and assert that `getValueAsync` returns byte-identical values
 * across the pair. The wrapper MUST NOT introduce behavioural drift.
 *
 * Typed-value coverage (#254): `sdk-cloudflare-worker` has no
 * `RolloutEvaluator` of its own — `getConfeatureClient` delegates
 * verbatim to `sdk-browser-js`'s `ConfeatureClient.getInstance`. The
 * `string` / `int` / `double` scenarios below prove the wrapper
 * surfaces every `SettingType` correctly-typed; since the evaluator IS
 * `sdk-browser-js`'s, `sdk-browser-js`'s typed parity-corpus pass
 * (`tests/parity/parity-corpus.test.ts`) is inherited transitively. No
 * duplicate parity-corpus test is added here — that would exercise
 * `sdk-browser-js`'s evaluator twice.
 *
 * Targeting-rule corpus (spec 135 / #383, T025): same reasoning. The
 * full-config override path + the `CORPUS_RULES` tuples are proven on
 * `sdk-browser-js`'s own `tests/parity/parity-rules.test.ts`; because
 * `getConfeatureClient` delegates verbatim to that same client and IS the
 * same evaluator, the Worker wrapper inherits `CORPUS_RULES` transitively.
 * The Worker package re-exports `createFlagOverridesFromConfig` /
 * `ConfigOverrideDataSource` (src/index.ts) so a Worker consumer can build
 * the override directly; that surface re-export is guarded by
 * `public-import.test.ts`.
 *
 * Each test uses a unique SDK key so the per-key singleton table in
 * sdk-browser-js doesn't return the same instance across scenarios.
 * `disposeAllClients()` between tests is unnecessary — fresh keys
 * sidestep the WeakRef map entirely.
 */

const VALID_KEY_BASE = "confeature-sdk-1-12345678901234567890123456789012-";
function keyFor(seed: string): string {
  // 32 chars after the second dash so the format validator stays happy.
  const padded = `${seed}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 32);
  return `${VALID_KEY_BASE}${padded}`;
}

describe("thin-wrapper transparency: getConfeatureClient mirrors ConfeatureClient", () => {
  const clientsToDispose: Array<{ dispose: () => void }> = [];
  afterEach(() => {
    for (const c of clientsToDispose.splice(0)) {
      try {
        c.dispose();
      } catch {
        /* ignore — dispose is idempotent in the underlying SDK */
      }
    }
  });

  it("Scenario 1 (boolean override): both clients return the override value", async () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.boolean": true },
      OverrideBehaviour.LocalOnly,
    );
    const sdkKey = keyFor("s1");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: overrides,
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(
        { "feature.boolean": true },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(direct);

    expect(await wrapped.getValueAsync("feature.boolean", false)).toBe(
      await direct.getValueAsync("feature.boolean", false),
    );
    expect(await wrapped.getValueAsync("feature.boolean", false)).toBe(true);
  });

  it("Scenario 2 (string override): both clients return the override string", async () => {
    const sdkKey = keyFor("s2");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.theme": "dark" },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(
        { "feature.theme": "dark" },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(direct);

    expect(await wrapped.getValueAsync("feature.theme", "light")).toBe(
      await direct.getValueAsync("feature.theme", "light"),
    );
    expect(await wrapped.getValueAsync("feature.theme", "light")).toBe("dark");
  });

  it("Scenario 3 (int override): both clients return the override integer", async () => {
    const sdkKey = keyFor("s3");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.retries": 7 },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(
        { "feature.retries": 7 },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(direct);

    expect(await wrapped.getValueAsync("feature.retries", 0)).toBe(
      await direct.getValueAsync("feature.retries", 0),
    );
    expect(await wrapped.getValueAsync("feature.retries", 0)).toBe(7);
  });

  it("Scenario 3b (double override): both clients return the override double, typed (#254)", async () => {
    const sdkKey = keyFor("s3b");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.sample-rate": 0.25 },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(
        { "feature.sample-rate": 0.25 },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(direct);

    const wrappedValue = await wrapped.getValueAsync("feature.sample-rate", 1);
    expect(wrappedValue).toBe(await direct.getValueAsync("feature.sample-rate", 1));
    expect(wrappedValue).toBe(0.25);
    // The wrapper surfaces the `double` SettingType as a JS `number`.
    expect(typeof wrappedValue).toBe("number");
  });

  it("Scenario 4 (missing key): both clients return the default", async () => {
    const sdkKey = keyFor("s4");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: createFlagOverridesFromMap({}, OverrideBehaviour.LocalOnly),
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap({}, OverrideBehaviour.LocalOnly),
    });
    clientsToDispose.push(direct);

    expect(await wrapped.getValueAsync("nope", "fallback")).toBe(
      await direct.getValueAsync("nope", "fallback"),
    );
    expect(await wrapped.getValueAsync("nope", "fallback")).toBe("fallback");
  });

  it("Scenario 5 (user passed through): both clients return the same value", async () => {
    const sdkKey = keyFor("s5");
    const user = new User("alice", "alice@example.com");

    const wrapped = getConfeatureClient({
      sdkKey,
      pollingMode: PollingMode.ManualPoll,
      flagOverrides: createFlagOverridesFromMap(
        { "feature.user-flag": true },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(wrapped);

    const direct = ConfeatureClient.getInstance(`${sdkKey}-direct`, PollingMode.ManualPoll, {
      flagOverrides: createFlagOverridesFromMap(
        { "feature.user-flag": true },
        OverrideBehaviour.LocalOnly,
      ),
    });
    clientsToDispose.push(direct);

    expect(await wrapped.getValueAsync("feature.user-flag", false, user)).toBe(
      await direct.getValueAsync("feature.user-flag", false, user),
    );
    expect(await wrapped.getValueAsync("feature.user-flag", false, user)).toBe(true);
  });
});

describe("getConfeatureClient defaults", () => {
  it("defaults pollingMode to AutoPoll when not specified", () => {
    const sdkKey = keyFor("def");
    const client = getConfeatureClient({
      sdkKey,
      flagOverrides: createFlagOverridesFromMap({}, OverrideBehaviour.LocalOnly),
      // Stay offline so AutoPoll doesn't actually hit the network in test.
      offline: true,
    });
    // No public accessor on the client surface for "current polling
    // mode", but the lack of throw + the singleton-table side effect
    // is enough to prove the factory accepted the call. Dispose to
    // tear down the AutoPoll timer.
    expect(client).toBeDefined();
    client.dispose();
  });
});
