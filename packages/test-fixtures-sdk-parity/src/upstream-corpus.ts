// SPDX-License-Identifier: MIT

/**
 * Loaders that turn ConfigCat's **vendored upstream evaluation matrix**
 * (`fixtures/upstream/`, anchor `configcat/go-sdk@08c4882` v9 — see
 * `fixtures/upstream/PROVENANCE.md`) into typed tuples the reference
 * evaluator + every per-SDK parity suite replays (research.md §R7,
 * `contracts/corpus-harness.md`).
 *
 * Three upstream forms, three tuple shapes:
 *
 *   1. `testmatrix*.csv` → {@link MatrixTuple} — each (data-row × flag-key
 *      column) cell is one `{ config, key, user, expected }` case.
 *   2. `evaluationlog/<scenario>.json` → {@link EvalLogTuple} — the
 *      scenario's `tests[]`, each carrying `{ config, key, user,
 *      expectedValue }` (+ optional `expectedVariationId` /
 *      `matchedRuleId` / `matchedOptionId` when the upstream form supplies
 *      them). Per **FR-017** only the structured value/identity is
 *      modelled; the `.txt` textual trace is NOT asserted.
 *   3. `comparison_*.json` → {@link ComparisonCase} — each setting in the
 *      conversion / trimming fixture is one structured case.
 *
 * Runtime note: these loaders read the vendored files from disk via
 * `node:fs`. They are consumed by Vitest parity suites (Node) and the
 * `export:corpus` script, never bundled into a shipped SDK, so `node:fs` +
 * `import.meta.url` is appropriate here (unlike `@confeature/sdk-shared`,
 * which is runtime-agnostic).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IConfig } from "@confeature/sdk-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the vendored upstream corpus root. */
export const UPSTREAM_DIR = join(HERE, "..", "fixtures", "upstream");

// ---------------------------------------------------------------------------
// Shared user shape
// ---------------------------------------------------------------------------

/**
 * A user context parsed from the corpus. Mirrors the well-known ConfigCat
 * attributes plus a single custom attribute (the matrices and evaluation-log
 * scenarios only ever set one custom key). `undefined` means **no user**;
 * an absent field means that attribute is not set.
 */
export interface CorpusUser {
  readonly identifier?: string;
  readonly email?: string;
  readonly country?: string;
  /** Custom attributes, keyed by the matrix's 4th-column header / suite key. */
  readonly custom?: Readonly<Record<string, string>>;
}

/** A resolved primitive expected value (boolean / number / string). */
export type ExpectedValue = boolean | number | string;

// ---------------------------------------------------------------------------
// 1. testmatrix*.csv
// ---------------------------------------------------------------------------

/** What a matrix cell asserts: the resolved value, or the variation id. */
export type MatrixKind = "value" | "variation";

/** One (data-row × flag-key) cell of a `testmatrix*.csv`. */
export interface MatrixTuple {
  /** The matrix file the case came from (diagnostics). */
  readonly matrix: string;
  /** Flag key (a column header from col 4 onward). */
  readonly key: string;
  /** User context, or `undefined` for the `##null##` (no-user) row. */
  readonly user: CorpusUser | undefined;
  /**
   * `value` matrices expect the resolved flag value (parsed to its JS
   * primitive); `testmatrix_variationId.csv` expects the variation-id string.
   */
  readonly kind: MatrixKind;
  /** Expected outcome — a primitive for `value`, the id string for `variation`. */
  readonly expected: ExpectedValue;
  /** The config_v6 blob serving this matrix (from `content-by-key.json`). */
  readonly config: IConfig;
  /** The SDK key the matrix is served under (the config's `content-by-key` id). */
  readonly sdkKey: string;
}

/**
 * Matrix → SDK key mapping, config_v6 (V2) line only. Derived verbatim from
 * the upstream `rollout_integration_test.go` `integrationTestSuitesV2` table.
 * `testmatrix_variationId.csv` is the only `variation`-kind matrix. The
 * config blob for each SDK key lives in `content-by-key.json`.
 */
