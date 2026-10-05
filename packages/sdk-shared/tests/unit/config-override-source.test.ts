// SPDX-License-Identifier: MIT

/**
 * Unit tests for `ConfigOverrideDataSource` (spec 135, T005). The full-config
 * override source must expose the parsed `config.f` settings with their
 * targeting-rule (`r`) arrays INTACT — that rule data is what the full-config
 * eval path resolves through the real engine (unlike the value-only map source,
 * which flattens to `{ b/s/i/d }`).
 */

import { describe, expect, test } from "vitest";

import type { IConfig } from "../../src/config-json.ts";
import { ConfigOverrideDataSource } from "../../src/flag-overrides.ts";

/** A rule-bearing config: `pet` = "Cat", one rule "Email CONTAINS @x → Dog". */
const RULE_CONFIG: IConfig = {
  p: { u: "", r: 0, s: "salt-value" },
  s: [],
  f: {
    pet: {
      t: 1,
      v: { s: "Cat" },
      i: "petBase",
      r: [
        {
          c: [{ u: { a: "Email", c: 2, l: ["@configcat.com"] } }],
          s: { v: { s: "Dog" }, i: "petDog" },
        },
      ],
    },
  },
} as unknown as IConfig;

describe("ConfigOverrideDataSource (spec 135, T005)", () => {
  test("getOverridesSync returns config.f with the targeting-rule array intact", () => {
    const source = new ConfigOverrideDataSource(RULE_CONFIG);
    const settings = source.getOverridesSync();
    // Same reference as the config's `f` map — no copy / no flattening.
    expect(settings).toBe(RULE_CONFIG.f);
    const pet = settings["pet"];
    expect(pet).toBeDefined();
    expect(pet?.v).toEqual({ s: "Cat" });
    // Rule array survives — this is the whole point vs the value-only map source.
    expect(pet?.r).toHaveLength(1);
    expect(pet?.r[0]?.s?.v).toEqual({ s: "Dog" });
    expect(pet?.r[0]?.c[0]?.u?.a).toBe("Email");
  });

  test("getOverrides resolves to the same rule-bearing settings (async)", async () => {
    const source = new ConfigOverrideDataSource(RULE_CONFIG);
    const settings = await source.getOverrides();
    expect(settings).toBe(RULE_CONFIG.f);
    expect(settings["pet"]?.r).toHaveLength(1);
  });

  test("retains the full IConfig (salt + segments), not just f", () => {
    const source = new ConfigOverrideDataSource(RULE_CONFIG);
    // INV-4: the source must carry the whole `{ p, f, s }` so the eval path can
    // thread salt + segments — not only the `f` settings map.
    expect(source.config).toBe(RULE_CONFIG);
    expect(source.config.p.s).toBe("salt-value");
    expect(Array.isArray(source.config.s)).toBe(true);
  });
});
