// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";

import {
  createFlagOverridesFromQueryParams,
  type IOverrideDataSource,
  type IQueryStringProvider,
  type ISettingValue,
  OverrideBehaviour,
} from "../src/index.ts";

function provider(current: string | undefined): IQueryStringProvider {
  return { currentValue: current };
}

/**
 * The override source returns value-only `ISetting`s (`{ t, v, i: "", r: [] }`)
 * since spec 135 widened `IOverrideDataSource`. These tests validate query-
 * string PARSING (the `v` envelope), so unwrap each setting to its `.v` for a
 * focused assertion.
 */
function envelopes(source: IOverrideDataSource): Record<string, ISettingValue> {
  const settings = source.getOverridesSync?.() ?? {};
  const out: Record<string, ISettingValue> = {};
  for (const [key, setting] of Object.entries(settings)) out[key] = setting.v;
  return out;
}

describe("createFlagOverridesFromQueryParams (#271 D5)", () => {
  test("parses boolean true/false (case-insensitive)", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-on=true&cc-off=False"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      on: { b: true },
      off: { b: false },
    });
  });

  test("parses numeric values as doubles", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-port=8080&cc-ratio=3.14"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      port: { d: 8080 },
      ratio: { d: 3.14 },
    });
  });

  test("falls through to string for anything else", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-name=alice"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      name: { s: "alice" },
    });
  });

  test("`;str` suffix forces string interpretation of a numeric-looking value", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-id;str=42"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      id: { s: "42" },
    });
  });

  test("ignores non-prefixed keys and short keys", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-x=hello&unrelated=ignored&cc-=empty"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({ x: { s: "hello" } });
  });

  test("URL-decodes + applies `+` → space substitution", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-greeting=hello+world%21"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      greeting: { s: "hello world!" },
    });
  });

  test("empty / missing query string yields empty record", () => {
    expect(
      envelopes(
        createFlagOverridesFromQueryParams(
          OverrideBehaviour.LocalOnly,
          false,
          "cc-",
          provider(undefined),
        ).dataSource,
      ),
    ).toEqual({});
    expect(
      envelopes(
        createFlagOverridesFromQueryParams(OverrideBehaviour.LocalOnly, false, "cc-", provider(""))
          .dataSource,
      ),
    ).toEqual({});
  });

  test("rejects strict-parse-falsey numerics — whitespace and leading 0x/octal", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      provider("?cc-a=%20%20&cc-b=0xff"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({
      a: { s: "  " },
      b: { s: "0xff" },
    });
  });

  test("watchChanges=true picks up later URL changes", () => {
    let current: string | undefined = "?cc-flag=true";
    const p: IQueryStringProvider = {
      get currentValue() {
        return current;
      },
    };
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      true,
      "cc-",
      p,
    );
    expect(envelopes(overrides.dataSource)).toEqual({ flag: { b: true } });
    current = "?cc-flag=false";
    expect(envelopes(overrides.dataSource)).toEqual({ flag: { b: false } });
  });

  test("watchChanges=false freezes settings at construction", () => {
    let current: string | undefined = "?cc-flag=true";
    const p: IQueryStringProvider = {
      get currentValue() {
        return current;
      },
    };
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      p,
    );
    expect(envelopes(overrides.dataSource)).toEqual({ flag: { b: true } });
    current = "?cc-flag=false";
    expect(envelopes(overrides.dataSource)).toEqual({ flag: { b: true } });
  });

  test("custom paramPrefix is honoured", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "ff-",
      provider("?ff-foo=true&cc-bar=ignored"),
    );
    expect(envelopes(overrides.dataSource)).toEqual({ foo: { b: true } });
  });

  test("returns a FlagOverrides instance with the supplied behaviour", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOverRemote,
      false,
      "cc-",
      provider("?cc-x=1"),
    );
    expect(overrides.behaviour).toBe(OverrideBehaviour.LocalOverRemote);
    expect(typeof overrides.dataSource.getOverridesSync).toBe("function");
  });

  test("default provider does not throw in non-browser (SSR) environment", () => {
    // The default DefaultQueryStringProvider gracefully handles missing
    // `window`. We invoke it without injecting a provider — the global
    // `window` is whatever the test runner sets up (vitest node env =
    // undefined). The expectation is "no throw + empty record".
    expect(() => createFlagOverridesFromQueryParams(OverrideBehaviour.LocalOnly)).not.toThrow();
  });
});