const MATRIX_TO_SDK_KEY: ReadonlyArray<{
  matrix: string;
  sdkKey: string;
  kind: MatrixKind;
}> = [
  {
    matrix: "testmatrix.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/AG6C1ngVb0CvM07un6JisQ",
    kind: "value",
  },
  {
    matrix: "testmatrix_semantic.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/iV8vH2MBakKxkFZylxHmTg",
    kind: "value",
  },
  {
    matrix: "testmatrix_number.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/FCWN-k1dV0iBf8QZrDgjdw",
    kind: "value",
  },
  {
    matrix: "testmatrix_semantic_2.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/U8nt3zEhDEO5S2ulubCopA",
    kind: "value",
  },
  {
    matrix: "testmatrix_sensitive.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/-0YmVOUNgEGKkgRF-rU65g",
    kind: "value",
  },
  {
    matrix: "testmatrix_segments_old.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/y_ZB7o-Xb0Swxth-ZlMSeA",
    kind: "value",
  },
  {
    matrix: "testmatrix_and_or.csv",
    sdkKey: "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/ByMO9yZNn02kXcm72lnY1A",
    kind: "value",
  },
  {
    matrix: "testmatrix_comparators_v6.csv",
    sdkKey: "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/OfQqcTjfFUGBwMKqtyEOrQ",
    kind: "value",
  },
  {
    matrix: "testmatrix_prerequisite_flag.csv",
    sdkKey: "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/JoGwdqJZQ0K2xDy7LnbyOg",
    kind: "value",
  },
  {
    matrix: "testmatrix_segments.csv",
    sdkKey: "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/h99HYXWWNE2bH8eWyLAVMA",
    kind: "value",
  },
  {
    matrix: "testmatrix_unicode.csv",
    sdkKey: "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/Da6w8dBbmUeMUBhh0iEeQQ",
    kind: "value",
  },
  {
    matrix: "testmatrix_variationId.csv",
    sdkKey: "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/spQnkRTIPEWVivZkWM84lQ",
    kind: "variation",
  },
];

const NULL_TOKEN = "##null##";

let contentByKeyCache: Record<string, IConfig> | undefined;

/** Load + cache the SDK-key → config_v6 map (`content-by-key.json`). */
function contentByKey(): Record<string, IConfig> {
  if (!contentByKeyCache) {
    const raw = readFileSync(join(UPSTREAM_DIR, "content-by-key.json"), "utf8");
    contentByKeyCache = JSON.parse(raw) as Record<string, IConfig>;
  }
  return contentByKeyCache;
}

/**
 * Parse a single CSV line under upstream conventions: `;` delimiter, Go
 * `csv.Reader` with `Comma = ';'` + **`LazyQuotes = true`**.
 *
 * The crucial LazyQuotes detail (the corpus has array cells like
 * `["read","execute"]`): a `"` only opens a quoted field when it is the
 * **first character of the field**; anywhere else it is a literal quote. So
 * `["read","execute"]` parses to the literal string `["read","execute"]`
 * (quotes preserved), NOT `[read,execute]`. Getting this wrong corrupts every
 * JSON-array attribute (the array comparators) and was the cause of the
 * array-family parity failures.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && fieldStart) {
      // A quote only opens a quoted field at the field start (LazyQuotes).
      inQuotes = true;
      fieldStart = false;
    } else if (ch === ";") {
      fields.push(field);
      field = "";
      fieldStart = true;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Parse a CSV cell to its JS primitive, mirroring the upstream
 * `parseString`: try integer, then float, then the `True`/`False` literals,
 * else the raw string.
 */
