// SPDX-License-Identifier: MIT

/**
 * Unit tests for `evaluateOverrideSync` — exhaustive branch coverage of
 * the 7-branch decision tree in `packages/sdk-shared/src/override-eval.ts`.
 *
 * Spec 036's research (§R4).
 */

import { describe, expect, test } from "vitest";

import { type ISettingValue, SettingType } from "../../src/config-json.ts";
import {
  createFlagOverridesFromMap,
  FlagOverrides,
  type IOverrideDataSource,
  MapOverrideDataSource,
  OverrideBehaviour,
} from "../../src/flag-overrides.ts";
import { evaluateOverrideSync } from "../../src/override-eval.ts";

describe("evaluateOverrideSync — branch coverage", () => {
  test("branch 1 — flagOverrides undefined → undefined (caller falls through)", () => {
    expect(evaluateOverrideSync(undefined, "feature.x", false)).toBeUndefined();
  });

  test("branch 2 — non-LocalOnly behaviour → undefined", () => {
    const localOverRemote = createFlagOverridesFromMap(
      { "feature.x": true },
      OverrideBehaviour.LocalOverRemote,
    );
    expect(evaluateOverrideSync(localOverRemote, "feature.x", false)).toBeUndefined();

    const remoteOverLocal = createFlagOverridesFromMap(
      { "feature.x": true },
      OverrideBehaviour.RemoteOverLocal,
    );
    expect(evaluateOverrideSync(remoteOverLocal, "feature.x", false)).toBeUndefined();
  });

  test("branch 3a — sync method absent on custom impl → undefined (backward-compat)", () => {
    // Customer impl that ONLY provides the async method. The helper
    // must fall through — this is the documented backward-compat path.
    const asyncOnly: IOverrideDataSource = {
      // Widened (spec 135): the source returns `ISetting`s, not bare values.
      getOverrides: () =>
        Promise.resolve({
          "feature.x": { t: SettingType.Boolean, v: { b: true }, i: "", r: [] },
        }),
    };
    const flagOverrides = new FlagOverrides(asyncOnly, OverrideBehaviour.LocalOnly);
    expect(evaluateOverrideSync(flagOverrides, "feature.x", false)).toBeUndefined();
  });

  test("branch 3b — sync method returns null → undefined", () => {
    const nullSync: IOverrideDataSource = {
      getOverrides: () => Promise.resolve({}),
      getOverridesSync: () => null,
    };
    const flagOverrides = new FlagOverrides(nullSync, OverrideBehaviour.LocalOnly);
    expect(evaluateOverrideSync(flagOverrides, "feature.x", false)).toBeUndefined();
  });

  test("branch 4 — empty override map → returns defaultValue (LocalOnly contract)", () => {
    const empty = createFlagOverridesFromMap({}, OverrideBehaviour.LocalOnly);
    // Default is `false` → the helper MUST return `false`, NOT undefined.
    // LocalOnly means "the override map is the universe; do not consult cache."
    expect(evaluateOverrideSync(empty, "feature.x", false)).toBe(false);
    expect(evaluateOverrideSync(empty, "feature.x", true)).toBe(true);
    expect(evaluateOverrideSync(empty, "feature.x", "fallback")).toBe("fallback");
  });

  test("branch 4 — key absent from non-empty map → returns defaultValue", () => {
    const overrides = createFlagOverridesFromMap(
      { "other.key": true },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.missing", false)).toBe(false);
    expect(evaluateOverrideSync(overrides, "feature.missing", true)).toBe(true);
  });

  test("branch 5 — override slot empty (no b/s/i/d) → returns defaultValue", () => {
    // Construct directly via MapOverrideDataSource so we can place a
    // bare `{}` (createFlagOverridesFromMap wouldn't synthesize this).
    const map: Record<string, ISettingValue> = { "feature.x": {} };
    const overrides = new FlagOverrides(
      new MapOverrideDataSource(map),
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.x", false)).toBe(false);
    expect(evaluateOverrideSync(overrides, "feature.x", true)).toBe(true);
  });

  test("branch 6 — TYPE_MISMATCH (string override, boolean default) → returns defaultValue", () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.x": "not-a-bool" },
      OverrideBehaviour.LocalOnly,
    );
    // String override vs boolean default → caller sees the boolean default,
    // NOT silently-coerced. Matches configcat-js semantics.
    expect(evaluateOverrideSync(overrides, "feature.x", false)).toBe(false);
    expect(evaluateOverrideSync(overrides, "feature.x", true)).toBe(true);
  });

  test("branch 6 — TYPE_MISMATCH (boolean override, string default) → returns defaultValue", () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.x": true },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.x", "string-default")).toBe("string-default");
  });

  test("branch 6 bypass — `null` defaultValue accepts any override type", () => {
    // `null` default intentionally skips the type check (matches the
    // existing per-SDK behaviour: `defaultValue !== null && typeof ...`).
    const overrides = createFlagOverridesFromMap(
      { "feature.x": true },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.x", null)).toBe(true);
  });

  test("branch 7 — happy path: boolean override returns the typed value", () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.x": true, "feature.y": false },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.x", false)).toBe(true);
    expect(evaluateOverrideSync(overrides, "feature.y", true)).toBe(false);
  });

  test("branch 7 — happy path: string override returns the typed value", () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.theme": "dark" },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.theme", "light")).toBe("dark");
  });

  test("branch 7 — happy path: numeric override returns the typed value", () => {
    const overrides = createFlagOverridesFromMap(
      { "feature.threshold": 42 },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.threshold", 0)).toBe(42);
  });
});

