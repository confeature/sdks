// SPDX-License-Identifier: MIT

/**
 * Integration tests for the full-config offline override path (spec 135,
 * T006 + T007). Proves that a complete, rule-bearing `config_v6` blob supplied
 * via `createFlagOverridesFromConfig(..., LocalOnly)` resolves through the real
 * `RolloutEvaluator` — targeting rules AND salt/segment threading — with NO
 * network access (the override path never touches a fetcher / cache).
 *
 * The fixtures are the vendored upstream evaluation-log scenarios (same corpus
 * `parity-upstream.test.ts` replays): `1_targeting_rule` carries the
 * `stringContainsDogDefaultCat` flag ("Email CONTAINS @configcat.com → Dog",
 * base "Cat"); `segment` carries a salt + segment-bearing config. They are read
 * by relative path (NOT the package name) to keep the workspace dependency
 * graph acyclic — sdk-shared must not declare a devDependency on
 * test-fixtures-sdk-parity (#417); see `parity-upstream.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  type CorpusUser,
  type EvalLogTuple,
  loadEvalLogScenario,
} from "../../test-fixtures-sdk-parity/src/index.ts";

import type { IConfig } from "../src/config-json.ts";
import { RolloutEvaluator } from "../src/evaluator.ts";
import { createFlagOverridesFromConfig, OverrideBehaviour } from "../src/flag-overrides.ts";
import { LoggerWrapper, NullLogger } from "../src/logger.ts";
import { evaluateFullConfigOverrideSync, evaluateOverride } from "../src/override-eval.ts";
import { User } from "../src/user.ts";

const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));

function toUser(u: CorpusUser | undefined): User | undefined {
  if (!u) return undefined;
  return new User(u.identifier ?? "", u.email, u.country, u.custom ?? {});
}

// ---------------------------------------------------------------------------
// T006 — Dog / Cat / Cat / Cat for the "Email CONTAINS @configcat.com → Dog"
// rule (match / no-match / no-attr / no-user), resolved offline.
// ---------------------------------------------------------------------------

describe("full-config override — targeting-rule resolution offline (T006)", () => {
  const cases = loadEvalLogScenario("1_targeting_rule");

  it("loads the stringContainsDogDefaultCat scenario (4 cases)", () => {
    expect(cases).toHaveLength(4);
    expect(cases.every((c) => c.key === "stringContainsDogDefaultCat")).toBe(true);
  });

  for (const c of cases) {
    const label = c.user ? JSON.stringify(c.user) : "no-user";
    it(`resolves ${c.expectedValue} for user=${label}`, () => {
      const overrides = createFlagOverridesFromConfig(c.config, OverrideBehaviour.LocalOnly);
      const value = evaluateFullConfigOverrideSync(
        overrides,
        c.key,
        "default",
        toUser(c.user),
        evaluator,
      );
      expect(value).toBe(c.expectedValue);
    });
  }

  it("the four-way matrix is exactly Dog / Cat / Cat / Cat", () => {
    const config = cases[0]?.config as IConfig;
    const overrides = createFlagOverridesFromConfig(config, OverrideBehaviour.LocalOnly);
    const evalFor = (u: User | undefined) =>
      evaluateFullConfigOverrideSync(
        overrides,
        "stringContainsDogDefaultCat",
        "default",
        u,
        evaluator,
      );

    // match → Dog
    expect(evalFor(new User("12345", "joe@configcat.com"))).toBe("Dog");
    // attribute present, no match → Cat
    expect(evalFor(new User("12345", "joe@example.com"))).toBe("Cat");
    // user present, no targeted attribute → Cat
    expect(evalFor(new User("12345"))).toBe("Cat");
    // no user → Cat (base value; rule needs a user)
    expect(evalFor(undefined)).toBe("Cat");
  });

  it("the shared router dispatches a full-config source to the rule engine", () => {
    const config = cases[0]?.config as IConfig;
    const overrides = createFlagOverridesFromConfig(config, OverrideBehaviour.LocalOnly);
    // The router (`evaluateOverride`) is the seam the per-SDK call sites use in
    // US2. A matching user must reach the rule value via the router, not the
    // flat-map path (which would mis-read the rule-bearing setting).
    const value = evaluateOverride(
      overrides,
      "stringContainsDogDefaultCat",
      "default",
      new User("12345", "joe@configcat.com"),
      evaluator,
    );
    expect(value).toBe("Dog");
  });
});

// ---------------------------------------------------------------------------
// T007 — the full `{p,f,s}` blob is threaded (salt + segments), not just `f`
// (guards the spec-129 dropped-salted-config regression). The `segment`
// scenario carries `p.s` (salt) + `s` (segments); a segment match only resolves
// correctly when both reach the evaluator.
// ---------------------------------------------------------------------------

describe("full-config override — threads the full {p,f,s} blob (T007, INV-4)", () => {
  const cases = loadEvalLogScenario("segment");

  it("the segment scenario config carries salt + segments", () => {
    const config = cases[0]?.config as IConfig;
    expect(config.p.s.length).toBeGreaterThan(0); // salt present
    expect(config.s.length).toBeGreaterThan(0); // segments present
  });

  it("a segment-targeted flag resolves through the threaded config", () => {
    // featureWithSegmentTargeting + jane@example.com → true (segment match).
    const match = cases.find(
      (c) => c.key === "featureWithSegmentTargeting" && c.user !== undefined,
    ) as EvalLogTuple | undefined;
    expect(match).toBeDefined();
    const t = match as EvalLogTuple;
    const overrides = createFlagOverridesFromConfig(t.config, OverrideBehaviour.LocalOnly);
    const value = evaluateFullConfigOverrideSync(
      overrides,
      t.key,
      false,
      toUser(t.user),
      evaluator,
    );
    expect(value).toBe(t.expectedValue);
    expect(value).toBe(true);
  });

  it("dropping the salt+segments (only `f`) breaks the segment match — proving INV-4 matters", () => {
    const match = cases.find(
      (c) => c.key === "featureWithSegmentTargeting" && c.user !== undefined,
    ) as EvalLogTuple;
    // Reconstruct a config that keeps ONLY `f` (empty salt + no segments) — the
    // exact spec-129 dropped-salted-config bug class. The segment can no longer
    // be resolved, so the match must NOT produce `true`.
    const stripped = {
      p: { u: "", r: 0, s: "" },
      s: [],
      f: match.config.f,
    } as unknown as IConfig;
    const overrides = createFlagOverridesFromConfig(stripped, OverrideBehaviour.LocalOnly);
    const value = evaluateFullConfigOverrideSync(
      overrides,
      match.key,
      false,
      toUser(match.user),
      evaluator,
    );
    // With segments dropped the rule can't match → falls back to the base
    // value, NOT the segment-served `true`. This is the regression INV-4 guards:
    // the production path MUST pass the full `{p,f,s}`, never just `f`.
    expect(value).not.toBe(true);
  });

  for (const c of cases) {
    const label = c.user ? JSON.stringify(c.user) : "no-user";
    it(`segment matrix: ${c.key} user=${label} → ${c.expectedValue}`, () => {
      const overrides = createFlagOverridesFromConfig(c.config, OverrideBehaviour.LocalOnly);
      const def = typeof c.expectedValue === "boolean" ? false : c.expectedValue;
      const value = evaluateFullConfigOverrideSync(
        overrides,
        c.key,
        def,
        toUser(c.user),
        evaluator,
      );
      expect(value).toBe(c.expectedValue);
    });
  }
});