function parseCell(s: string): ExpectedValue {
  if (/^-?\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  const f = Number.parseFloat(s);
  if (!Number.isNaN(f) && /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return f;
  if (s === "True") return true;
  if (s === "False") return false;
  return s;
}

/** Build a {@link CorpusUser} from the first four CSV columns. */
function userFromRow(line: string[], customKey: string): CorpusUser | undefined {
  // `##null##` in col 0 → no user at all (upstream `nullStr` + the
  // `line[0] != "##null##"` guard).
  if (line[0] === NULL_TOKEN) return undefined;
  // In the Identifier/Email/Country/Custom columns, the `##null##` token means
  // that attribute is **absent** (not the literal string `"##null##"`). The
  // upstream go-sdk replays each non-null cell as a set attribute and omits the
  // ones equal to the null token, so e.g. a row with Email = `##null##` and a
  // NOT-comparator rule on Email must surface "attribute missing", not match
  // against the literal token.
  const setOrUndef = (v: string | undefined): string | undefined =>
    v === undefined || v === "" || v === NULL_TOKEN ? undefined : v;
  const user: {
    identifier?: string;
    email?: string;
    country?: string;
    custom?: Record<string, string>;
  } = {};
  if (line[0]) user.identifier = line[0];
  const email = setOrUndef(line[1]);
  if (email !== undefined) user.email = email;
  const country = setOrUndef(line[2]);
  if (country !== undefined) user.country = country;
  const customVal = setOrUndef(line[3]);
  if (customVal !== undefined) user.custom = { [customKey]: customVal };
  return user;
}

/** Load + expand one `testmatrix*.csv` into its cell tuples. */
export function loadMatrix(matrix: string): MatrixTuple[] {
  const entry = MATRIX_TO_SDK_KEY.find((m) => m.matrix === matrix);
  if (!entry) throw new Error(`Unknown testmatrix file: ${matrix}`);
  const config = contentByKey()[entry.sdkKey];
  if (!config) throw new Error(`No config for matrix ${matrix} (sdkKey ${entry.sdkKey})`);

  const text = readFileSync(join(UPSTREAM_DIR, matrix), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0] as string);
  const customKey = header[3] as string;
  const settingKeys = header.slice(4);

  const tuples: MatrixTuple[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = parseCsvLine(lines[r] as string);
    const user = userFromRow(cols, customKey);
    for (let c = 0; c < settingKeys.length; c++) {
      const key = settingKeys[c] as string;
      const raw = cols[c + 4] ?? "";
      const expected: ExpectedValue = entry.kind === "value" ? parseCell(raw) : raw;
      tuples.push({
        matrix,
        key,
        user,
        kind: entry.kind,
        expected,
        config,
        sdkKey: entry.sdkKey,
      });
    }
  }
  return tuples;
}

/** Every `testmatrix*.csv` file in the vendor set. */
export function matrixFiles(): string[] {
  return MATRIX_TO_SDK_KEY.map((m) => m.matrix);
}

/** Load + expand all matrices into one flat tuple list. */
export function loadAllMatrices(): MatrixTuple[] {
  return matrixFiles().flatMap(loadMatrix);
}

// ---------------------------------------------------------------------------
// 2. evaluationlog/<scenario>
// ---------------------------------------------------------------------------

/** One `tests[]` case from an `evaluationlog/<scenario>.json` suite. */
export interface EvalLogTuple {
  /** Scenario name (e.g. `1_targeting_rule`). */
  readonly scenario: string;
  /** Flag key to evaluate. */
  readonly key: string;
  /** Default value the upstream test passed. */
  readonly defaultValue: ExpectedValue | null;
  /** User context, or `undefined` for the no-user case. */
  readonly user: CorpusUser | undefined;
  /** Expected resolved value (the suite's `returnValue`). */
  readonly expectedValue: ExpectedValue;
  /**
   * Expected variation id, when the upstream suite carries it. The
   * `go-sdk` evaluation-log suites assert value only, so this is `undefined`
   * for the vendored corpus (FR-017 scopes identity assertions to where the
   * data exists).
   */
  readonly expectedVariationId?: string | undefined;
  /** Matched targeting-rule id, when supplied (else `undefined` — FR-017). */
  readonly matchedRuleId?: string | undefined;
  /** Matched percentage-option id, when supplied (else `undefined`). */
  readonly matchedOptionId?: string | undefined;
  /** The config_v6 blob serving this scenario. */
  readonly config: IConfig;
  /**
   * The expected textual evaluation-log trace (ADR 0003 / #496), loaded
   * verbatim from `evaluationlog/<scenario>/<expectedLog>` with at most one
   * trailing newline stripped (a file artifact — the trace carries none).
   * `undefined` when the upstream test declares no `expectedLog`. A runner
   * asserts this byte-for-byte against the SDK's emitted INFO trace; the
   * builder currently reproduces it for the no-rule `simple_value` scenario
   * (the rule/condition/%-option/prerequisite middle lands with #497–#500).
   */
  readonly expectedTrace?: string | undefined;
}

interface EvalLogSuite {
  configUrl?: string;
  sdkKey?: string;
  jsonOverride?: string;
  tests: ReadonlyArray<{
    key: string;
    defaultValue?: unknown;
    returnValue: unknown;
    expectedLog?: string;
    user?: Record<string, unknown>;
  }>;
}

/** Scenario directories (each has a `<name>.json` suite descriptor). */
const EVAL_LOG_SCENARIOS = [
  "1_targeting_rule",
  "2_targeting_rules",
  "and_rules",
  "circular_dep",
  "comparators",
  "epoch_date_validation",
  "list_truncation",
  "number_validation",
  "options_after_targeting_rule",
  "options_based_on_custom_attr",
  "options_based_on_user_id",
  "options_within_targeting_rule",
  "prerequisite_flag",
  "segment",
  "semver_validation",
  "simple_value",
] as const;

/** Map an evaluation-log suite user object to a {@link CorpusUser}. */
function evalLogUser(raw: Record<string, unknown> | undefined): CorpusUser | undefined {
  if (!raw) return undefined;
  const user: {
    identifier?: string;
    email?: string;
    country?: string;
    custom?: Record<string, string>;
  } = {};
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const val = String(v);
    if (k === "Identifier") user.identifier = val;
    else if (k === "Email") user.email = val;
    else if (k === "Country") user.country = val;
    else custom[k] = val;
  }
  if (Object.keys(custom).length > 0) user.custom = custom;
  return user;
}

