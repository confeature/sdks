// SPDX-License-Identifier: MIT

/**
 * #826 — a setting keyed `__proto__` is a valid ConfigCat key (its Management
 * API puts no pattern on `key`), so the api serves it as an own property of
 * config_v6 `f`. These tests hold the JS family to keeping that key from the
 * wire through evaluation and through every override source, without ever
 * writing into a prototype.
 *
 * Each config is built with `JSON.parse`, never an object literal: a literal
 * `{ __proto__: … }` sets the prototype instead of creating the key, which is
 * exactly the bug class under test.
 */

import { afterEach, describe, expect, test } from "vitest";

import type { IConfig } from "../../src/config-json.ts";
import { RolloutEvaluator } from "../../src/evaluator.ts";
import { createFlagOverridesFromMap, OverrideBehaviour } from "../../src/flag-overrides.ts";
import { LoggerWrapper, NullLogger } from "../../src/logger.ts";
import { evaluateOverride } from "../../src/override-eval.ts";
import { ProjectConfig } from "../../src/project-config.ts";
import { createFlagOverridesFromQueryParams } from "../../src/query-param-overrides.ts";
import { getUserAttribute, User } from "../../src/user.ts";

const SERVED = `{
  "p": { "u": "https://cdn.confeature.io", "r": 0, "s": "salt" },
  "f": {
    "__proto__": { "t": 0, "v": { "b": true }, "i": "v-proto", "r": [] },
    "other": { "t": 0, "v": { "b": true }, "i": "v-other", "r": [] }
  },
  "s": []
}`;

const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));

/** The JS clients' `getValue` order: an override first, then the served config. */
function getValue<T>(
  config: ProjectConfig,
  key: string,
  defaultValue: T,
  flagOverrides?: Parameters<typeof evaluateOverride>[0],
): unknown {
  const override = evaluateOverride(flagOverrides, key, defaultValue, undefined, evaluator);
  if (override !== undefined) return override;
  return evaluator.evaluate(config, key, defaultValue).value;
}

/** Snapshot of what a fresh `{}` and `Object.prototype` expose, to detect pollution. */
function prototypeSurface(): string[] {
  return [...Object.getOwnPropertyNames(Object.prototype), ...Object.keys({})].sort();
}

const before = prototypeSurface();

afterEach(() => {
  expect(prototypeSurface()).toEqual(before);
  expect(({} as Record<string, unknown>).b).toBeUndefined();
  expect(({} as Record<string, unknown>).s).toBeUndefined();
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

describe("#826 — a flag keyed __proto__", () => {
  test("a served config_v6 __proto__ flag evaluates to its served value, not the default", () => {
    const config = new ProjectConfig(JSON.parse(SERVED) as IConfig, '"e"', Date.now());
    const details = evaluator.evaluate(config, "__proto__", false);
    expect(details.value).toBe(true);
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("v-proto");
    expect(getValue(config, "__proto__", false)).toBe(true);
  });

  test("a config that does not serve __proto__ returns the default for it", () => {
    const config = new ProjectConfig(
      JSON.parse('{"p":{"u":"","r":0,"s":""},"f":{},"s":[]}') as IConfig,
      null,
      Date.now(),
    );
    const details = evaluator.evaluate(config, "__proto__", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
    expect(details.errorMessage).toBe("Setting not found.");
  });

  test("a flag-overrides map keyed __proto__ resolves under LocalOnly", () => {
    const map = JSON.parse('{"__proto__": true, "other": true}') as Record<string, boolean>;
    const overrides = createFlagOverridesFromMap(map, OverrideBehaviour.LocalOnly);
    const settings = overrides.dataSource.getOverridesSync?.() ?? {};
    expect(Object.keys(settings).sort()).toEqual(["__proto__", "other"]);
    const config = ProjectConfig.empty();
    expect(getValue(config, "__proto__", false, overrides)).toBe(true);
    expect(getValue(config, "other", false, overrides)).toBe(true);
  });

  test("a flag-overrides map without __proto__ returns the default for it", () => {
    const overrides = createFlagOverridesFromMap({ other: true }, OverrideBehaviour.LocalOnly);
    expect(getValue(ProjectConfig.empty(), "__proto__", false, overrides)).toBe(false);
  });

  test("a query-param override keyed __proto__ resolves, both plain and ;str", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      {
        currentValue: "?cc-__proto__=true&cc-other=true",
      },
    );
    const settings = overrides.dataSource.getOverridesSync?.() ?? {};
    expect(Object.keys(settings).sort()).toEqual(["__proto__", "other"]);
    expect(getValue(ProjectConfig.empty(), "__proto__", false, overrides)).toBe(true);

    const forced = createFlagOverridesFromQueryParams(OverrideBehaviour.LocalOnly, false, "cc-", {
      currentValue: "?cc-__proto__;str=on",
    });
    expect(getValue(ProjectConfig.empty(), "__proto__", "off", forced)).toBe("on");
  });

  test("an override source returns an object whose prototype a hostile key cannot reach", () => {
    const overrides = createFlagOverridesFromQueryParams(
      OverrideBehaviour.LocalOnly,
      false,
      "cc-",
      {
        currentValue: "?cc-__proto__;str=polluted&cc-constructor=true",
      },
    );
    const settings = overrides.dataSource.getOverridesSync?.() ?? {};
    expect(Object.getPrototypeOf(settings)).toBeNull();
    expect(getValue(ProjectConfig.empty(), "constructor", false, overrides)).toBe(true);
    expect(getValue(ProjectConfig.empty(), "toString", false, overrides)).toBe(false);
  });
});

describe("#826 — a user attribute named like an Object.prototype member", () => {
  test("is missing unless the user sets it", () => {
    const user = new User("id-1");
    expect(getUserAttribute(user, "constructor")).toBeUndefined();
    expect(getUserAttribute(user, "toString")).toBeUndefined();
    const custom = JSON.parse('{"__proto__": "x"}') as Record<string, string>;
    expect(getUserAttribute(new User("id-1", undefined, undefined, custom), "__proto__")).toBe("x");
  });
});
