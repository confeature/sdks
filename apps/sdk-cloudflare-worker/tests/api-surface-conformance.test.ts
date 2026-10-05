// SPDX-License-Identifier: MIT

/**
 * API-surface conformance vs `configcat-js` (epic #264, Constitution
 * Principle II — drop-in compatibility).
 *
 * The official `@configcat/cloudflare-worker-client` package's public
 * surface IS the `configcat-js` client surface plus a Worker-friendly
 * `getClient` factory and a KV cache adapter — it adds no new evaluation
 * symbols. `@configcat/cloudflare-worker-client` is not a dependency of
 * this repo, so this conformance test asserts against `configcat-js`,
 * which is the surface that package re-exports. `sdk-cloudflare-worker`
 * mirrors that shape: it re-exports the full `sdk-browser-js`
 * (`configcat-js`-equivalent) surface and adds `getConfeatureClient`
 * (the Worker factory, mirroring `@configcat/cloudflare-worker-client`'s
 * `getClient`) plus `workersKvCache`.
 *
 * `sdk-cloudflare-worker` is a thin wrapper — `getConfeatureClient`
 * delegates verbatim to `sdk-browser-js`'s `ConfeatureClient.getInstance`
 * — so the client instance surface is `sdk-browser-js`'s, already proven
 * conformant in `apps/sdk-browser-js/tests/contract/`. This test PROVES
 * the Worker package's *export* surface matches and GUARDS against drift.
 *
 * KNOWN DIVERGENCES vs configcat-js (triaged under epic #264, identical
 * to the ones `sdk-browser-js`'s conformance test documents — this SDK
 * inherits them through the re-export):
 *  - `SettingType` member is `Bool`; configcat-js names it `Boolean`.
 *  - `ClientCacheState` omits `HasLocalOverrideFlagDataOnly`.
 *  - `client.isOffline` is a method, not a getter property.
 *  - `createConsoleLogger` arity is 1 here vs 2 in configcat-js.
 */

import { describe, expect, test, afterEach } from "vitest";

import * as confeature from "../src/index.ts";
import { getConfeatureClient } from "../src/client.ts";
import * as configcat from "configcat-js";

const VALID_KEY =
  "confeature-sdk-1-12345678901234567890123456789012-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Runtime value exports (typeof !== "undefined"). Type-only exports
 *  vanish after compilation, so they cannot be reflected at runtime. */
function valueExports(mod: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(mod).filter((k) => k !== "default" && typeof mod[k] !== "undefined"));
}

/** The named members of an enum — strips the numeric reverse-mapping
 *  keys a TS numeric enum emits. */
function enumMemberNames(e: Record<string, unknown>): string[] {
  return Object.keys(e)
    .filter((k) => !/^-?\d+$/.test(k))
    .sort();
}