let evalLogConfigsByKeyCache: Record<string, IConfig> | undefined;

/**
 * The eval-log-local config map (`evaluationlog/_configs-by-key.json`). Holds
 * configs referenced by an eval-log suite's `sdkKey` that are NOT in the
 * top-level `content-by-key.json` (e.g. the `options_based_on_custom_attr` /
 * `options_within_targeting_rule` config).
 */
function evalLogConfigsByKey(): Record<string, IConfig> {
  if (!evalLogConfigsByKeyCache) {
    const raw = readFileSync(join(UPSTREAM_DIR, "evaluationlog", "_configs-by-key.json"), "utf8");
    evalLogConfigsByKeyCache = JSON.parse(raw) as Record<string, IConfig>;
  }
  return evalLogConfigsByKeyCache;
}

/** Resolve a suite's config — from `jsonOverride` (`_overrides/`) or `sdkKey`. */
function evalLogConfig(suite: EvalLogSuite): IConfig {
  if (suite.jsonOverride) {
    const raw = readFileSync(
      join(UPSTREAM_DIR, "evaluationlog", "_overrides", suite.jsonOverride),
      "utf8",
    );
    return JSON.parse(raw) as IConfig;
  }
  if (suite.sdkKey) {
    const config = contentByKey()[suite.sdkKey] ?? evalLogConfigsByKey()[suite.sdkKey];
    if (!config) throw new Error(`No config for eval-log sdkKey ${suite.sdkKey}`);
    return config;
  }
  throw new Error("Eval-log suite has neither jsonOverride nor sdkKey");
}

/**
 * Per-scenario RECONSTRUCTED settings shallow-merged onto a verbatim config's
 * `f` map. Keyed by scenario name → reconstructed-settings filename under
 * `evaluationlog/_reconstructed/`. The merged settings are NOT upstream-
 * verbatim: they are reconstructed faithfully from the scenario's eval-log
 * textual trace because ConfigCat never published the blob under any sdkKey.
 * Each reconstructed file carries an inline `_provenance` note; see also
 * `fixtures/upstream/PROVENANCE.md`. The verbatim `content-by-key.json` is
 * never edited — the merge happens at load time.
 *
 * `prerequisite_flag` is the one such scenario: its `dependentFeatureMultiple-
 * Levels` case (trace `prerequisite_flag_multilevel.txt`) chains
 * `dependentFeatureMultipleLevels → intermediateFeature →
 * mainFeatureWithoutUserCondition`, but only the leaf
 * `mainFeatureWithoutUserCondition` is present verbatim; the two upper
 * settings were never vendored, so they are reconstructed from the trace.
 */
const RECONSTRUCTED_SETTINGS: Readonly<Record<string, string>> = {
  prerequisite_flag: "prerequisite_flag_multilevel.json",
};

/** Shallow-merge reconstructed settings into a (cloned) verbatim config. */
function mergeReconstructedSettings(scenario: string, config: IConfig): IConfig {
  const file = RECONSTRUCTED_SETTINGS[scenario];
  if (!file) return config;
  const raw = readFileSync(join(UPSTREAM_DIR, "evaluationlog", "_reconstructed", file), "utf8");
  const recon = JSON.parse(raw) as { f: IConfig["f"] };
  // Clone so the cached verbatim config object is never mutated.
  return { ...config, f: { ...config.f, ...recon.f } };
}

/** Load one evaluation-log scenario into its tuples (FR-017: value + identity). */
export function loadEvalLogScenario(scenario: string): EvalLogTuple[] {
  const raw = readFileSync(join(UPSTREAM_DIR, "evaluationlog", `${scenario}.json`), "utf8");
  const suite = JSON.parse(raw) as EvalLogSuite;
  const config = mergeReconstructedSettings(scenario, evalLogConfig(suite));
  return suite.tests.map((t) => {
    const user = evalLogUser(t.user);
    const rawTrace = loadExpectedTrace(scenario, t.expectedLog);
    return {
      scenario,
      key: t.key,
      defaultValue: (t.defaultValue ?? null) as ExpectedValue | null,
      user,
      expectedValue: t.returnValue as ExpectedValue,
      config,
      expectedTrace:
        rawTrace === undefined ? undefined : toCanonicalTrace(rawTrace, user, scenario),
    };
  });
}

/**
 * The user as the eval-log header renders it — the Confeature-canonical
 * `{ Identifier, Email?, Country?, …custom }` form (ADR 0003 addendum, #497).
 * MUST stay in lock-step with `userAttributesForLog` in
 * `packages/sdk-shared/src/evaluator.ts`.
 */
