// SPDX-License-Identifier: MIT

/**
 * Export the in-TS parity corpus + canonical configs to JSON files that
 * non-TS SDKs (e.g. apps/sdk-python) can read without importing the TS
 * workspace.
 *
 * Generates:
 *   - fixtures/parity-corpus.json         (boolean 58-tuple corpus —
 *                                          every SDK runs this)
 *   - fixtures/parity-configs.json        (canonical configs for the
 *                                          boolean corpus)
 *   - fixtures/parity-corpus-typed.json   (typed SettingType × value
 *                                          extension corpus, spec 066 /
 *                                          #253 — SDKs opt in per
 *                                          #254-#261)
 *   - fixtures/parity-configs-typed.json  (canonical configs for the
 *                                          typed corpus)
 *
 * The boolean and typed corpora are kept in **separate** files so a
 * boolean-only SDK never has to parse a string / int / double tuple.
 *
 * Usage:
 *   pnpm run export:corpus          # write the JSON files
 *   pnpm run check:exports          # exit 1 if committed JSON drifts
 *                                   # from the live TS source (freshness gate)
 *
 * The script is intentionally tiny and dependency-free (no JSON Schema,
 * no diff lib) — `JSON.stringify(..., null, 2) + "\n"` is the wire
 * format, byte-comparison is the freshness check.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIGS, CONFIGS_RULES, CONFIGS_TYPED, type CanonicalConfig } from "../src/configs.ts";
import { CORPUS, CORPUS_RULES, CORPUS_TYPED, type ParityTuple } from "../src/fixtures.ts";
import { type EvalLogTuple, loadEvalLogScenario } from "../src/upstream-corpus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const CORPUS_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-corpus.json");
const CONFIGS_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-configs.json");
const CORPUS_TYPED_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-corpus-typed.json");
const CONFIGS_TYPED_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-configs-typed.json");
const CORPUS_RULES_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-corpus-rules.json");
const CONFIGS_RULES_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-configs-rules.json");
const EVALUATIONLOG_PATH = resolve(PACKAGE_ROOT, "fixtures", "parity-evaluationlog.json");

/**
 * Evaluation-log scenarios whose textual trace the shared engine reproduces
 * byte-identically TODAY (ADR 0003 / epic #494). The exported corpus + the
 * trace runners are gated on this allow-list, so it GROWS as the sibling
 * children land their part of the `EvaluateLogBuilder`:
 *   - #496 (here): `simple_value` — the no-rule header+footer.
 *   - #497: targeting rules · #498: prerequisite/circular-dep ·
 *     #499: attribute validation · #500: percentage-option placement.
 * Growth-tolerant (#458): appending a scenario never forces a count-guard bump.
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

/**
 * Encode a tuple's user for the JSON corpus under the typed-attribute encoding
 * (spec 151 / #468, FR-001). A `user.custom` attribute is encoded by its
 * NATURAL JSON type:
 *
 *   - string  → JSON string   (UNCHANGED — byte-identical to today)
 *   - number  → JSON number
 *   - boolean → JSON bool
 *   - string[]→ JSON array of strings
 *   - Date    → a TAGGED object `{"$date": <unix-epoch-seconds-number>}`
 *               (JSON has no date type; epoch SECONDS, fractional preserved —
 *               `getTime() / 1000`, exactly the value the evaluator's
 *               `userAttributeValueToString` produces).
 *   - non-finite number (NaN / ±Infinity) → a TAGGED object
 *               `{"$num": "NaN" | "Infinity" | "-Infinity"}` (#479). JSON has no
 *               representation for these: `JSON.stringify(NaN | Infinity |
 *               -Infinity)` all collapse to bare `null`, which would fuse three
 *               distinct special floats into one and is undecodable by a
 *               JSON-reading SDK. The string tag is exactly what the evaluator's
 *               `userAttributeValueToString` (`value + ""`) renders, so a runner
 *               decodes it back to its language special float. FINITE numbers
 *               stay natural JSON (byte-identical to #468).
 *
 * This is the contract the 14-SDK federation fan-out (US2) deserializes; it is
 * documented in this package's README. A STRING attribute serializes EXACTLY as
 * before (the 220 existing rule tuples + the boolean/typed corpora are all
 * string-attr-only, so they are byte-identical), keeping the byte-stability
 * gate green.
 */
