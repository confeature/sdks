// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";

import type { IConfig } from "../../src/config-json.ts";
import { RolloutEvaluator } from "../../src/evaluator.ts";
import { LoggerWrapper, NullLogger } from "../../src/logger.ts";
import { ProjectConfig } from "../../src/project-config.ts";

function makeConfig(f: IConfig["f"]): ProjectConfig {
  const cfg: IConfig = {
    p: { u: "https://cdn.confeature.io", r: 0, s: "v1" },
    f,
    s: [],
  };
  return new ProjectConfig(cfg, '"etag-1"', Date.now());
}

function emptyConfig(): ProjectConfig {
  return ProjectConfig.empty();
}

function makeEvaluator(): { evaluator: RolloutEvaluator; logger: LoggerWrapper } {
  const logger = new LoggerWrapper(new NullLogger());
  return { evaluator: new RolloutEvaluator(logger), logger };
}

describe("RolloutEvaluator (typed, fail-closed)", () => {
  test("returns the cached value when key present and types match", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.x", false);
    expect(details.value).toBe(true);
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("vx");
  });

  test("returns false (cached) when key present and value is false", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.y": { t: 0, v: { b: false }, i: "vy", r: [] },
    });
    expect(evaluator.evaluate(cfg, "feature.y", true).value).toBe(false);
  });

  test("returns default + logs KEY_NOT_FOUND when key missing", () => {
    const sink = vi.fn();
    const logger = new LoggerWrapper({ level: 4, eol: "\n", log: sink });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig({});
    const details = evaluator.evaluate(cfg, "feature.missing", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
    expect(sink).toHaveBeenCalled();
    const eventIds = sink.mock.calls.map((c) => String(c[1]));
    expect(eventIds).toContain("KEY_NOT_FOUND");
  });

  test("resolves a non-boolean setting type to its typed value", () => {
    // Post-#253: a string setting (t: 1) with a string default resolves
    // to its string — it is no longer rejected as a TYPE_MISMATCH.
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.string": { t: 1, v: { s: "hello" }, i: "vs", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.string", "fallback");
    expect(details.value).toBe("hello");
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("vs");
  });

  test("returns default + logs TYPE_MISMATCH when default type disagrees with the setting type", () => {
    // The TYPE_MISMATCH discipline is preserved for every type: a boolean
    // default against a t: 1 string setting still fails closed.
    const sink = vi.fn();
    const logger = new LoggerWrapper({ level: 2, eol: "\n", log: sink });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig({
      "feature.string": { t: 1, v: { s: "hello" }, i: "vs", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.string", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
    expect(sink.mock.calls.some((c) => String(c[1]) === "TYPE_MISMATCH")).toBe(true);
  });

  test("returns default + logs TYPE_MISMATCH when default value type disagrees (boolean setting)", () => {
    const sink = vi.fn();
    const logger = new LoggerWrapper({ level: 2, eol: "\n", log: sink });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig({
      "feature.bool": { t: 0, v: { b: true }, i: "vb", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.bool", "string-default");
    expect(details.value).toBe("string-default");
    expect(details.isDefaultValue).toBe(true);
    expect(sink.mock.calls.some((c) => String(c[1]) === "TYPE_MISMATCH")).toBe(true);
  });

  test("returns default + logs TYPE_MISMATCH when default value type disagrees (int setting)", () => {
    const sink = vi.fn();
    const logger = new LoggerWrapper({ level: 2, eol: "\n", log: sink });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig({
      "feature.int": { t: 2, v: { i: 42 }, i: "vi", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.int", "string-default");
    expect(details.value).toBe("string-default");
    expect(details.isDefaultValue).toBe(true);
    expect(sink.mock.calls.some((c) => String(c[1]) === "TYPE_MISMATCH")).toBe(true);
  });

  test("returns default + logs TYPE_MISMATCH when default value type disagrees (double setting)", () => {
    const sink = vi.fn();
    const logger = new LoggerWrapper({ level: 2, eol: "\n", log: sink });
    const evaluator = new RolloutEvaluator(logger);
    const cfg = makeConfig({
      "feature.double": { t: 3, v: { d: 3.14 }, i: "vd", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.double", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
    expect(sink.mock.calls.some((c) => String(c[1]) === "TYPE_MISMATCH")).toBe(true);
  });

  test("returns default when v.b is null / undefined", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.null": { t: 0, v: {}, i: "vn", r: [] },
    });
    expect(evaluator.evaluate(cfg, "feature.null", true).value).toBe(true);
    expect(evaluator.evaluate(cfg, "feature.null", false).value).toBe(false);
  });

  test("returns default when called on an empty (cold-start) config", () => {
    const { evaluator } = makeEvaluator();
    const details = evaluator.evaluate(emptyConfig(), "feature.x", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
  });

  test("never throws — pathological inputs all return default", () => {
    const { evaluator } = makeEvaluator();
    const broken = {
      configJson: null,
      eTag: null,
      fetchTime: 0,
      get settings(): never {
        throw new Error("boom");
      },
    } as unknown as ProjectConfig;
    expect(() => evaluator.evaluate(broken, "feature.x", false)).not.toThrow();
    const details = evaluator.evaluate(broken, "feature.x", false);
    expect(details.value).toBe(false);
    expect(details.isDefaultValue).toBe(true);
  });

  test("evaluateValue returns the same value as evaluate(...).value", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.x": { t: 0, v: { b: true }, i: "vx", r: [] },
    });
    expect(evaluator.evaluateValue(cfg, "feature.x", false)).toBe(true);
    expect(evaluator.evaluateValue(cfg, "feature.absent", true)).toBe(true);
  });

  // ---- Typed evaluation: string / int / double settings (#253) ----

  test("resolves a string setting (t: 1) to its v.s string", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.greeting": { t: 1, v: { s: "hello" }, i: "vg", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.greeting", "fallback");
    expect(details.value).toBe("hello");
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("vg");
  });

  test("resolves an int setting (t: 2) to its v.i number", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.max-items": { t: 2, v: { i: 42 }, i: "vm", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.max-items", 0);
    expect(details.value).toBe(42);
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("vm");
  });

  test("resolves a double setting (t: 3) to its v.d number", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.ratio": { t: 3, v: { d: 3.14 }, i: "vr", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.ratio", 0);
    expect(details.value).toBe(3.14);
    expect(details.isDefaultValue).toBe(false);
    expect(details.variationId).toBe("vr");
  });

  test("resolves a config carrying all four SettingTypes correctly", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "f.bool": { t: 0, v: { b: true }, i: "vb", r: [] },
      "f.string": { t: 1, v: { s: "world" }, i: "vs", r: [] },
      "f.int": { t: 2, v: { i: 7 }, i: "vi", r: [] },
      "f.double": { t: 3, v: { d: -1.5 }, i: "vd", r: [] },
    });
    expect(evaluator.evaluate(cfg, "f.bool", false).value).toBe(true);
    expect(evaluator.evaluate(cfg, "f.string", "x").value).toBe("world");
    expect(evaluator.evaluate(cfg, "f.int", 0).value).toBe(7);
    expect(evaluator.evaluate(cfg, "f.double", 0).value).toBe(-1.5);
  });

  test("an empty-string string value is a real value, not missing", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.empty": { t: 1, v: { s: "" }, i: "ve", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.empty", "fallback");
    expect(details.value).toBe("");
    expect(details.isDefaultValue).toBe(false);
  });

  test("a zero int / double value is a real value, not missing", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.zero-int": { t: 2, v: { i: 0 }, i: "vzi", r: [] },
      "feature.zero-double": { t: 3, v: { d: 0 }, i: "vzd", r: [] },
    });
    const intDetails = evaluator.evaluate(cfg, "feature.zero-int", 99);
    expect(intDetails.value).toBe(0);
    expect(intDetails.isDefaultValue).toBe(false);
    const doubleDetails = evaluator.evaluate(cfg, "feature.zero-double", 99);
    expect(doubleDetails.value).toBe(0);
    expect(doubleDetails.isDefaultValue).toBe(false);
  });

  test("returns default when a typed setting has an empty v envelope", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.no-string": { t: 1, v: {}, i: "vns", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.no-string", "fallback");
    expect(details.value).toBe("fallback");
    expect(details.isDefaultValue).toBe(true);
  });

  test("a null default bypasses the type check and resolves the typed value", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "feature.greeting": { t: 1, v: { s: "hello" }, i: "vg", r: [] },
    });
    const details = evaluator.evaluate(cfg, "feature.greeting", null);
    expect(details.value).toBe("hello");
    expect(details.isDefaultValue).toBe(false);
  });

  test("evaluateValue / evaluateSnapshot return the same typed values as evaluate", () => {
    const { evaluator } = makeEvaluator();
    const cfg = makeConfig({
      "f.string": { t: 1, v: { s: "world" }, i: "vs", r: [] },
      "f.int": { t: 2, v: { i: 7 }, i: "vi", r: [] },
      "f.double": { t: 3, v: { d: 3.14 }, i: "vd", r: [] },
    });
    expect(evaluator.evaluateValue(cfg, "f.string", "x")).toBe("world");
    expect(evaluator.evaluateValue(cfg, "f.int", 0)).toBe(7);
    expect(evaluator.evaluateValue(cfg, "f.double", 0)).toBe(3.14);
    expect(evaluator.evaluateSnapshot(cfg, "f.string", "x")).toBe("world");
    expect(evaluator.evaluateSnapshot(cfg, "f.int", 0)).toBe(7);
    expect(evaluator.evaluateSnapshot(cfg, "f.double", 0)).toBe(3.14);
  });
});
