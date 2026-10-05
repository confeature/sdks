// SPDX-License-Identifier: MIT

/**
 * API-surface conformance for `@confeature/sdk-angular` (epic #264,
 * Constitution Principle II — drop-in compatibility).
 *
 * ── ConfigCat publishes NO official Angular SDK ──────────────────────
 * Verified 2026-05-22 against the npm registry: `@configcat/angular`,
 * `configcat-angular`, `configcat-ng`, `ng-configcat`, and
 * `@configcat/ng-client` ALL return HTTP 404. ConfigCat's published JS
 * family is `configcat-js`, `configcat-react`, `configcat-js-ssr`, and
 * `@configcat/sdk`; there is no `configcat.com/docs/sdk-reference/angular/`
 * page. ConfigCat's own guidance for Angular consumers is to use
 * `configcat-js` directly.
 *
 * `@configcat/ng-client` — referenced in earlier `sdk-angular` source
 * comments and (until #255) the `package.json` description — does NOT
 * exist on npm. It was a stale aspiration; this doc comment is the
 * authoritative correction (spec 068 FR-018).
 *
 * Consequently this conformance test has TWO halves:
 *  1. The runtime-SDK surface `sdk-angular` re-exports from
 *     `@confeature/sdk-browser-js` (`ConfeatureClient`, `User`,
 *     `PollingMode`, `OverrideBehaviour`, `LogLevel`, `FlagOverrides`,
 *     `MapOverrideDataSource`, `createFlagOverridesFromMap`) — conformed
 *     against `configcat-js`, the runtime SDK an Angular consumer would
 *     otherwise reach for.
 *  2. The Angular-idiomatic facade (`ConfeatureService`,
 *     `provideConfeature`, `ConfeatureModule`, `ConfeatureFlagDirective`,
 *     `ConfeatureFlagPipe`) — which has NO ConfigCat counterpart by
 *     design. This test asserts those symbols are exported and records
 *     the no-official-counterpart fact. It is the worked precedent for
 *     any later #256-#261 SDK family whose ConfigCat counterpart is
 *     absent or community-maintained.
 *
 * Mirrors #254's `apps/sdk-browser-js/tests/contract/api-surface-conformance.test.ts`
 * shape: a `valueExports` set comparison, an `enumMemberNames`
 * named-member comparison, `typeof` + `.length` arity checks. Reflection
 * only — `Object.keys` / `typeof` / `.length`. No network.
 *
 * KNOWN DIVERGENCES vs configcat-js (triaged under epic #264 / #271),
 * inherited from `@confeature/sdk-browser-js` — asserted against
 * Confeature's *current* behaviour so this test still guards drift:
 *  - `SettingType` member is `Bool`; configcat-js names it `Boolean`.
 *  - `client.isOffline` is a method here; configcat-js exposes it as a
 *    `readonly` getter property.
 */

import { describe, expect, test } from "vitest";

import * as confeature from "../../src/index";
import * as configcat from "configcat-js";

const SDK_KEY = "configcat-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/**
 * CJS-interop artefact keys a bundled CommonJS module exposes through
 * an ESM star-import — not part of the public surface.
 */
const CJS_ARTEFACT_KEYS = new Set(["__esModule", "module.exports", "exports"]);

/** Runtime value exports (typeof !== "undefined"). */
function valueExports(mod: Record<string, unknown>): Set<string> {
  return new Set(
    Object.keys(mod).filter(
      (k) => k !== "default" && !CJS_ARTEFACT_KEYS.has(k) && typeof mod[k] !== "undefined",
    ),
  );
}

/** The named members of an enum — strips the numeric reverse-mapping
 *  keys a TS numeric enum emits so a name-keyed const object and a
 *  numeric enum compare on the surface a consumer references. */
function enumMemberNames(e: Record<string, unknown>): string[] {
  return Object.keys(e)
    .filter((k) => !/^-?\d+$/.test(k))
    .sort();
}

/**
 * The runtime-SDK value symbols `sdk-angular` re-exports from
 * `@confeature/sdk-browser-js` (per `src/index.ts`). Each has a
 * `configcat-js` counterpart.
 */
const RE_EXPORTED_RUNTIME_SYMBOLS = [
  "ConfeatureClient",
  "User",
  "PollingMode",
  "OverrideBehaviour",
  "LogLevel",
  "FlagOverrides",
  "MapOverrideDataSource",
  "createFlagOverridesFromMap",
] as const;

/**
 * The Angular-idiomatic facade symbols. ConfigCat publishes no Angular
 * SDK, so these have NO conformance counterpart by design.
 */