function encodeUser(user: ParityTuple["user"]): unknown {
  if (!user) return null;
  const custom = user.custom as Record<string, unknown> | undefined;
  if (!custom) return user;
  const encodedCustom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(custom)) {
    // Date → the `{"$date": epoch-seconds}` tag; a non-finite number → the
    // `{"$num": "NaN"|"Infinity"|"-Infinity"}` tag (#479); every other type
    // (string / FINITE number / bool / string[]) is its natural JSON form.
    if (v instanceof Date) {
      encodedCustom[k] = { $date: v.getTime() / 1000 };
    } else if (typeof v === "number" && !Number.isFinite(v)) {
      encodedCustom[k] = { $num: Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity" };
    } else {
      encodedCustom[k] = v;
    }
  }
  return { ...user, custom: encodedCustom };
}

function serialiseCorpus(corpus: readonly ParityTuple[]): string {
  // Stable ordering: the corpus array order is fixed by build() in
  // fixtures.ts; we serialise as-is. Within each tuple, JSON.stringify
  // preserves the property-insertion order from the TS object literal.
  const out = corpus.map((tuple) => {
    // The base shape is byte-stable across every existing tuple. The optional
    // `expectedVariationId` (spec 150 / #395) is appended ONLY when present, so
    // value-only tuples serialize identically to before (byte-stability,
    // FR-004): the new key never appears on a tuple that does not set it.
    const base = {
      description: tuple.description,
      configId: tuple.configId,
      key: tuple.key,
      defaultValue: tuple.defaultValue,
      // Typed-attribute encoding (spec 151 / #468): a Date in `user.custom` is
      // tagged `{"$date": epoch-seconds}`; string attrs serialize unchanged.
      user: encodeUser(tuple.user),
      expected: tuple.expected,
    };
    return tuple.expectedVariationId === undefined
      ? base
      : { ...base, expectedVariationId: tuple.expectedVariationId };
  });
  return JSON.stringify(out, null, 2) + "\n";
}

