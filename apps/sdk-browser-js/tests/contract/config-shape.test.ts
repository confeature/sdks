// SPDX-License-Identifier: MIT

/**
 * Contract tier — asserts the SDK can consume the wire shape that
 * `packages/contract` publishes (the `config_v6.json` payload served
 * by `cdn.confeature.io`) without runtime drift.
 *
 * The TS compile-time check (`satisfies IConfig`) catches structural
 * drift; the runtime determinism assertion catches eval drift.
 *
 * If `packages/contract` changes the wire shape and this tier still
 * passes, that means the SDK silently absorbed the new shape — flag
 * it for review.
 */

import { describe, expect, test } from "vitest";

import canonicalBooleanFixture from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.boolean.json" with { type: "json" };
import {
  type IConfig,
  isConfigShape,
  LoggerWrapper,
  NullLogger,
  ProjectConfig,
  RolloutEvaluator,
} from "@confeature/sdk-shared";

const canonicalBooleanConfig = canonicalBooleanFixture as IConfig;

describe("Contract: config_v6.json shape (FR-020, FR-021)", () => {
  test("the canonical fixture satisfies IConfig (compile-time check)", () => {
    // The `as IConfig` cast above already exercises the type at compile
    // time. The runtime guard `isConfigShape` is the parser's first
    // line of defence — if it rejects the canonical fixture, the wire
    // shape has drifted.
    expect(isConfigShape(canonicalBooleanFixture)).toBe(true);
  });

  test("the canonical fixture has the documented top-level keys", () => {
    expect(canonicalBooleanFixture).toHaveProperty("f"); // feature flags map
    // `p` (preferences) is optional in the wire shape; presence is fine.
  });

  test("evaluator output is deterministic for the canonical fixture", () => {
    const cfg = new ProjectConfig(canonicalBooleanConfig, '"e1"', 1_700_000_000_000);
    const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));

    // Run the same evaluation 100× → must return the same value each
    // time, given identical inputs.
    const first = evaluator.evaluate(cfg, "feature.dark-mode", false).value;
    for (let i = 0; i < 100; i++) {
      const next = evaluator.evaluate(cfg, "feature.dark-mode", false).value;
      expect(next).toBe(first);
    }
  });

  test("evaluator returns TYPE_MISMATCH default for non-boolean defaults against boolean payload", () => {
    const cfg = new ProjectConfig(canonicalBooleanConfig, '"e1"', 1_700_000_000_000);
    const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));
    expect(evaluator.evaluate(cfg, "feature.dark-mode", "string-default").value).toBe(
      "string-default",
    );
    expect(evaluator.evaluate(cfg, "feature.dark-mode", 42).value).toBe(42);
  });

  test("evaluator returns default for missing keys", () => {
    const cfg = new ProjectConfig(canonicalBooleanConfig, '"e1"', 1_700_000_000_000);
    const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));
    expect(evaluator.evaluate(cfg, "feature.does-not-exist", false).value).toBe(false);
    expect(evaluator.evaluate(cfg, "feature.does-not-exist", true).value).toBe(true);
  });
});
