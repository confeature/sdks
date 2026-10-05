// SPDX-License-Identifier: MIT

/**
 * API-surface conformance vs `configcat-js` (epic #264, Constitution
 * Principle II — drop-in compatibility).
 *
 * A consumer migrating from ConfigCat to Confeature must change only the
 * base URL. That guarantee holds only if every public symbol ConfigCat
 * exports is also exported here, and the client method surface matches.
 * This test PROVES the matching surface and GUARDS against future drift
 * — a renamed export or a method that loses an argument fails here.
 *
 * Reflection only — `Object.keys` / `typeof` / `.length` (arity). No
 * network, so this runs un-gated alongside the rest of the suite.
 *
 * Closed via spec 076 (#271, merge 2026-05-25): SettingType.Boolean,
 * ClientCacheState.HasLocalOverrideFlagDataOnly + aligned numeric
 * values, isOffline-as-getter, createConsoleLogger arity 2. The 5th
 * #271 divergence (createFlagOverridesFromQueryParams missing) is
 * deferred to a follow-up spec and remains as a drift-guard in the
 * sdk-react conformance test only.
 *
 * The remaining acknowledged DIVERGENCE: configcat-js enums are numeric
 * TS enums (reverse-mapped at runtime); Confeature's are name-keyed
 * const objects. The comparison below is on the *named* members — the
 * surface a consumer references.
 */

import { describe, expect, test, afterEach } from "vitest";

import * as confeature from "../../src/index.ts";
import * as configcat from "configcat-js";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** Runtime value exports (typeof !== "undefined"). Type-only exports
 *  vanish after compilation, so they cannot be reflected at runtime. */
function valueExports(mod: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(mod).filter((k) => k !== "default" && typeof mod[k] !== "undefined"));
}

/** The named members of an enum — strips the numeric reverse-mapping
 *  keys a TS numeric enum emits (`'0'`, `'1'`, …) so a name-keyed const
 *  object and a numeric enum can be compared on the surface a consumer
 *  actually references. */
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

  test("every configcat-js public value export is present in sdk-deno", () => {
    const ccExports = valueExports(configcat as unknown as Record<string, unknown>);
    const cfExports = valueExports(confeature as unknown as Record<string, unknown>);

    // Superset check — Confeature MAY add its own symbols
    // (`ConfeatureClient`, `ProjectConfig`, …); the reverse — a
    // configcat-js symbol missing here — is a Principle II violation.
    const missing = [...ccExports].filter((sym) => !cfExports.has(sym));
    expect(missing).toEqual([]);
  });

  test("PollingMode named members + values match configcat-js", () => {
    expect(enumMemberNames(confeature.PollingMode)).toEqual(enumMemberNames(configcat.PollingMode));
    expect(confeature.PollingMode.AutoPoll).toBe(configcat.PollingMode.AutoPoll);
    expect(confeature.PollingMode.LazyLoad).toBe(configcat.PollingMode.LazyLoad);
    expect(confeature.PollingMode.ManualPoll).toBe(configcat.PollingMode.ManualPoll);
  });

  test("OverrideBehaviour named members + values match configcat-js", () => {
    expect(enumMemberNames(confeature.OverrideBehaviour)).toEqual(
      enumMemberNames(configcat.OverrideBehaviour),
    );
    expect(confeature.OverrideBehaviour.LocalOnly).toBe(configcat.OverrideBehaviour.LocalOnly);
    expect(confeature.OverrideBehaviour.LocalOverRemote).toBe(
      configcat.OverrideBehaviour.LocalOverRemote,
    );
    expect(confeature.OverrideBehaviour.RemoteOverLocal).toBe(
      configcat.OverrideBehaviour.RemoteOverLocal,
    );
  });

  test("LogLevel named members + values match configcat-js", () => {
    expect(enumMemberNames(confeature.LogLevel)).toEqual(enumMemberNames(configcat.LogLevel));
    expect(confeature.LogLevel.Error).toBe(configcat.LogLevel.Error);
    expect(confeature.LogLevel.Warn).toBe(configcat.LogLevel.Warn);
    expect(confeature.LogLevel.Info).toBe(configcat.LogLevel.Info);
    expect(confeature.LogLevel.Debug).toBe(configcat.LogLevel.Debug);
    expect(confeature.LogLevel.Off).toBe(configcat.LogLevel.Off);
  });

  test("SettingType named members + values match configcat-js (#271 D1 closed)", () => {
    expect(enumMemberNames(confeature.SettingType)).toEqual(enumMemberNames(configcat.SettingType));
    expect(confeature.SettingType.Boolean).toBe(configcat.SettingType.Boolean);
    expect(confeature.SettingType.String).toBe(configcat.SettingType.String);
    expect(confeature.SettingType.Int).toBe(configcat.SettingType.Int);
    expect(confeature.SettingType.Double).toBe(configcat.SettingType.Double);
  });

  test("ClientCacheState named members + values match configcat-js (#271 D2 closed)", () => {
    expect(enumMemberNames(confeature.ClientCacheState)).toEqual(
      enumMemberNames(configcat.ClientCacheState),
    );
    expect(confeature.ClientCacheState.NoFlagData).toBe(0);
    expect(confeature.ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(1);
    expect(confeature.ClientCacheState.HasCachedFlagDataOnly).toBe(2);
    expect(confeature.ClientCacheState.HasUpToDateFlagData).toBe(3);
    expect(confeature.ClientCacheState.NoFlagData).toBe(configcat.ClientCacheState.NoFlagData);
    expect(confeature.ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(
      configcat.ClientCacheState.HasLocalOverrideFlagDataOnly,
    );
    expect(confeature.ClientCacheState.HasCachedFlagDataOnly).toBe(
      configcat.ClientCacheState.HasCachedFlagDataOnly,
    );
    expect(confeature.ClientCacheState.HasUpToDateFlagData).toBe(
      configcat.ClientCacheState.HasUpToDateFlagData,
    );
  });

  test("getClient + createFlagOverridesFromMap have matching arity with configcat-js", () => {
    for (const fn of ["getClient", "createFlagOverridesFromMap"] as const) {
      expect(typeof confeature[fn]).toBe("function");
      expect(typeof configcat[fn]).toBe("function");
      expect((confeature[fn] as (...a: unknown[]) => unknown).length, `arity of ${fn}`).toBe(
        (configcat[fn] as (...a: unknown[]) => unknown).length,
      );
    }
    // #271 D4 closed: createConsoleLogger arity is now 2 (matches upstream).
    expect(typeof confeature.createConsoleLogger).toBe("function");
    expect(typeof configcat.createConsoleLogger).toBe("function");
    expect(confeature.createConsoleLogger.length).toBe(2);
    expect(confeature.createConsoleLogger.length).toBe(configcat.createConsoleLogger.length);
  });

  test("the client instance exposes the core ConfigCat method surface with matching arity", () => {
    const overrides = { "feature.x": true };
    const confeatureClient = confeature.getClient(SDK_KEY, confeature.PollingMode.ManualPoll, {
      flagOverrides: confeature.createFlagOverridesFromMap(
        overrides,
        confeature.OverrideBehaviour.LocalOnly,
      ),
    });
    const configcatClient = configcat.getClient(SDK_KEY, configcat.PollingMode.ManualPoll, {
      flagOverrides: configcat.createFlagOverridesFromMap(
        overrides,
        configcat.OverrideBehaviour.LocalOnly,
      ),
    });

    // The core async evaluation + lifecycle surface a migrating customer
    // depends on. Each must exist on both clients with the same arity.
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

    // Hooks surface — `on` registers an event listener on both SDKs.
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