function canonicalUserHeader(user: CorpusUser): string {
  const attrs: Record<string, unknown> = { Identifier: user.identifier ?? "" };
  if (user.email !== undefined) attrs.Email = user.email;
  if (user.country !== undefined) attrs.Country = user.country;
  for (const [k, v] of Object.entries(user.custom ?? {})) attrs[k] = v;
  return JSON.stringify(attrs);
}

/**
 * Transform a vendored go-sdk expected trace to the single Confeature-canonical
 * form (ADR 0003 addendum, #497): the user-header `map[string]interface {}{…}` →
 * `JSON.stringify(getUserAttributes(user))`, and the go method name `GetValue()`
 * → the JS-canonical `getValue()` in the WARN 3001 message. Every other trace
 * line is configcat-common-shared and stays verbatim. So the corpus carries the
 * canonical trace every Confeature SDK emits — byte-identical cross-SDK.
 */
function toCanonicalTrace(
  rawTrace: string,
  user: CorpusUser | undefined,
  scenario: string,
): string {
  let out = rawTrace.replaceAll("`GetValue()`", "`getValue()`");
  if (user) {
    // A prerequisite trace re-renders the user header once per nesting level,
    // so every occurrence is rewritten (not just the first).
    out = out.replace(/map\[string\]interface \{\}\{[^}]*\}/gu, canonicalUserHeader(user));
  }
  // Typed-attribute validation reasons are language-specific — the go-sdk oracle
  // carries Go's parser errors ("No Major.Minor.Patch elements found",
  // `strconv.ParseFloat …`). Confeature emits configcat-common's canonical reason
  // (`'<v>' is not a valid <type>` — byte-identical to configcat-js and shared
  // across the Confeature federation). Number and date share the Go ParseFloat
  // error, distinguished only by comparator, so the mapping is per scenario.
  const invalidValue = user?.custom ? (Object.values(user.custom)[0] ?? "") : "";
  if (scenario === "semver_validation") {
    // A malformed CONFIG comparison value (validation-order parity, #509) carries
    // a go-specific parser reason (e.g. `Invalid character(s) found in patch
    // number "0,"`). Confeature emits configcat-common's canonical reason keyed
    // on the OPERAND captured from `comparison value '<v>' is invalid (…)` — NOT
    // the user value — so the `relations` trace (which has BOTH a comparison-value
    // error and user-attribute errors) maps each line correctly.
    // Replace ONLY the go parser reason inside `comparison value '<v>' is
    // invalid (<reason>)` with configcat-common's canonical reason. The go reason
    // itself contains parentheses (e.g. `Invalid character(s) found in patch
    // number "0,"`), so it is matched by its known shape — NOT a greedy
    // paren-balance, which would swallow the outer setting paren on the WARN line.
    out = out.replace(
      /(comparison value '([^']*)' is invalid \()Invalid character\(s\) found in patch number "[^"]*"\)/gu,
      (_m, prefix: string, operand: string) =>
        `${prefix}'${operand}' is not a valid semantic version)`,
    );
    out = out.replaceAll(
      "No Major.Minor.Patch elements found",
      `'${invalidValue}' is not a valid semantic version`,
    );
  } else if (scenario === "number_validation") {
    out = out.replace(
      /strconv\.ParseFloat: parsing "[^"]*": invalid syntax/gu,
      `'${invalidValue}' is not a valid decimal number`,
    );
  } else if (scenario === "epoch_date_validation") {
    out = out.replace(
      /strconv\.ParseFloat: parsing "[^"]*": invalid syntax/gu,
      `'${invalidValue}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)`,
    );
    // The datetime condition render parenthesises the operand's human date. go
    // formats it `2006-01-02 15:04:05 +0000 UTC`; configcat-common (and so
    // Confeature, via `Date.toISOString()`) formats it as ISO-8601
    // `2006-01-02T15:04:05.000Z UTC`. Re-render each go date stamp into the
    // canonical ISO form so the trace stays byte-identical cross-SDK.
    out = out.replace(
      /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0000 UTC/gu,
      (_m, date: string, time: string) => `${new Date(`${date}T${time}Z`).toISOString()} UTC`,
    );
  }
  return out;
}

/**
 * Read the verbatim expected trace for a test (ADR 0003 / #496). The suite's
 * `expectedLog` is a filename under `evaluationlog/<scenario>/`. We strip at
 * most one trailing newline (a file artifact); the trace body itself carries
 * none (e.g. `simple_value/on_flag.txt` is exactly 59 bytes).
 */
function loadExpectedTrace(scenario: string, expectedLog: string | undefined): string | undefined {
  if (!expectedLog) return undefined;
  const raw = readFileSync(join(UPSTREAM_DIR, "evaluationlog", scenario, expectedLog), "utf8");
  return raw.replace(/\n$/u, "");
}