const ANGULAR_FACADE_SYMBOLS = [
  "ConfeatureService",
  "provideConfeature",
  "ConfeatureModule",
  "ConfeatureFlagDirective",
  "ConfeatureFlagPipe",
] as const;

describe("API-surface conformance — sdk-angular (#264, no official ConfigCat Angular SDK)", () => {
  test("the re-exported runtime-SDK value symbols are all exported by sdk-angular", () => {
    const cfExports = valueExports(confeature as unknown as Record<string, unknown>);
    const missing = RE_EXPORTED_RUNTIME_SYMBOLS.filter((sym) => !cfExports.has(sym));
    expect(missing).toEqual([]);
  });

  test("each re-exported runtime-SDK symbol that configcat-js exposes at runtime has a counterpart", () => {
    const ccExports = valueExports(configcat as unknown as Record<string, unknown>);
    // `ConfeatureClient`, `FlagOverrides`, `MapOverrideDataSource` are
    // exported as RUNTIME values by Confeature but are TYPE-ONLY in
    // configcat-js (instances come from `getClient(...)`; overrides
    // from `createFlagOverridesFromMap(...)`). The client surface is
    // conformed by arity in a dedicated test below. The remaining
    // re-exported symbols must have a same-named runtime counterpart.
    const CONFEATURE_VALUE_ADDITIONS = new Set([
      "ConfeatureClient",
      "FlagOverrides",
      "MapOverrideDataSource",
    ]);
    for (const sym of RE_EXPORTED_RUNTIME_SYMBOLS) {
      if (CONFEATURE_VALUE_ADDITIONS.has(sym)) continue;
      expect(ccExports.has(sym), `configcat-js counterpart for ${sym}`).toBe(true);
    }
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

  test("createFlagOverridesFromMap is a function on both with matching arity", () => {
    expect(typeof confeature.createFlagOverridesFromMap).toBe("function");
    expect(typeof configcat.createFlagOverridesFromMap).toBe("function");
    expect(
      (confeature.createFlagOverridesFromMap as (...a: unknown[]) => unknown).length,
      "arity of createFlagOverridesFromMap",
    ).toBe((configcat.createFlagOverridesFromMap as (...a: unknown[]) => unknown).length);
  });

  test("a ConfeatureClient instance exposes the core configcat-js method surface with matching arity", () => {
    const overrides = { "feature.x": true };
    const confeatureClient = new confeature.ConfeatureClient(
      SDK_KEY,
      confeature.PollingMode.ManualPoll,
      {
        flagOverrides: confeature.createFlagOverridesFromMap(
          overrides,
          confeature.OverrideBehaviour.LocalOnly,
        ),
      },
    );
    const configcatClient = configcat.getClient(SDK_KEY, configcat.PollingMode.ManualPoll, {
      flagOverrides: configcat.createFlagOverridesFromMap(
        overrides,
        configcat.OverrideBehaviour.LocalOnly,
      ),
    });

    try {
      // The core async evaluation + lifecycle surface a migrating
      // Angular consumer (via configcat-js) depends on.
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

      // #271 D3 closed: `isOffline` is a readonly getter property on both
      // SDKs. A consumer writing `if (client.isOffline)` sees a boolean.
      expect(typeof (confeatureClient as unknown as Record<string, unknown>)["isOffline"]).toBe(
        "boolean",
      );
      expect(typeof (configcatClient as unknown as Record<string, unknown>)["isOffline"]).toBe(
        "boolean",
      );
    } finally {
      confeatureClient.dispose();
      configcatClient.dispose();
    }
  });

  test("the Angular-idiomatic facade symbols are exported (no ConfigCat counterpart by design)", () => {
    // ConfigCat publishes NO Angular SDK (see file doc comment), so
    // these symbols have nothing to conform against — this test asserts
    // only that they ARE exported. It is the no-official-counterpart
    // precedent for #256-#261.
    const cfExports = valueExports(confeature as unknown as Record<string, unknown>);
    const missing = ANGULAR_FACADE_SYMBOLS.filter((sym) => !cfExports.has(sym));
    expect(missing).toEqual([]);

    // And the facade has no counterpart in configcat-js — assert the
    // absence explicitly so the no-official-Angular-SDK fact is
    // machine-recorded, not just prose.
    const ccExports = valueExports(configcat as unknown as Record<string, unknown>);
    for (const sym of ANGULAR_FACADE_SYMBOLS) {
      expect(ccExports.has(sym), `configcat-js must NOT export ${sym}`).toBe(false);
    }
  });
});
