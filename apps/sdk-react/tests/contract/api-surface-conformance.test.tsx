// SPDX-License-Identifier: MIT

/**
 * API-surface conformance vs `configcat-react` (epic #264, Constitution
 * Principle II — drop-in compatibility).
 *
 * A consumer migrating from `configcat-react` to `@confeature/sdk-react`
 * must change only the base URL. That guarantee holds only if every
 * public symbol `configcat-react` exports is also exported here, and the
 * shared hook / enum surface matches. This test PROVES the matching
 * surface and GUARDS against future drift — a renamed export or a hook
 * that loses an argument fails here.
 *
 * Mirrors #254's `apps/sdk-browser-js/tests/contract/api-surface-conformance.test.ts`
 * shape: a `valueExports` set-superset comparison, an `enumMemberNames`
 * named-member comparison, `typeof` + `.length` arity checks. Reflection
 * only — `Object.keys` / `typeof` / `.length`. No network, so this runs
 * un-gated alongside the rest of the suite.
 *
 * `configcat-react` is pinned at `^4.x` in `package.json`; the test
 * reads its exports reflectively, so it adapts to whichever `4.x` is
 * installed. Bumping to v5 is out of scope (#255 / spec 068).
 *
 * All 5 #271 divergences closed (spec 076 + spec 078, merge 2026-05-25):
 * SettingType.Boolean, ClientCacheState.HasLocalOverrideFlagDataOnly
 * (+ aligned 0/1/2/3 numerics), isOffline-as-getter,
 * createConsoleLogger arity 2, AND createFlagOverridesFromQueryParams
 * is now exported by @confeature/sdk-react (re-exported transitively
 * from @confeature/sdk-shared via @confeature/sdk-browser-js).
 *
 * The remaining acknowledged DIVERGENCE: configcat-react enums are
 * numeric TS enums (reverse-mapped at runtime); Confeature's are
 * name-keyed const objects. The comparison below is on the *named*
 * members — the surface a consumer references.
 */

import { describe, expect, test } from "vitest";

import * as confeature from "../../src/index.ts";
import * as configcat from "configcat-react";

/**
 * #271 fully closed via spec 078 — `createFlagOverridesFromQueryParams`
 * is now exported transitively from `@confeature/sdk-shared` through
 * `@confeature/sdk-browser-js`. No remaining accepted gaps.
 */
const KNOWN_MISSING_VS_CONFIGCAT_REACT: string[] = [];

/**
 * CJS-interop artefact keys a bundled CommonJS module exposes through
 * an ESM star-import (`__esModule`, `module.exports`). They are not
 * part of either SDK's public surface and must be filtered out before
 * the comparison.
 */
const CJS_ARTEFACT_KEYS = new Set(["__esModule", "module.exports", "exports"]);

/** Runtime value exports (typeof !== "undefined"). Type-only exports
 *  vanish after compilation, so they cannot be reflected at runtime. */