describe("API-surface conformance vs configcat-js (#264)", () => {
  afterEach(() => {
    confeature.disposeAllClients();
    configcat.disposeAllClients();
  });

  test("every configcat-js public value export is present in sdk-cloudflare-worker", () => {
    const ccExports = valueExports(configcat as unknown as Record<string, unknown>);
    const cfExports = valueExports(confeature as unknown as Record<string, unknown>);

    // Superset check — the Worker SDK MAY add its own symbols
    // (`getConfeatureClient`, `workersKvCache`, …); the reverse — a
    // configcat-js symbol missing here — is a Principle II violation.
    const missing = [...ccExports].filter((sym) => !cfExports.has(sym));
    expect(missing).toEqual([]);
  });

  test("exposes a Worker client factory + KV cache adapter (mirrors @configcat/cloudflare-worker-client)", () => {
    // `@configcat/cloudflare-worker-client` exposes a `getClient`
    // factory; `sdk-cloudflare-worker` mirrors it with the
    // `getConfeatureClient` factory and additionally re-exports the
    // lower-level `getClient` for full configcat-js parity.
    expect(typeof getConfeatureClient).toBe("function");
    expect(typeof confeature.getConfeatureClient).toBe("function");
    expect(typeof confeature.getClient).toBe("function");
    expect(typeof confeature.workersKvCache).toBe("function");
  });

  test("PollingMode + OverrideBehaviour + LogLevel named members match configcat-js", () => {
    expect(enumMemberNames(confeature.PollingMode)).toEqual(enumMemberNames(configcat.PollingMode));
    expect(enumMemberNames(confeature.OverrideBehaviour)).toEqual(
      enumMemberNames(configcat.OverrideBehaviour),
    );
    expect(enumMemberNames(confeature.LogLevel)).toEqual(enumMemberNames(configcat.LogLevel));
    expect(confeature.PollingMode.AutoPoll).toBe(configcat.PollingMode.AutoPoll);
    expect(confeature.OverrideBehaviour.LocalOnly).toBe(configcat.OverrideBehaviour.LocalOnly);
    expect(confeature.LogLevel.Error).toBe(configcat.LogLevel.Error);
  });

  test("SettingType named members + values match configcat-js (#271 D1 closed)", () => {
    expect(enumMemberNames(confeature.SettingType)).toEqual(enumMemberNames(configcat.SettingType));
    expect(confeature.SettingType.Boolean).toBe(configcat.SettingType.Boolean);
    expect(confeature.SettingType.String).toBe(configcat.SettingType.String);
    expect(confeature.SettingType.Int).toBe(configcat.SettingType.Int);
    expect(confeature.SettingType.Double).toBe(configcat.SettingType.Double);
  });

  test("ClientCacheState named members + values match configcat-js (#271 D2 closed)", () => {
    // `sdk-cloudflare-worker` inherits this enum via the `sdk-browser-js`
    // re-export, so the upstream-aligned shape applies identically here.
    expect(enumMemberNames(confeature.ClientCacheState)).toEqual(
      enumMemberNames(configcat.ClientCacheState),
    );
    expect(confeature.ClientCacheState.NoFlagData).toBe(0);
    expect(confeature.ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(1);
    expect(confeature.ClientCacheState.HasCachedFlagDataOnly).toBe(2);
    expect(confeature.ClientCacheState.HasUpToDateFlagData).toBe(3);
    expect(confeature.ClientCacheState.NoFlagData).toBe(configcat.ClientCacheState.NoFlagData);
  });

  test("the Worker-built client exposes the core ConfigCat method surface with matching arity", () => {
    const confeatureClient = getConfeatureClient({
      sdkKey: VALID_KEY,
      pollingMode: confeature.PollingMode.ManualPoll,
      flagOverrides: confeature.createFlagOverridesFromMap(
        { "feature.x": true },
        confeature.OverrideBehaviour.LocalOnly,
      ),
    });
    const configcatClient = configcat.getClient(
      "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      configcat.PollingMode.ManualPoll,
      {
        flagOverrides: configcat.createFlagOverridesFromMap(
          { "feature.x": true },
          configcat.OverrideBehaviour.LocalOnly,
        ),
      },
    );

    const methods: Array<[string, number]> = [
      ["getValueAsync", 3],
      ["getValueDetailsAsync", 3],
      ["getAllKeysAsync", 0],
      ["getAllValuesAsync", 1],
      ["getKeyAndValueAsync", 1],
      ["forceRefreshAsync", 0],
      ["setOnline", 0],
      ["setOffline", 0],
      ["waitForReady", 0],
      ["snapshot", 0],
      ["dispose", 0],
    ];
    for (const [name, arity] of methods) {
      const cfFn = (confeatureClient as unknown as Record<string, unknown>)[name];
      const ccFn = (configcatClient as unknown as Record<string, unknown>)[name];
      expect(typeof cfFn, `confeature client.${name}`).toBe("function");
      expect(typeof ccFn, `configcat client.${name}`).toBe("function");
      expect((cfFn as (...a: unknown[]) => unknown).length, `arity of ${name}`).toBe(arity);
      expect((ccFn as (...a: unknown[]) => unknown).length, `arity of ${name}`).toBe(arity);
    }

    expect(typeof (confeatureClient as unknown as Record<string, unknown>).on).toBe("function");
    expect(typeof (configcatClient as unknown as Record<string, unknown>).on).toBe("function");

    // #271 D3 closed: `isOffline` is a readonly getter property on both
    // SDKs. A consumer writing `if (client.isOffline)` sees a boolean.
    expect(typeof (confeatureClient as unknown as Record<string, unknown>).isOffline).toBe(
      "boolean",
    );
    expect(typeof configcatClient.isOffline).toBe("boolean");

    confeatureClient.dispose();
    configcatClient.dispose();
  });
});