function serialiseConfigs(configs: readonly CanonicalConfig[]): string {
  // Byte-stable shape for the existing boolean / typed config files (FR-006):
  // intentionally omits the new `injectionMode` field so parity-configs.json /
  // parity-configs-typed.json stay byte-identical. The map configs all carry
  // `overridesMap`, so its serialization is unchanged.
  const out = configs.map((cfg) => ({
    id: cfg.id,
    description: cfg.description,
    config: cfg.config,
    overridesMap: cfg.overridesMap,
  }));
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Serialiser for the rule-bearing config set (spec 135). Emits the new
 * `injectionMode` discriminator and OMITS `overridesMap` (full-config configs
 * have none) — a separate file (`parity-configs-rules.json`), so the existing
 * config files are untouched (FR-006).
 */
function serialiseRulesConfigs(configs: readonly CanonicalConfig[]): string {
  const out = configs.map((cfg) => ({
    id: cfg.id,
    description: cfg.description,
    injectionMode: cfg.injectionMode,
    config: cfg.config,
  }));
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Serialise the evaluation-log trace corpus (ADR 0003 / #496) for native
 * replay. Each case bundles the upstream config blob + the expected textual
 * trace; a runner injects the config, evaluates `key` (with `user`) at INFO
 * verbosity, and asserts its emitted trace byte-identical to `expectedTrace`.
 * Only scenarios on {@link TRACE_SCENARIOS} (the engine reproduces them today)
 * are exported, and only their tests that carry an `expectedLog`.
 */
function serialiseEvalLog(): string {
  const out = TRACE_SCENARIOS.flatMap((scenario) =>
    loadEvalLogScenario(scenario)
      .filter((t: EvalLogTuple) => t.expectedTrace !== undefined)
      .map((t: EvalLogTuple) => ({
        scenario: t.scenario,
        key: t.key,
        defaultValue: t.defaultValue,
        user: t.user ?? null,
        expectedValue: t.expectedValue,
        expectedTrace: t.expectedTrace,
        config: t.config,
      })),
  );
  return JSON.stringify(out, null, 2) + "\n";
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const corpusJson = serialiseCorpus(CORPUS);
  const configsJson = serialiseConfigs(CONFIGS);
  const corpusTypedJson = serialiseCorpus(CORPUS_TYPED);
  const configsTypedJson = serialiseConfigs(CONFIGS_TYPED);
  const corpusRulesJson = serialiseCorpus(CORPUS_RULES);
  const configsRulesJson = serialiseRulesConfigs(CONFIGS_RULES);
  const evalLogJson = serialiseEvalLog();

  if (checkMode) {
    let drift = false;
    for (const [path, expected] of [
      [CORPUS_PATH, corpusJson] as const,
      [CONFIGS_PATH, configsJson] as const,
      [CORPUS_TYPED_PATH, corpusTypedJson] as const,
      [CONFIGS_TYPED_PATH, configsTypedJson] as const,
      [CORPUS_RULES_PATH, corpusRulesJson] as const,
      [CONFIGS_RULES_PATH, configsRulesJson] as const,
      [EVALUATIONLOG_PATH, evalLogJson] as const,
    ]) {
      let actual: string;
      try {
        actual = readFileSync(path, "utf8");
      } catch (err) {
        console.error(`[export-corpus] missing committed JSON: ${path}`);
        console.error(`[export-corpus] underlying error: ${(err as Error).message}`);
        drift = true;
        continue;
      }
      if (actual !== expected) {
        console.error(`[export-corpus] DRIFT: ${path} differs from live TS source.`);
        console.error(`[export-corpus] regenerate with: pnpm run export:corpus`);
        drift = true;
      }
    }
    if (drift) {
      process.exit(1);
    }
    console.log("[export-corpus] OK — committed JSON matches live TS source.");
    return;
  }

  writeFileSync(CORPUS_PATH, corpusJson, "utf8");
  writeFileSync(CONFIGS_PATH, configsJson, "utf8");
  writeFileSync(CORPUS_TYPED_PATH, corpusTypedJson, "utf8");
  writeFileSync(CONFIGS_TYPED_PATH, configsTypedJson, "utf8");
  writeFileSync(CORPUS_RULES_PATH, corpusRulesJson, "utf8");
  writeFileSync(CONFIGS_RULES_PATH, configsRulesJson, "utf8");
  writeFileSync(EVALUATIONLOG_PATH, evalLogJson, "utf8");
  console.log(`[export-corpus] wrote ${CORPUS.length} tuples → ${CORPUS_PATH}`);
  console.log(`[export-corpus] wrote ${CONFIGS.length} configs → ${CONFIGS_PATH}`);
  console.log(`[export-corpus] wrote ${CORPUS_TYPED.length} typed tuples → ${CORPUS_TYPED_PATH}`);
  console.log(
    `[export-corpus] wrote ${CONFIGS_TYPED.length} typed configs → ${CONFIGS_TYPED_PATH}`,
  );
  console.log(`[export-corpus] wrote ${CORPUS_RULES.length} rule tuples → ${CORPUS_RULES_PATH}`);
  console.log(`[export-corpus] wrote ${CONFIGS_RULES.length} rule configs → ${CONFIGS_RULES_PATH}`);
  console.log(`[export-corpus] wrote eval-log trace cases → ${EVALUATIONLOG_PATH}`);
}

main();
