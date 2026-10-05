// SPDX-License-Identifier: MIT

/**
 * Drop-in parity test for typed (`string` / `int` / `double`) flag
 * evaluation — the `SettingType × value` extension corpus (#254).
 *
 * **Why a parallel proof, not a shared-mock side-by-side run.** As
 * documented at length in the sibling `parity-boolean.test.ts`:
 * `configcat-node@11` uses Node's `http`/`https` modules through its
 * built-in `HttpConfigFetcher`, NOT the global `fetch` API, and the
 * fetcher is not exposed as a public option. A single
 * `vi.stubGlobal("fetch", spy)` therefore cannot route bytes to both
 * `configcat-node` and `@confeature/sdk-node`. So — exactly as the
 * boolean matrix does — we run a parallel proof: `sdk-shared`'s
 * `RolloutEvaluator` (the evaluator every JS SDK delegates to, widened
 * to the four-type matrix by #253) evaluates the shared typed fixture
 * (`config-v6.typed.json`) and we assert each result against the typed
 * `expected` value `configcat-node`'s evaluator would emit.
 *
 * The typed corpus (`CORPUS_TYPED`) is consumed VERBATIM from
 * `@confeature/test-fixtures-sdk-parity` — no copy, no fork.
 */

import { describe, expect, test } from "vitest";

import {
  LoggerWrapper,
  NullLogger,
  ProjectConfig,
  RolloutEvaluator,
  type IConfig,
} from "@confeature/sdk-shared";
import { CORPUS_TYPED } from "@confeature/test-fixtures-sdk-parity";
import typedFixture from "@confeature/test-fixtures-sdk-parity/fixtures/config-v6.typed.json" with { type: "json" };

describe("Parity with configcat-node@11 (typed evaluation — #254)", () => {
  // The proof we CAN run: our evaluator returns the same typed values
  // the ConfigCat evaluator would, given a payload byte-equal to what
  // configcat-node receives from a ConfigCat CDN.
  //
  // TYPE_MISMATCH coverage: the 3 TYPE_MISMATCH tuples in `CORPUS_TYPED`
  // (default-value type ≠ setting type → falls back to the default) are
  // validated here at the evaluator level. The full `configcat-js`
  // side-by-side confirmation of those same tuples lives in the
  // browser-js / bun / deno parity tests, which run an actual two-client
  // run over this identical shared corpus — a side-by-side run sdk-node
  // cannot do because `configcat-node@11` fetches via `node:http`, not
  // `fetch` (the documented Node trade-off, see the file header above).
  test.each(CORPUS_TYPED)("[$configId] $description", ({ key, defaultValue, expected }) => {
    const cfg = new ProjectConfig(typedFixture as unknown as IConfig, '"parity-etag"', Date.now());
    const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));
    const value = evaluator.evaluate(cfg, key, defaultValue).value;
    expect(value).toBe(expected);
  });

  test("string / int / double settings resolve to their JS-native types", () => {
    const cfg = new ProjectConfig(typedFixture as unknown as IConfig, '"parity-etag"', Date.now());
    const evaluator = new RolloutEvaluator(new LoggerWrapper(new NullLogger()));

    // string → string
    expect(typeof evaluator.evaluate(cfg, "feature.welcome-text", "fallback").value).toBe("string");
    // int → number
    expect(typeof evaluator.evaluate(cfg, "feature.max-retries", -1).value).toBe("number");
    // double → number
    expect(typeof evaluator.evaluate(cfg, "feature.sample-rate", 1).value).toBe("number");
  });
});