/** Every evaluation-log scenario name in the vendor set. */
export function evalLogScenarios(): readonly string[] {
  return EVAL_LOG_SCENARIOS;
}

/** Load all evaluation-log scenarios into one flat tuple list. */
export function loadAllEvalLogs(): EvalLogTuple[] {
  return EVAL_LOG_SCENARIOS.flatMap(loadEvalLogScenario);
}

// ---------------------------------------------------------------------------
// 3. comparison_*.json (attribute conversion / trimming, value trimming)
// ---------------------------------------------------------------------------

/**
 * One setting from a `comparison_*.json` conversion/trimming fixture. Each
 * fixture is itself a `config_v6` blob (`{p, f}`); each `f[key]` encodes one
 * conversion / trimming scenario. The harness exposes the structured case
 * (config + key + the served fallback) so the consuming parity suite
 * (US5 / T024+T027) supplies the user + expected decision the fixture is
 * designed to exercise.
 */
export interface ComparisonCase {
  /** Which comparison fixture (`attribute_conversion` / `attribute_trimming` / `value_trimming`). */
  readonly fixture: string;
  /** Setting key within the fixture. */
  readonly key: string;
  /** The full fixture config (one shared blob per fixture). */
  readonly config: IConfig;
}

/** The three vendored comparison fixtures. */
const COMPARISON_FIXTURES = [
  "comparison_attribute_conversion",
  "comparison_attribute_trimming",
  "comparison_value_trimming",
] as const;

/** Load one comparison fixture into per-setting cases. */
export function loadComparisonFixture(fixture: string): ComparisonCase[] {
  const raw = readFileSync(join(UPSTREAM_DIR, `${fixture}.json`), "utf8");
  const config = JSON.parse(raw) as IConfig;
  return Object.keys(config.f).map((key) => ({ fixture, key, config }));
}

/** Every comparison fixture name in the vendor set. */
export function comparisonFixtures(): readonly string[] {
  return COMPARISON_FIXTURES;
}

/** Load all comparison fixtures into one flat case list. */
export function loadAllComparisonCases(): ComparisonCase[] {
  return COMPARISON_FIXTURES.flatMap(loadComparisonFixture);
}

// ---------------------------------------------------------------------------
// 3b. comparison_*.json DRIVERS (typed user + expected value)
// ---------------------------------------------------------------------------

/**
 * A typed user-attribute value the conversion/trimming drivers feed. Mirrors
 * ConfigCat's `UserAttributeValue` plus the `boolean` our `User.custom` accepts;
 * the special `number` cases (`NaN`, `±Infinity`) are passed verbatim so the
 * attribute-conversion path is exercised exactly as upstream.
 */
export type TypedAttributeValue = string | number | boolean | readonly string[] | Date;

/** A fully-specified comparison driver case: config + key + user + expected value. */
export interface ComparisonDriverCase {
  /** Which comparison fixture. */
  readonly fixture: string;
  /** Setting key within the fixture. */
  readonly key: string;
  /** The fixture config blob. */
  readonly config: IConfig;
  /** The user `Identifier` (well-known attribute). */
  readonly identifier: string;
  /** The user `Country` (well-known attribute), when set. */
  readonly country?: string | undefined;
  /** Typed custom attributes (keyed by name). */
  readonly custom: Readonly<Record<string, TypedAttributeValue>>;
  /** The expected resolved value (a string for all three fixtures). */
  readonly expected: string;
}

/**
 * The `comparison_attribute_conversion` driver — verbatim from the official
 * ConfigCat SDK conformance suite (`test-evaluation.cpp`
 * `ComparisonAttributeConversionToCanonicalStringTestSuite`). Each case sets a
 * single typed `Custom1` attribute on user `12345`; the expected value proves
 * the SDK converts the attribute to ConfigCat's canonical string before the
 * `TextEquals` (comparator 28) test, and the matching percentage option (`1`..
 * `5`) is served. `NaN`/`±Infinity` are deliberately included.
 */
