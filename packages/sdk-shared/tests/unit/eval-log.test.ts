// SPDX-License-Identifier: MIT

/**
 * Evaluation-log trace — byte-identity proving slice (ADR 0003 / #495).
 *
 * Asserts the `EvaluateLogBuilder` + INFO emission wired into
 * `RolloutEvaluator.evaluate` reproduces ConfigCat's `evaluationlog/simple_value`
 * expected output BYTE-FOR-BYTE, read from the vendored upstream `.txt` oracle
 * (`packages/test-fixtures-sdk-parity/fixtures/upstream/evaluationlog/simple_value/`).
 *
 * The `.txt` lines carry ConfigCat's test-capture prefix `INFO: [5000] ` (its
 * uppercase level + event-id convention). Confeature's console logger formats
 * differently (`[INFO] [5000] …`), so this test reconstructs ConfigCat's capture
 * format from the (level, eventId, message) the SDK passes to `logger.info` —
 * exactly what the cross-SDK corpus mechanism (#496) will do.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { type IConfig, type ISettingValue, UserComparator } from "../../src/config-json.ts";
import { EvaluateLogBuilder } from "../../src/eval-log.ts";
import { RolloutEvaluator } from "../../src/evaluator.ts";
import { LoggerWrapper, LogLevel } from "../../src/logger.ts";
import { ProjectConfig } from "../../src/project-config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIMPLE_VALUE_DIR = resolve(
  HERE,
  "../../../test-fixtures-sdk-parity/fixtures/upstream/evaluationlog/simple_value",
);

function expectedTrace(file: string): string {
  // Strip at most one trailing newline (a file artifact) — the trace itself
  // carries no trailing newline (e.g. on_flag.txt is exactly 59 bytes).
  return readFileSync(resolve(SIMPLE_VALUE_DIR, file), "utf8").replace(/\n$/u, "");
}

/** A logger at INFO level that records every emitted (eventId, message). */
function makeCapturingEvaluator(): {
  evaluator: RolloutEvaluator;
  evalLog: () => string | undefined;
} {
  const calls: { eventId: string; message: string }[] = [];
  const logger = new LoggerWrapper({
    level: LogLevel.Info,
    eol: "\n",
    log: (_level, eventId, message) => {
      calls.push({ eventId: String(eventId), message: String(message) });
    },
  });
  return {
    evaluator: new RolloutEvaluator(logger),
    // Reconstruct ConfigCat's capture format for the 5000 (config-evaluated) line.
    evalLog: () => {
      const hit = calls.find((c) => c.eventId === "5000");
      return hit === undefined ? undefined : `INFO: [${hit.eventId}] ${hit.message}`;
    },
  };
}

function makeConfig(key: string, type: number, value: ISettingValue): ProjectConfig {
  const cfg: IConfig = {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f: { [key]: { t: type as IConfig["f"][string]["t"], v: value, i: "v0", r: [] } },
    s: [],
  };
  return new ProjectConfig(cfg, '"etag-1"', Date.now());
}

// One row per simple_value test in the upstream simple_value.json, mapped to
// its expected-output .txt. defaultValue is type-compatible; the served value
// is what resolves and what the trace reports.
const CASES: {
  key: string;
  type: number;
  value: ISettingValue;
  defaultValue: boolean | string | number;
  expected: string;
}[] = [
  {
    key: "boolDefaultFalse",
    type: 0,
    value: { b: false },
    defaultValue: true,
    expected: "off_flag.txt",
  },
  {
    key: "boolDefaultTrue",
    type: 0,
    value: { b: true },
    defaultValue: false,
    expected: "on_flag.txt",
  },
  {
    key: "stringDefaultCat",
    type: 1,
    value: { s: "Cat" },
    defaultValue: "Default",
    expected: "text_setting.txt",
  },
  {
    key: "integerDefaultOne",
    type: 2,
    value: { i: 1 },
    defaultValue: 0,
    expected: "int_setting.txt",
  },
  {
    key: "doubleDefaultPi",
    type: 3,
    value: { d: 3.1415 },
    defaultValue: 0,
    expected: "double_setting.txt",
  },
];

describe("eval-log: simple_value byte-identity (ADR 0003 / #495)", () => {
  for (const c of CASES) {
    test(`${c.key} → ${c.expected}`, () => {
      const { evaluator, evalLog } = makeCapturingEvaluator();
      const cfg = makeConfig(c.key, c.type, c.value);

      const details = evaluator.evaluate(cfg, c.key, c.defaultValue);
      // Sanity: the structured surface still resolves the served value
      // (the eval-log is additive — AC of #495).
      expect(details.isDefaultValue).toBe(false);

      expect(evalLog()).toBe(expectedTrace(c.expected));
    });
  }
});

