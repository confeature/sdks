// SPDX-License-Identifier: MIT

/**
 * ConfigCat conformance: replays the vendored upstream evaluation matrix
 * (the `@confeature/test-fixtures-sdk-parity` corpus, anchor
 * `configcat/go-sdk@08c4882` v9) against the reference `RolloutEvaluator` and
 * asserts byte-identical parity (SC-001). The corpus loaders are imported via a
 * relative path (`../../test-fixtures-sdk-parity/src`), NOT the package name, to
 * keep the workspace dependency graph acyclic — sdk-shared must not declare a
 * devDependency on test-fixtures-sdk-parity (which depends back on sdk-shared),
 * else `vp run -r test` cycles and the deploy gate fails (#417). This mirrors
 * how the other federated SDKs read the vendored corpus by path.
 *
 * Scope = the full conformance surface: the P1 decision-engine core (US1
 * targeting rules, US2 the 36 comparators, US3 percentage rollout) PLUS US4
 * (segments, prerequisite flags incl. multilevel + circular detection,
 * AND-groups / OR-as-multiple-rules) and US5 (attribute conversion / trimming,
 * comparison-value trimming, typed-attribute validation outcomes, and
 * variationId + matched-rule/option detail).
 *
 * The corpus is the oracle: each `(config, key, user) → expected` tuple is
 * checked against `evaluate(...).value` (and `.variationId` for the
 * variation-id matrix). Eval-log targeting/percentage/segment/prerequisite
 * scenarios additionally assert matched-rule / matched-option identity where
 * the served value pins it (FR-017). A determinism case proves percentage
 * bucketing is repeat-invariant (FR-005); a dedicated circular-dependency case
 * proves bounded termination with fallback + error (SC-004).
 */

import { describe, expect, it } from "vitest";

import {
  type ComparisonDriverCase,
  type CorpusUser,
  type EvalLogTuple,
  loadAttributeConversionDriver,
  loadAttributeTrimmingDriver,
  loadEvalLogScenario,
  loadMatrix,
  loadValueTrimmingDriver,
  type MatrixTuple,
} from "../../test-fixtures-sdk-parity/src/index.ts";

import { LoggerWrapper, LogLevel, NullLogger } from "../src/logger.ts";
import { ProjectConfig } from "../src/project-config.ts";
import { RolloutEvaluator } from "../src/evaluator.ts";
import { User } from "../src/user.ts";

const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));

function toUser(u: CorpusUser | undefined): User | undefined {
  if (!u) return undefined;
  return new User(u.identifier ?? "", u.email, u.country, u.custom ?? {});
}

function makeConfig(tuple: { config: unknown }): ProjectConfig {
  // The corpus carries a parsed config_v6 (`IConfig`) blob; wrap it in a
  // ProjectConfig the evaluator consumes. fetchTime is irrelevant to the
  // value/identity assertions.
  return new ProjectConfig(tuple.config as ProjectConfig["configJson"], "etag", Date.now());
}

/** Default value matching the expected primitive's JS type (TYPE_MISMATCH-safe). */
function defaultFor(expected: boolean | number | string): boolean | number | string {
  return typeof expected === "boolean" ? false : typeof expected === "number" ? 0 : "__default__";
}

// ---------------------------------------------------------------------------
// US2 — comparator families (+ US1/US3 value matrices)
// ---------------------------------------------------------------------------

/**
 * Matrices that exercise only user-condition comparators + percentage +
 * served values — i.e. the P1 surface. `testmatrix_and_or` is excluded
 * (segments + prerequisites = US4); `testmatrix_segments*` /
 * `testmatrix_prerequisite_flag` are US4.
 */
const VALUE_MATRICES = [
  "testmatrix.csv",
  "testmatrix_comparators_v6.csv",
  "testmatrix_semantic.csv",
  "testmatrix_semantic_2.csv",
  "testmatrix_number.csv",
  "testmatrix_sensitive.csv",
  "testmatrix_unicode.csv",
] as const;

function assertMatrixTuple(t: MatrixTuple): void {
  const config = makeConfig(t);
  const user = toUser(t.user);
  if (t.kind === "variation") {
    const details = evaluator.evaluate(config, t.key, null, user);
    expect(details.variationId, `${t.matrix} ${t.key} user=${JSON.stringify(t.user)}`).toBe(
      t.expected,
    );
  } else {
    const details = evaluator.evaluate(config, t.key, defaultFor(t.expected), user);
    expect(details.value, `${t.matrix} ${t.key} user=${JSON.stringify(t.user)}`).toBe(t.expected);
  }
}