const ATTRIBUTE_CONVERSION_DRIVER: ReadonlyArray<{
  key: string;
  custom1: TypedAttributeValue;
  expected: string;
}> = [
  { key: "numberToStringConversion", custom1: 0.12345, expected: "1" },
  { key: "numberToStringConversionInt", custom1: 125, expected: "4" },
  { key: "numberToStringConversionPositiveExp", custom1: -1.23456789e96, expected: "2" },
  { key: "numberToStringConversionNegativeExp", custom1: -12345.6789e-100, expected: "4" },
  { key: "numberToStringConversionNaN", custom1: Number.NaN, expected: "3" },
  { key: "numberToStringConversionPositiveInf", custom1: Number.POSITIVE_INFINITY, expected: "4" },
  { key: "numberToStringConversionNegativeInf", custom1: Number.NEGATIVE_INFINITY, expected: "3" },
  // 2023-03-31T23:59:59.999Z = 1680307199.999 Unix seconds.
  { key: "dateToStringConversion", custom1: new Date(1680307199999), expected: "3" },
  { key: "dateToStringConversion", custom1: 1680307199.999, expected: "3" },
  { key: "dateToStringConversionNaN", custom1: Number.NaN, expected: "3" },
  { key: "dateToStringConversionPositiveInf", custom1: Number.POSITIVE_INFINITY, expected: "1" },
  { key: "dateToStringConversionNegativeInf", custom1: Number.NEGATIVE_INFINITY, expected: "5" },
  {
    key: "stringArrayToStringConversion",
    custom1: ["read", "Write", " eXecute "],
    expected: "4",
  },
  { key: "stringArrayToStringConversionEmpty", custom1: [], expected: "5" },
  {
    key: "stringArrayToStringConversionSpecialChars",
    custom1: ["+<>%\"'\\/\t\r\n"],
    expected: "3",
  },
  {
    key: "stringArrayToStringConversionUnicode",
    custom1: ["äöüÄÖÜçéèñışğâ¢™✓😀"],
    expected: "2",
  },
];

/**
 * The `comparison_attribute_trimming` driver — verbatim from the official
 * suite (`ComparisonAttributeTrimmingTestSuite`). User `Identifier`/`Country`
 * and the `Version`/`Number`/`Date` custom attributes are intentionally
 * **whitespace-padded**; the expected value proves which comparators trim the
 * USER attribute (semver/number/date — backward compat) and which do not
 * (text/array/contains). `Country` is `[" USA "]` (a JSON array string).
 */
const ATTRIBUTE_TRIMMING_DRIVER: ReadonlyArray<{ key: string; expected: string }> = [
  { key: "isoneof", expected: "no trim" },
  { key: "isnotoneof", expected: "no trim" },
  { key: "isoneofhashed", expected: "no trim" },
  { key: "isnotoneofhashed", expected: "no trim" },
  { key: "equalshashed", expected: "no trim" },
  { key: "notequalshashed", expected: "no trim" },
  { key: "arraycontainsanyofhashed", expected: "no trim" },
  { key: "arraynotcontainsanyofhashed", expected: "no trim" },
  { key: "equals", expected: "no trim" },
  { key: "notequals", expected: "no trim" },
  { key: "startwithanyof", expected: "no trim" },
  { key: "notstartwithanyof", expected: "no trim" },
  { key: "endswithanyof", expected: "no trim" },
  { key: "notendswithanyof", expected: "no trim" },
  { key: "arraycontainsanyof", expected: "no trim" },
  { key: "arraynotcontainsanyof", expected: "no trim" },
  { key: "startwithanyofhashed", expected: "no trim" },
  { key: "notstartwithanyofhashed", expected: "no trim" },
  { key: "endswithanyofhashed", expected: "no trim" },
  { key: "notendswithanyofhashed", expected: "no trim" },
  // semver comparators: USER value trimmed (backward compat).
  { key: "semverisoneof", expected: "4 trim" },
  { key: "semverisnotoneof", expected: "5 trim" },
  { key: "semverless", expected: "6 trim" },
  { key: "semverlessequals", expected: "7 trim" },
  { key: "semvergreater", expected: "8 trim" },
  { key: "semvergreaterequals", expected: "9 trim" },
  // number + date comparators: USER value trimmed (backward compat).
  { key: "numberequals", expected: "10 trim" },
  { key: "numbernotequals", expected: "11 trim" },
  { key: "numberless", expected: "12 trim" },
  { key: "numberlessequals", expected: "13 trim" },
  { key: "numbergreater", expected: "14 trim" },
  { key: "numbergreaterequals", expected: "15 trim" },
  { key: "datebefore", expected: "18 trim" },
  { key: "dateafter", expected: "19 trim" },
  // contains/notcontains: NOT trimmed (special case).
  { key: "containsanyof", expected: "no trim" },
  { key: "notcontainsanyof", expected: "no trim" },
];

/**
 * The `comparison_value_trimming` driver — verbatim from the official suite
 * (`ComparisonValueTrimmingTestSuite`). The USER attributes are clean; the
 * **config-side comparison values** are whitespace-padded. The expected value
 * proves which comparators trim the CONFIG operand (semver — backward compat)
 * and which do not.
 */