describe("eval-log: condition formatting (ADR 0003 / #497)", () => {
  function rendered(condition: Parameters<EvaluateLogBuilder["appendUserCondition"]>[0]): string {
    return new EvaluateLogBuilder().appendUserCondition(condition).toString();
  }

  test("text list comparator → User.<attr> CONTAINS ANY OF ['…']", () => {
    expect(
      rendered({ a: "Email", c: UserComparator.TextContainsAnyOf, l: ["@configcat.com"] }),
    ).toBe("User.Email CONTAINS ANY OF ['@configcat.com']");
  });

  test("multi-item list joins with ', '", () => {
    expect(rendered({ a: "Country", c: UserComparator.TextIsOneOf, l: ["US", "CA"] })).toBe(
      "User.Country IS ONE OF ['US', 'CA']",
    );
  });

  test("list truncation past 10 items appends '… <N more values>'", () => {
    const items = Array.from({ length: 12 }, (_, i) => `v${i}`);
    expect(rendered({ a: "Email", c: UserComparator.TextIsOneOf, l: items })).toBe(
      "User.Email IS ONE OF ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', ... <2 more values>]",
    );
  });

  test("string EQUALS comparator → User.<attr> EQUALS '<value>'", () => {
    expect(rendered({ a: "Email", c: UserComparator.TextEquals, s: "a@b.com" })).toBe(
      "User.Email EQUALS 'a@b.com'",
    );
  });

  test("number comparator → User.<attr> > '<value>'", () => {
    expect(rendered({ a: "Age", c: UserComparator.NumberGreater, d: 18 })).toBe("User.Age > '18'");
  });

  test("sensitive list comparator → [<N hashed values>]", () => {
    expect(rendered({ a: "Email", c: UserComparator.SensitiveTextIsOneOf, l: ["h1", "h2"] })).toBe(
      "User.Email IS ONE OF [<2 hashed values>]",
    );
  });

  test("sensitive single hash → 1 hashed value (singular)", () => {
    expect(rendered({ a: "Email", c: UserComparator.SensitiveTextIsOneOf, l: ["h1"] })).toBe(
      "User.Email IS ONE OF [<1 hashed value>]",
    );
  });

  test("condition consequence: true / false", () => {
    expect(new EvaluateLogBuilder().appendConditionConsequence(true).toString()).toBe(" => true");
    expect(new EvaluateLogBuilder().appendConditionConsequence(false).toString()).toBe(
      " => false, skipping the remaining AND conditions",
    );
  });

  test("targeting-rule THEN consequence (newlined, indented) — match / no-match / error / % options", () => {
    expect(
      new EvaluateLogBuilder().appendTargetingRuleConsequence("Dog", true, true).toString(),
    ).toBe("\n  THEN 'Dog' => MATCH, applying rule");
    expect(
      new EvaluateLogBuilder().appendTargetingRuleConsequence("Dog", false, true).toString(),
    ).toBe("\n  THEN 'Dog' => no match");
    expect(
      new EvaluateLogBuilder()
        .appendTargetingRuleConsequence("Dog", "cannot evaluate, User Object is missing", true)
        .toString(),
    ).toBe("\n  THEN 'Dog' => cannot evaluate, User Object is missing");
    expect(
      new EvaluateLogBuilder().appendTargetingRuleConsequence(undefined, true, true).toString(),
    ).toBe("\n  THEN % options => MATCH, applying rule");
  });

  test("targeting-rule THEN consequence (same-line, newLine=false)", () => {
    expect(
      new EvaluateLogBuilder().appendTargetingRuleConsequence("Dog", true, false).toString(),
    ).toBe(" THEN 'Dog' => MATCH, applying rule");
  });

  test("no eval-log is emitted below INFO verbosity (lazy gating)", () => {
    const calls: string[] = [];
    const logger = new LoggerWrapper({
      level: LogLevel.Warn,
      eol: "\n",
      log: (_level, eventId) => calls.push(String(eventId)),
    });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig("boolDefaultTrue", 0, { b: true });
    evaluator.evaluate(cfg, "boolDefaultTrue", false);
    expect(calls).not.toContain("5000");
  });
});