describe("upstream parity — comparator + value matrices (US1/US2/US3)", () => {
  for (const matrix of VALUE_MATRICES) {
    const tuples = loadMatrix(matrix);
    it(`${matrix} (${tuples.length} cells)`, () => {
      for (const t of tuples) assertMatrixTuple(t);
    });
  }
});

// ---------------------------------------------------------------------------
// US1 — targeting-rule evaluation-log scenarios
// ---------------------------------------------------------------------------

function assertEvalLogValue(t: EvalLogTuple): void {
  const config = makeConfig(t);
  const user = toUser(t.user);
  const def = t.defaultValue ?? defaultFor(t.expectedValue);
  const details = evaluator.evaluate(config, t.key, def, user);
  expect(details.value, `${t.scenario} ${t.key} user=${JSON.stringify(t.user)}`).toBe(
    t.expectedValue,
  );
}

describe("upstream parity — targeting-rule eval-log scenarios (US1)", () => {
  for (const scenario of ["1_targeting_rule", "2_targeting_rules", "simple_value"]) {
    it(`evaluationlog/${scenario}`, () => {
      for (const t of loadEvalLogScenario(scenario)) assertEvalLogValue(t);
    });
  }

  it("a matched targeting rule is reported (matchedTargetingRule identity)", () => {
    // The 4th case of 1_targeting_rule matches the rule (Email ends @configcat.com → Dog).
    const cases = loadEvalLogScenario("1_targeting_rule");
    const matching = cases.find((c) => c.expectedValue === "Dog");
    expect(matching).toBeDefined();
    const config = makeConfig(matching as EvalLogTuple);
    const details = evaluator.evaluate(
      config,
      (matching as EvalLogTuple).key,
      "default",
      toUser((matching as EvalLogTuple).user),
    );
    expect(details.value).toBe("Dog");
    expect(details.matchedTargetingRule).toBeDefined();
    // The served value's variation id is surfaced (FR-011).
    expect(details.variationId).toBe("d0cd8f06");
    expect(details.matchedPercentageOption).toBeUndefined();
  });

  it("no user → served fallback + missing-user errorMessage, no throw (FR-016)", () => {
    const noUser = loadEvalLogScenario("1_targeting_rule").find((c) => c.user === undefined);
    expect(noUser).toBeDefined();
    const config = makeConfig(noUser as EvalLogTuple);
    const details = evaluator.evaluate(config, (noUser as EvalLogTuple).key, "default", undefined);
    expect(details.value).toBe("Cat"); // fallback
    expect(details.isDefaultValue).toBe(false);
    expect(details.errorMessage).toContain("User Object is missing");
    expect(details.matchedTargetingRule).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Evaluation-log TRACE fidelity (ADR 0003 / #496)
// ---------------------------------------------------------------------------

/**
 * Scenarios whose byte-identical textual trace the shared `EvaluateLogBuilder`
 * reproduces TODAY. Scoped to `simple_value` (the no-rule header+footer);
 * grows as the sibling children land the rule/condition/%-option/prerequisite
 * middle (#497–#500). Mirrors `TRACE_SCENARIOS` in `scripts/export-corpus.ts`.
 */
const TRACE_SCENARIOS = [
  "simple_value",
  "1_targeting_rule",
  "2_targeting_rules",
  "and_rules",
  "options_based_on_user_id",
  "options_based_on_custom_attr",
  "options_after_targeting_rule",
  "options_within_targeting_rule",
  "list_truncation",
  "number_validation",
  "circular_dep",
  "prerequisite_flag",
  "semver_validation",
  "epoch_date_validation",
] as const;

/** Map a numeric LogLevel to ConfigCat's uppercase capture label. */
const LEVEL_LABEL: Record<number, string> = {
  [LogLevel.Error]: "ERROR",
  [LogLevel.Warn]: "WARN",
  [LogLevel.Info]: "INFO",
  [LogLevel.Debug]: "DEBUG",
};

/**
 * Assert one tuple's emitted INFO trace is byte-identical to the vendored
 * upstream `.txt` (carried on `EvalLogTuple.expectedTrace`). Reconstructs
 * ConfigCat's test-capture format (`INFO: [<eventId>] <message>`) from the
 * (eventId, message) the engine passes to `logger.info` — exactly what the
 * native runners (#501) replay against `parity-evaluationlog.json`.
 */
function assertEvalLogTrace(t: EvalLogTuple): void {
  if (t.expectedTrace === undefined) return;
  const calls: { level: number; eventId: string; message: string }[] = [];
  const traceEvaluator = new RolloutEvaluator(
    new LoggerWrapper({
      level: LogLevel.Info,
      eol: "\n",
      log: (level, eventId, message) =>
        calls.push({ level, eventId: String(eventId), message: String(message) }),
    }),
  );
  const user = toUser(t.user);
  const def = t.defaultValue ?? defaultFor(t.expectedValue);
  traceEvaluator.evaluate(makeConfig(t), t.key, def, user);
  // Reconstruct ConfigCat's multi-line capture: every emitted log line
  // (WARN 3001/3003 emitted DURING the walk, then the INFO 5000 trace) formatted
  // `LEVEL: [eventId] message` and joined. `t.expectedTrace` is already in the
  // Confeature-canonical form (the loader transforms the go-sdk oracle), so this
  // is the same byte-string the native runners (#501) replay.
  const actual = calls
    .map((c) => `${LEVEL_LABEL[c.level] ?? "?"}: [${c.eventId}] ${c.message}`)
    .join("\n");
  expect(actual, `${t.scenario}/${t.key}`).toBe(t.expectedTrace);
}

describe("upstream parity — evaluation-log TRACE fidelity (ADR 0003 / #496, #497)", () => {
  for (const scenario of TRACE_SCENARIOS) {
    it(`evaluationlog/${scenario} trace`, () => {
      const tuples = loadEvalLogScenario(scenario).filter((t) => t.expectedTrace !== undefined);
      expect(tuples.length).toBeGreaterThan(0);
      for (const t of tuples) assertEvalLogTrace(t);
    });
  }
});

// ---------------------------------------------------------------------------
// US3 — percentage rollout
// ---------------------------------------------------------------------------

describe("upstream parity — percentage rollout (US3)", () => {
  for (const scenario of [
    "options_based_on_user_id",
    "options_based_on_custom_attr",
    "options_after_targeting_rule",
    "options_within_targeting_rule",
  ]) {
    it(`evaluationlog/${scenario}`, () => {
      for (const t of loadEvalLogScenario(scenario)) assertEvalLogValue(t);
    });
  }

  it("percentage bucketing is deterministic (repeat-invariant, FR-005)", () => {
    const cases = loadEvalLogScenario("options_based_on_user_id");
    const withUser = cases.find((c) => c.user !== undefined);
    expect(withUser).toBeDefined();
    const t = withUser as EvalLogTuple;
    const config = makeConfig(t);
    const user = toUser(t.user);
    const first = evaluator.evaluate(config, t.key, "default", user);
    for (let i = 0; i < 20; i++) {
      const again = evaluator.evaluate(config, t.key, "default", user);
      expect(again.value).toBe(first.value);
      expect(again.variationId).toBe(first.variationId);
    }
    expect(first.value).toBe(t.expectedValue);
    // A matched percentage option is reported when % options decide the value.
    expect(first.matchedPercentageOption).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// US4 — segments, prerequisite flags, AND/OR groups (matrices)
// ---------------------------------------------------------------------------

/**
 * Composite-targeting matrices: AND/OR groups, segments (v6 + legacy v5), and
 * prerequisite-flag chains. `testmatrix_and_or` proves AND = conditions-in-a-
 * rule and OR = multiple-rules; `testmatrix_segments*` prove segment IS-IN /
 * IS-NOT-IN (v6 + v5 shapes); `testmatrix_prerequisite_flag` proves the
 * prerequisite chain (incl. multilevel) resolves byte-identically.
 */
const US4_MATRICES = [
  "testmatrix_and_or.csv",
  "testmatrix_segments.csv",
  "testmatrix_segments_old.csv",
  "testmatrix_prerequisite_flag.csv",
] as const;

describe("upstream parity — segments / prerequisites / AND-OR matrices (US4)", () => {
  for (const matrix of US4_MATRICES) {
    const tuples = loadMatrix(matrix);
    it(`${matrix} (${tuples.length} cells)`, () => {
      for (const t of tuples) assertMatrixTuple(t);
    });
  }
});

// ---------------------------------------------------------------------------
// US4 — segment / prerequisite / AND-group eval-log scenarios
// ---------------------------------------------------------------------------

/**
 * `dependentFeatureMultipleLevels` (in `evaluationlog/prerequisite_flag`) was
 * the ONE corpus case whose config blob ConfigCat never published under any
 * sdkKey — the upstream suite descriptor lists every case under a single
 * `sdkKey`, but the multilevel chain (`dependentFeatureMultipleLevels` →
 * `intermediateFeature` → `mainFeatureWithoutUserCondition`) was missing two of
 * its three settings from the vendored `content-by-key.json`. The two upper
 * settings are now RECONSTRUCTED faithfully from the authoritative eval-log
 * trace (`prerequisite_flag_multilevel.txt`) and shallow-merged onto the
 * verbatim config at load time (see `_reconstructed/` + PROVENANCE.md; the leaf
 * `mainFeatureWithoutUserCondition` was already present verbatim). The case
 * therefore asserts directly now — there are no remaining unvendored keys. The
 * reconstructed-chain unit test below keeps the engine's A → B → C recursion
 * pinned independently of the corpus loader.
 */
const UNVENDORED_EVAL_LOG_KEYS = new Set<string>([]);

describe("upstream parity — segment / prerequisite / AND eval-log scenarios (US4)", () => {
  for (const scenario of ["segment", "prerequisite_flag", "and_rules"]) {
    it(`evaluationlog/${scenario}`, () => {
      for (const t of loadEvalLogScenario(scenario)) {
        if (UNVENDORED_EVAL_LOG_KEYS.has(t.key)) continue;
        assertEvalLogValue(t);
      }
    });
  }

  it("multilevel prerequisite resolves through a reconstructed chain (Dog)", () => {
    // Reconstructed from evaluationlog/prerequisite_flag/prerequisite_flag_
    // multilevel.txt — the same chain the corpus loader now merges in (see
    // _reconstructed/prerequisite_flag_multilevel.json). Kept as a standalone
    // unit test so the engine's A → B → C recursion stays pinned even if the
    // corpus loader changes. Proves the engine recurses A → B → C correctly.
    const config = {
      p: { u: "", r: 0, s: "salt" },
      s: [],
      f: {
        mainFeatureWithoutUserCondition: { t: 0, v: { b: true }, i: "main", r: [] },
        intermediateFeature: {
          t: 0,
          v: { b: false },
          i: "inter",
          r: [
            {
              c: [
                { p: { f: "mainFeatureWithoutUserCondition", c: 0, v: { b: true } } },
                { p: { f: "mainFeatureWithoutUserCondition", c: 0, v: { b: true } } },
              ],
              s: { v: { b: true }, i: "interT" },
            },
          ],
        },
        dependentFeatureMultipleLevels: {
          t: 1,
          v: { s: "Cat" },
          i: "dep",
          r: [
            {
              c: [{ p: { f: "intermediateFeature", c: 0, v: { b: true } } }],
              s: { v: { s: "Dog" }, i: "depDog" },
            },
          ],
        },
      },
    };
    const details = evaluator.evaluate(
      new ProjectConfig(config as unknown as ProjectConfig["configJson"], "etag", Date.now()),
      "dependentFeatureMultipleLevels",
      "default",
      undefined,
    );
    expect(details.value).toBe("Dog");
    expect(details.matchedTargetingRule).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// US4 — circular-dependency termination (SC-004)
// ---------------------------------------------------------------------------

describe("upstream parity — circular prerequisite detection (US4, SC-004)", () => {
  it("evaluationlog/circular_dep — every cycle returns fallback + error, bounded", () => {
    for (const t of loadEvalLogScenario("circular_dep")) {
      const config = makeConfig(t);
      const start = Date.now();
      const details = evaluator.evaluate(config, t.key, "default", toUser(t.user));
      // Bounded: a cycle must NOT hang — this whole evaluation returns fast.
      expect(Date.now() - start).toBeLessThan(1000);
      // Fallback value (the upstream returnValue for every cycle case is "default").
      expect(details.value, `${t.key}`).toBe(t.expectedValue);
      expect(details.value).toBe("default");
      // Fail-closed: the cycle throw is caught and surfaced as the default.
      expect(details.isDefaultValue).toBe(true);
      expect(details.errorMessage).toBeDefined();
    }
  });

  it("a direct 2-flag cycle (A↔B) terminates with fallback + error", () => {
    const config = {
      p: { u: "", r: 0, s: "salt" },
      s: [],
      f: {
        flagA: {
          t: 1,
          v: { s: "A" },
          i: "a",
          r: [{ c: [{ p: { f: "flagB", c: 0, v: { b: true } } }], s: { v: { s: "AA" }, i: "aa" } }],
        },
        flagB: {
          t: 1,
          v: { s: "B" },
          i: "b",
          r: [{ c: [{ p: { f: "flagA", c: 0, v: { b: true } } }], s: { v: { s: "BB" }, i: "bb" } }],
        },
      },
    };
    const cfg = new ProjectConfig(
      config as unknown as ProjectConfig["configJson"],
      "etag",
      Date.now(),
    );
    const details = evaluator.evaluate(cfg, "flagA", "default", undefined);
    expect(details.value).toBe("default");
    expect(details.isDefaultValue).toBe(true);
    expect(details.errorMessage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// US5 — normalization / conversion / trimming (comparison_*.json drivers)
// ---------------------------------------------------------------------------

function assertComparisonDriver(c: ComparisonDriverCase): void {
  const user = new User(
    c.identifier,
    undefined,
    c.country,
    c.custom as Record<string, string | number | boolean | readonly string[] | Date>,
  );
  const details = evaluator.evaluate(
    new ProjectConfig(c.config as unknown as ProjectConfig["configJson"], "etag", Date.now()),
    c.key,
    "default",
    user,
  );
  expect(details.value, `${c.fixture} ${c.key} custom=${JSON.stringify(c.custom)}`).toBe(
    c.expected,
  );
}

describe("upstream parity — attribute conversion / trimming (US5, FR-009)", () => {
  it("comparison_attribute_conversion (typed Custom1 → canonical string)", () => {
    for (const c of loadAttributeConversionDriver()) assertComparisonDriver(c);
  });
  it("comparison_attribute_trimming (user-attribute trimming, per-comparator)", () => {
    for (const c of loadAttributeTrimmingDriver()) assertComparisonDriver(c);
  });
  it("comparison_value_trimming (config-side comparison-value trimming)", () => {
    for (const c of loadValueTrimmingDriver()) assertComparisonDriver(c);
  });
});

// ---------------------------------------------------------------------------
// US5 — typed-attribute validation outcomes (FR-010) + list truncation
// ---------------------------------------------------------------------------

describe("upstream parity — validation outcomes (US5, FR-010)", () => {
  // A bad semver / number / epoch-date attribute → rule no-match + error,
  // never a false match: the served fallback is returned, not the rule value.
  for (const scenario of [
    "semver_validation",
    "number_validation",
    "epoch_date_validation",
    "list_truncation",
  ]) {
    it(`evaluationlog/${scenario}`, () => {
      for (const t of loadEvalLogScenario(scenario)) assertEvalLogValue(t);
    });
  }
});

// ---------------------------------------------------------------------------
// US5 — variationId + matched rule/option detail (FR-011) + unicode
// ---------------------------------------------------------------------------

describe("upstream parity — variationId + matched detail (US5, FR-011)", () => {
  it("testmatrix_variationId.csv (variation-id parity)", () => {
    for (const t of loadMatrix("testmatrix_variationId.csv")) assertMatrixTuple(t);
  });

  it("a segment-matched flag reports value + variationId from the served rule", () => {
    // segment_matching: featureWithSegmentTargeting, jane@example.com → true.
    const cases = loadEvalLogScenario("segment");
    const match = cases.find(
      (c) => c.key === "featureWithSegmentTargeting" && c.user !== undefined,
    );
    expect(match).toBeDefined();
    const t = match as EvalLogTuple;
    const details = evaluator.evaluate(makeConfig(t), t.key, false, toUser(t.user));
    expect(details.value).toBe(true);
    expect(details.matchedTargetingRule).toBeDefined();
    expect(details.variationId).toBeDefined();
  });
});