const VALUE_TRIMMING_DRIVER: ReadonlyArray<{ key: string; expected: string }> = [
  { key: "isoneof", expected: "no trim" },
  { key: "isnotoneof", expected: "no trim" },
  { key: "containsanyof", expected: "no trim" },
  { key: "notcontainsanyof", expected: "no trim" },
  { key: "isoneofhashed", expected: "no trim" },
  { key: "isnotoneofhashed", expected: "no trim" },
  { key: "equalshashed", expected: "no trim" },
  { key: "notequalshashed", expected: "no trim" },
  { key: "arraycontainsanyofhashed", expected: "no trim" },
  { key: "arraynotcontainsanyofhashed", expected: "no trim" },
  { key: "equals", expected: "no trim" },
  { key: "notequals", expected: "no trim" },
  { key: "startwithanyof", expected: "no trim" },
  { key: "notstartwithanyof", expected: "no trim" },
  { key: "endswithanyof", expected: "no trim" },
  { key: "notendswithanyof", expected: "no trim" },
  { key: "arraycontainsanyof", expected: "no trim" },
  { key: "arraynotcontainsanyof", expected: "no trim" },
  { key: "startwithanyofhashed", expected: "no trim" },
  { key: "notstartwithanyofhashed", expected: "no trim" },
  { key: "endswithanyofhashed", expected: "no trim" },
  { key: "notendswithanyofhashed", expected: "no trim" },
  // semver comparator values trimmed (backward compat).
  { key: "semverisoneof", expected: "4 trim" },
  { key: "semverisnotoneof", expected: "5 trim" },
  { key: "semverless", expected: "6 trim" },
  { key: "semverlessequals", expected: "7 trim" },
  { key: "semvergreater", expected: "8 trim" },
  { key: "semvergreaterequals", expected: "9 trim" },
];

/** Load the `comparison_attribute_conversion` driver cases (typed `Custom1`). */
export function loadAttributeConversionDriver(): ComparisonDriverCase[] {
  const fixture = "comparison_attribute_conversion";
  const config = loadComparisonFixture(fixture)[0]?.config as IConfig;
  return ATTRIBUTE_CONVERSION_DRIVER.map((c) => ({
    fixture,
    key: c.key,
    config,
    identifier: "12345",
    custom: { Custom1: c.custom1 },
    expected: c.expected,
  }));
}

/** Load the `comparison_attribute_trimming` driver cases (padded user attrs). */
export function loadAttributeTrimmingDriver(): ComparisonDriverCase[] {
  const fixture = "comparison_attribute_trimming";
  const config = loadComparisonFixture(fixture)[0]?.config as IConfig;
  return ATTRIBUTE_TRIMMING_DRIVER.map((c) => ({
    fixture,
    key: c.key,
    config,
    identifier: " 12345 ",
    country: '[" USA "]',
    custom: { Version: " 1.0.0 ", Number: " 3 ", Date: " 1705253400 " },
    expected: c.expected,
  }));
}

/** Load the `comparison_value_trimming` driver cases (padded config operands). */
export function loadValueTrimmingDriver(): ComparisonDriverCase[] {
  const fixture = "comparison_value_trimming";
  const config = loadComparisonFixture(fixture)[0]?.config as IConfig;
  return VALUE_TRIMMING_DRIVER.map((c) => ({
    fixture,
    key: c.key,
    config,
    identifier: "12345",
    country: '["USA"]',
    custom: { Version: "1.0.0", Number: "3", Date: "1705253400" },
    expected: c.expected,
  }));
}

/** Load all three comparison drivers into one flat case list. */
export function loadAllComparisonDrivers(): ComparisonDriverCase[] {
  return [
    ...loadAttributeConversionDriver(),
    ...loadAttributeTrimmingDriver(),
    ...loadValueTrimmingDriver(),
  ];
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** The full vendored upstream corpus, materialised as typed tuples. */
export interface UpstreamCorpus {
  readonly matrices: MatrixTuple[];
  readonly evalLogs: EvalLogTuple[];
  readonly comparisons: ComparisonCase[];
}

/**
 * Build the entire vendored upstream corpus (research.md §R7). The reference
 * evaluator's parity suite + each federated SDK's suite iterate these tuples
 * and assert byte-identical ConfigCat parity.
 */
export function buildUpstreamCorpus(): UpstreamCorpus {
  return {
    matrices: loadAllMatrices(),
    evalLogs: loadAllEvalLogs(),
    comparisons: loadAllComparisonCases(),
  };
}

/**
 * Sanity helper: confirm every vendored `testmatrix*.csv` file on disk is
 * mapped (catches a re-vendor that adds a matrix without updating the table).
 */
export function unmappedMatrixFiles(): string[] {
  const onDisk = readdirSync(UPSTREAM_DIR).filter(
    (f) => f.startsWith("testmatrix") && f.endsWith(".csv"),
  );
  const mapped = new Set(matrixFiles());
  return onDisk.filter((f) => !mapped.has(f));
}