function valueExports(mod: Record<string, unknown>): Set<string> {
  return new Set(
    Object.keys(mod).filter(
      (k) => k !== "default" && !CJS_ARTEFACT_KEYS.has(k) && typeof mod[k] !== "undefined",
    ),
  );
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

describe("API-surface conformance vs configcat-react (#264)", () => {
  test("every configcat-react public value export is present in sdk-react (modulo #271)", () => {
    const ccExports = valueExports(configcat as unknown as Record<string, unknown>);
    const cfExports = valueExports(confeature as unknown as Record<string, unknown>);

    // Superset check — Confeature MAY add its own symbols
    // (`ConfeatureProvider`, `useConfeatureClient`, …); the reverse — a
    // configcat-react symbol missing here — is a Principle II concern.
    const missing = [...ccExports].filter((sym) => !cfExports.has(sym)).sort();

    // #271 fully closed via spec 078 — every configcat-react public
    // export is now present on @confeature/sdk-react.
    expect(missing).toEqual([...KNOWN_MISSING_VS_CONFIGCAT_REACT].sort());
  });

  test("the React hooks + HOC + provider are exported by sdk-react", () => {
    // The React-idiomatic surface a configcat-react consumer references.
    for (const sym of [
      "ConfigCatProvider",
      "useFeatureFlag",
      "useConfigCatClient",
      "withConfigCatClient",
    ] as const) {
      expect(typeof (confeature as Record<string, unknown>)[sym]).not.toBe("undefined");
      expect(typeof (configcat as Record<string, unknown>)[sym]).not.toBe("undefined");
    }
  });

  test("useFeatureFlag is a function on both with matching arity", () => {
    expect(typeof confeature.useFeatureFlag).toBe("function");
    expect(typeof configcat.useFeatureFlag).toBe("function");
    expect(confeature.useFeatureFlag.length, "arity of useFeatureFlag").toBe(
      configcat.useFeatureFlag.length,
    );
  });

  test("withConfigCatClient is a function on both", () => {
    expect(typeof confeature.withConfigCatClient).toBe("function");
    expect(typeof configcat.withConfigCatClient).toBe("function");
  });

  test("createFlagOverridesFromMap is a function on both with matching arity", () => {
    expect(typeof confeature.createFlagOverridesFromMap).toBe("function");
    expect(typeof configcat.createFlagOverridesFromMap).toBe("function");
    expect(
      (confeature.createFlagOverridesFromMap as (...a: unknown[]) => unknown).length,
      "arity of createFlagOverridesFromMap",
    ).toBe((configcat.createFlagOverridesFromMap as (...a: unknown[]) => unknown).length);
  });

  test("PollingMode named members + values match configcat-react", () => {
    expect(enumMemberNames(confeature.PollingMode)).toEqual(enumMemberNames(configcat.PollingMode));
    expect(confeature.PollingMode.AutoPoll).toBe(configcat.PollingMode.AutoPoll);
    expect(confeature.PollingMode.LazyLoad).toBe(configcat.PollingMode.LazyLoad);
    expect(confeature.PollingMode.ManualPoll).toBe(configcat.PollingMode.ManualPoll);
  });

  test("OverrideBehaviour named members + values match configcat-react", () => {
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

  test("LogLevel named members + values match configcat-react", () => {
    expect(enumMemberNames(confeature.LogLevel)).toEqual(enumMemberNames(configcat.LogLevel));
    expect(confeature.LogLevel.Error).toBe(configcat.LogLevel.Error);
    expect(confeature.LogLevel.Warn).toBe(configcat.LogLevel.Warn);
    expect(confeature.LogLevel.Info).toBe(configcat.LogLevel.Info);
    expect(confeature.LogLevel.Debug).toBe(configcat.LogLevel.Debug);
    expect(confeature.LogLevel.Off).toBe(configcat.LogLevel.Off);
  });

  test("SettingType named members + values match configcat-react (#271 D1 closed)", () => {
    expect(enumMemberNames(confeature.SettingType)).toEqual(enumMemberNames(configcat.SettingType));
    expect(confeature.SettingType.Boolean).toBe(configcat.SettingType.Boolean);
    expect(confeature.SettingType.String).toBe(configcat.SettingType.String);
    expect(confeature.SettingType.Int).toBe(configcat.SettingType.Int);
    expect(confeature.SettingType.Double).toBe(configcat.SettingType.Double);
  });

  test("ClientCacheState named members + values match configcat-react (#271 D2 closed)", () => {
    expect(enumMemberNames(confeature.ClientCacheState)).toEqual(
      enumMemberNames(configcat.ClientCacheState),
    );
    expect(confeature.ClientCacheState.NoFlagData).toBe(0);
    expect(confeature.ClientCacheState.HasLocalOverrideFlagDataOnly).toBe(1);
    expect(confeature.ClientCacheState.HasCachedFlagDataOnly).toBe(2);
    expect(confeature.ClientCacheState.HasUpToDateFlagData).toBe(3);
    expect(confeature.ClientCacheState.NoFlagData).toBe(configcat.ClientCacheState.NoFlagData);
  });
});

// PROOF (#911, FR-013): a deliberate break. This pull request is closed unmerged.
test("proof/911: the react gate must go red", () => expect(1).toBe(2));