describe("evaluateOverrideSync — MapOverrideDataSource integration", () => {
  test("MapOverrideDataSource.getOverridesSync wraps each value as a value-only ISetting", () => {
    // Spec 135 widened IOverrideDataSource to `Record<string, ISetting>`. The
    // map source now returns trivial value-only settings (`{ t, v, i: "", r: [] }`)
    // — the stored value envelope is preserved verbatim inside `.v`.
    const map: Record<string, ISettingValue> = { "feature.x": { b: true } };
    const source = new MapOverrideDataSource(map);
    const settings = source.getOverridesSync();
    expect(settings["feature.x"]).toEqual({
      t: SettingType.Boolean,
      v: { b: true },
      i: "",
      r: [],
    });
  });

  test("MapOverrideDataSource.getOverrides resolves to the same wrapped settings (async path unchanged)", async () => {
    const map: Record<string, ISettingValue> = { "feature.x": { s: "dark" } };
    const source = new MapOverrideDataSource(map);
    await expect(source.getOverrides()).resolves.toEqual({
      "feature.x": { t: SettingType.String, v: { s: "dark" }, i: "", r: [] },
    });
  });

  test("recovered `t` discriminator matches the value envelope key (b/s/i/d)", () => {
    const source = new MapOverrideDataSource({
      flagBool: { b: false },
      flagStr: { s: "" },
      flagInt: { i: 0 },
      flagDouble: { d: 1.5 },
    });
    const s = source.getOverridesSync();
    expect(s["flagBool"]?.t).toBe(SettingType.Boolean);
    expect(s["flagStr"]?.t).toBe(SettingType.String);
    expect(s["flagInt"]?.t).toBe(SettingType.Int);
    expect(s["flagDouble"]?.t).toBe(SettingType.Double);
  });
});

// ---------------------------------------------------------------------------
// T004 (spec 135) — flat map override path is byte-identical after the
// IOverrideDataSource widening (FR-004 / INV-2). Every branch of the 7-branch
// LocalOnly contract above already exercises `createFlagOverridesFromMap`; this
// block pins the exact resolved values once more, end-to-end, to guard against
// any drift introduced by the value-only-ISetting wrapping.
// ---------------------------------------------------------------------------

describe("flat map override path — byte-identical resolution after widening (T004)", () => {
  test("typed happy paths resolve to the same values as before the widening", () => {
    const overrides = createFlagOverridesFromMap(
      { boolOn: true, boolOff: false, theme: "dark", threshold: 42 },
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "boolOn", false)).toBe(true);
    expect(evaluateOverrideSync(overrides, "boolOff", true)).toBe(false);
    expect(evaluateOverrideSync(overrides, "theme", "light")).toBe("dark");
    expect(evaluateOverrideSync(overrides, "threshold", 0)).toBe(42);
  });

  test("LocalOnly no-fall-through (missing key + type mismatch) preserved", () => {
    const overrides = createFlagOverridesFromMap({ present: true }, OverrideBehaviour.LocalOnly);
    // Missing key → default (never the cache).
    expect(evaluateOverrideSync(overrides, "absent", "fallback")).toBe("fallback");
    // TYPE_MISMATCH → default.
    expect(evaluateOverrideSync(overrides, "present", "string-default")).toBe("string-default");
    // null default bypasses the type check.
    expect(evaluateOverrideSync(overrides, "present", null)).toBe(true);
  });

  test("empty value envelope still yields the default (branch 5)", () => {
    const overrides = new FlagOverrides(
      new MapOverrideDataSource({ "feature.x": {} }),
      OverrideBehaviour.LocalOnly,
    );
    expect(evaluateOverrideSync(overrides, "feature.x", false)).toBe(false);
    expect(evaluateOverrideSync(overrides, "feature.x", "x")).toBe("x");
  });
});
