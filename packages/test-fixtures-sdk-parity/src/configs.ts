// SPDX-License-Identifier: MIT

/**
 * Canonical `config_v6.json` blobs consumed by the shared parity corpus.
 *
 * These are the byte-exact payloads the SDK's parser MUST accept. The
 * parity tier loads each via `flagOverrides` (research §R16 of spec
 * 031) so both Confeature and `configcat-js` evaluate the same input
 * without a network round-trip.
 *
 * Two canonical config sets, exported separately:
 *   - `CONFIGS`        — `boolean-basic`: three `t: 0` boolean
 *                        settings. Consumed by the shared 58-tuple
 *                        corpus that every SDK runs.
 *   - `CONFIGS_TYPED`  — `typed-basic`: `string` (`t: 1`), `int`
 *                        (`t: 2`) and `double` (`t: 3`) settings
 *                        covering the SettingType × value extension
 *                        matrix (representative + edge cases). A
 *                        **separate** set for the typed corpus
 *                        (#254-#261). See spec 066 (#253).
 *
 * Adding a new blob:
 *  1. Add an entry below with a stable `id` and a description.
 *  2. Reference it in `fixtures.ts` via the `configId` field.
 *  3. Re-run `vp run -F "@confeature/sdk-*" test:parity` to confirm
 *     every SDK still passes.
 */

import type { IConfig } from "@confeature/sdk-shared";

import canonicalBooleanFixture from "../fixtures/config-v6.boolean.json" with { type: "json" };
import canonicalRulesFixture from "../fixtures/config-v6.rules.json" with { type: "json" };
import canonicalTypedFixture from "../fixtures/config-v6.typed.json" with { type: "json" };

/**
 * A canonical config payload, plus the metadata SDK parity runners need
 * to feed it into both Confeature and the upstream parity reference.
 */
export interface CanonicalConfig {
  /** Stable identifier used by tuples to reference this blob. */
  readonly id: string;
  /** Short prose for diagnostics. */
  readonly description: string;
  /** The parsed `config_v6.json` blob — already type-checked. */
  readonly config: IConfig;
  /**
   * How the SDK parity runner injects this config (spec 135 §R4):
   *   - `"map"` — flat `overridesMap` → `createFlagOverridesFromMap`
   *     (value-only; the established 58/13-tuple path, byte-unchanged).
   *   - `"full-config"` — the whole `{p,f,s}` blob → the rule-engine path
   *     (`createFlagOverridesFromConfig`); `overridesMap` is absent and the
   *     runner resolves targeting rules / segments / % options offline.
   * Explicit (not derived from `r` non-empty) so the runner has a clean
   * skip signal when an SDK has not adopted the full-config path (SC-004).
   */
  readonly injectionMode: "map" | "full-config";
  /**
   * Flat key→value map for use with the SDK's
   * `createFlagOverridesFromMap` helper (parity-tier injection path).
   * Mirrors the typed values inside `config.f` — `boolean` for a `t: 0`
   * setting, `string` for `t: 1`, `number` for `t: 2` / `t: 3`.
   *
   * Present only for `injectionMode: "map"`; absent for `"full-config"`
   * (those configs are injected whole, through the rule engine).
   */
  readonly overridesMap?: Record<string, boolean | string | number>;
}

const canonicalBooleanConfig: IConfig = canonicalBooleanFixture as IConfig;

const canonicalBooleanOverrides: Record<string, boolean | string | number> = {
  "feature.dark-mode": true,
  "feature.beta-toggle": false,
  "feature.unused-key": true,
};

const canonicalTypedConfig: IConfig = canonicalTypedFixture as IConfig;

const canonicalTypedOverrides: Record<string, boolean | string | number> = {
  "feature.welcome-text": "Welcome to Confeature",
  "feature.empty-label": "",
  "feature.max-retries": 5,
  "feature.zero-quota": 0,
  "feature.offset-days": -3,
  "feature.sample-rate": 0.25,
  "feature.zero-threshold": 0,
  "feature.temperature-floor": -273.15,
  "feature.precision-sum": 0.30000000000000004,
};

/**
 * Canonical configs for the shared 58-tuple boolean corpus. Every SDK
 * runs these.
 */
export const CONFIGS: readonly CanonicalConfig[] = [
  {
    id: "boolean-basic",
    description:
      "Three boolean settings, no targeting rules, no segments. " +
      "Covers happy-path evaluation + missing-key fallback.",
    config: canonicalBooleanConfig,
    injectionMode: "map",
    overridesMap: canonicalBooleanOverrides,
  },
];

/**
 * Canonical configs for the typed `SettingType × value` extension
 * corpus (spec 066 / #253). A **separate** set — not merged into
 * `CONFIGS` — so boolean-only SDKs keep loading only `boolean-basic`.
 */
export const CONFIGS_TYPED: readonly CanonicalConfig[] = [
  {
    id: "typed-basic",
    description:
      "Nine settings spanning the string / int / double SettingTypes — " +
      "representative values plus the edge cases (empty string, zero, " +
      "negative, precision-sensitive double). No targeting rules, no " +
      "segments. Covers the SettingType × value extension matrix.",
    config: canonicalTypedConfig,
    injectionMode: "map",
    overridesMap: canonicalTypedOverrides,
  },
];

// `as unknown as IConfig`: the rule-bearing fixture now carries a setting-level
// `p[]` percentage-options literal (spec 146 / #385) whose inferred JSON-module
// type no longer structurally overlaps `IConfig` enough for a direct cast
// (TS2352). The blob is byte-faithful to ConfigCat's `config_v6` wire shape; the
// double-assertion only relaxes the over-narrow JSON-module inference.
const canonicalRulesConfig: IConfig = canonicalRulesFixture as unknown as IConfig;

/**
 * Canonical rule-bearing configs for the targeting-rule corpus
 * (spec 135 / #383). A **separate** set — like `CONFIGS_TYPED` — so the
 * existing boolean / typed configs keep their serialized bytes byte-stable
 * (FR-006 / SC-003).
 *
 * The single blob ports ConfigCat's `stringContainsDogDefaultCat` (one rule:
 * `Email CONTAINS @configcat.com → Dog`, default `Cat`) and
 * `stringIsInDogDefaultCat` (two rules, first-match-wins) from the vendored
 * `evaluationlog/_configs-by-key.json` / `content-by-key.json`. It carries
 * `injectionMode: "full-config"` and NO `overridesMap` — the SDK runner
 * injects the whole `{p,f,s}` blob through `createFlagOverridesFromConfig`
 * and resolves the rules offline via the real engine.
 */
export const CONFIGS_RULES: readonly CanonicalConfig[] = [
  {
    id: "rules-basic",
    description:
      "String settings with targeting rules ported from ConfigCat's vendored " +
      "test matrix: stringContainsDogDefaultCat (one CONTAINS rule, default " +
      "Cat), stringIsInDogDefaultCat (two IS-ONE-OF rules, first-match-wins), " +
      "plus the remaining text comparators (spec 136 / #384) — EQUALS, NOT " +
      "EQUALS, STARTS WITH, ENDS WITH and IS NOT ONE OF — each in cleartext " +
      "AND SHA-256 sensitive (hashed) form, plus the six number comparators " +
      "(spec 137 / #389) — NumberEquals/NotEquals/Less/LessOrEquals/Greater/" +
      "GreaterOrEquals (enums 10-15) on the numeric Custom1 attribute (the " +
      "`number` and `numberWithPercentage` settings, thresholds in the `d` " +
      "field), incl. the locale-independent 0/0.0/0,0 decimal-parse canary, " +
      "plus the six semver comparators (spec 138 / #388) — SemVerIsOneOf/" +
      "IsNotOneOf/Less/LessOrEquals/Greater/GreaterOrEquals (enums 4-9) on " +
      "the Custom1/AppVersion attributes (the `isOneOf`, `isNotOneOf`, " +
      "`relations` and `precedenceTests` settings, comparison value in the " +
      "`s`/`l` string field), incl. the IS-ONE-OF stray-whitespace trim-parity " +
      "lists and the precedence ordering chain (numeric-vs-alphanumeric " +
      "prerelease identifiers, prerelease-below-release, build-metadata-" +
      "ignored), plus the remaining sensitive comparators (spec 139 / #391) — " +
      "SensitiveTextIsOneOf (16, positive), NotStartsWithAnyOf (23) and " +
      "NotEndsWithAnyOf (25) — and the multi-attribute isOneOfSensitive (16) / " +
      "isNotOneOfSensitive (17) cases ported 1:1 from testmatrix_sensitive.csv " +
      "(identifier/email/country, first-match-wins, each comparison value " +
      "SHA-256-salted against p.s + setting key), plus the array comparators " +
      "(spec 140 / #393) — ArrayContainsAnyOf (34) / ArrayNotContainsAnyOf " +
      "(35) cleartext and SensitiveArrayContainsAnyOf (26) / " +
      "SensitiveArrayNotContainsAnyOf (27) hashed, plus the two case-check " +
      "settings — on the JSON-array-string Custom1 attribute, ported 1:1 from " +
      "the stringArray*/arrayContainsCaseCheck* columns of " +
      "testmatrix_comparators_v6.csv (cleartext lists verbatim, sensitive " +
      "lists pre-hashed against p.s + setting key, case-check rows proving " +
      "case sensitivity), plus the Unicode comparators (spec 141 / #398) — the " +
      "highest cross-SDK normalization risk — TextEquals (28 / 20), IsOneOf " +
      "(0 / 16) and ArrayContainsAnyOf (34 / 26), cleartext + hashed, ALL " +
      "targeting the Unicode attribute NAME 🆃🅴🆇🆃 with Unicode comparison " +
      "values (accented ÁRVÍZTŰRŐ tükörfúrógép, surrogate-pair u𝖓𝖎𝖈𝖔𝖉e, " +
      "Unicode arrays), ported 1:1 from testmatrix_unicode.csv (cleartext " +
      "verbatim, sensitive operands pre-hashed over the EXACT UTF-8 bytes of " +
      "the Unicode value against p.s + setting key), plus the AND/OR " +
      "condition-group dimension (spec 142 / #386) — the `emailAnd` setting " +
      "(one rule, three AND conditions: Email STARTS WITH jane AND CONTAINS @ " +
      "AND ENDS WITH sensitivecompany.com → Dog, all-must-match) and the " +
      "`emailOr` setting (three first-match-wins rules: Email STARTS WITH " +
      "jane@/john@/mark@ → Jane/John/Mark, else Cat), ported 1:1 from the " +
      "emailAnd/emailOr columns of testmatrix_and_or.csv (sensitive operands " +
      "re-hashed against p.s + setting key), plus the datetime comparators " +
      "(spec 143 / #392) — DateTimeBefore (18) / DateTimeAfter (19) on a " +
      "Unix-epoch Date attribute (the datetimeBeforeDogDefaultCat / " +
      "datetimeAfterDogDefaultCat settings, epoch threshold 1693497600 in the " +
      "`d` field, served 12 / base default), ported 1:1 from the allinone " +
      'Date BEFORE/AFTER rule in content-by-key.json + the Date="1693497500" ' +
      "case in evaluationlog/comparators.json, incl. the fractional-seconds " +
      "and int-vs-double epoch-parse edge cases, plus comparison-attribute & " +
      "comparison-value trimming (spec 144 / #394, TRIMMING ONLY — the " +
      "non-string-attribute conversion cases are deferred to the typed-user-" +
      "attributes prerequisite since the string-only SDK runners cannot " +
      "deserialize a number/date/array attribute) — an attribute-trimming case " +
      "(semverGreaterAttrTrimDogDefaultCat, SemVerGreater 8, whitespace-bearing " +
      'attribute " 0.2.0 " trimmed) and a comparison-value-trimming case ' +
      "(semverGreaterValueTrimDogDefaultCat, SemVerGreater 8, stored comparison " +
      'value " 0.1.1 " kept whitespace-verbatim and trimmed by the engine), ' +
      "ported 1:1 from comparison_attribute_trimming.json / " +
      "comparison_value_trimming.json (semver comparators trim both sides; text " +
      "comparators do not), both on a plain STRING Custom1 attribute, plus the " +
      "segment-condition dimension (spec 145 / #390) — IS-IN-SEGMENT (c:0) and " +
      "IS-NOT-IN-SEGMENT (c:1) referencing the now non-empty top-level s[]: a " +
      "HASHED `Developers` segment (Email IS-ONE-OF {kate@, john@}, comparator " +
      "16) and a cleartext `Beta Users (cleartext)` segment (Email IS-ONE-OF " +
      "{jane@, john@}, comparator 0), with three single-segment-condition " +
      "settings (segDeveloperIsInDogDefaultCat / segBetaCleartextIsInDogDefaultCat " +
      "/ segDeveloperIsNotInDogDefaultCat), ported 1:1 from content-by-key.json " +
      "+ testmatrix_segments.csv; the hashed segment's operands are salted with " +
      "the SEGMENT NAME (SHA-256(value + p.s + segment-name), the spec-128/129 " +
      "lesson), not the setting key, plus the percentage-rollout dimension " +
      "(spec 146 / #385) — the `string75Cat0Dog25Falcon0Horse` setting (a " +
      "setting-level p[] percentage-options array: Cat 75% / Dog 0% / Falcon " +
      "25% / Horse 0%, base served Chicken), ported 1:1 from content-by-key.json " +
      "+ the Identifier cases in evaluationlog/options_based_on_user_id.json; the " +
      "served option is the deterministic UNSALTED bucket parseInt(sha1(setting " +
      "key + Identifier).substring(0,7),16) % 100 accumulated across option " +
      "widths (Identifier 12345 → Cat, 0 → Falcon, no user → Chicken), plus the " +
      "percentage-option PLACEMENT variants (spec 147 / #397) — three settings " +
      "ported 1:1 from the vendored evaluationlog/options_after_targeting_rule.json " +
      "/ options_within_targeting_rule.json / options_based_on_custom_attr.json + " +
      "their canonical configs: AFTER-rule (integer25One25Two25Three25FourAdvanced" +
      "Rules, setting-level p[] One/Two/Three/Four 25% each served when the Email-" +
      "CONTAINS-@configcat.com rule FAILS, else the rule's fixed 5 wins, base -1), " +
      "WITHIN-rule (stringContainsString75Cat0Dog25Falcon0HorseDefaultCat, the " +
      "matched rule's served value is itself a r[].p split Cat 75% / Falcon 25% " +
      "keyed by Country, base Cat), and BY-CUSTOM-ATTR (string75Cat0Dog25Falcon0" +
      "HorseCustomAttr, a=Country selects the bucketing attribute for a setting-" +
      "level p[] Cat 75% / Falcon 25%, base Chicken when Country is absent); same " +
      "UNSALTED settingKey+attrValue bucket recipe, STRING attributes only, plus " +
      "the long IS-CONTAINS-list booleanKey1 setting (spec 149 / #396 — one rule, " +
      "three AND Identifier-CONTAINS-ANY-OF long lists, served true) ported 1:1 " +
      "from list_truncation.json + _overrides/test_list_truncation.json for the " +
      "attribute-validation error-path coverage (a MALFORMED number/semver/epoch " +
      "attribute makes the conversion error → rule no-match → fallback, exercised " +
      "via the existing number/isNotOneOf/relations/datetimeBeforeDogDefaultCat " +
      "settings; the long-list case proves truncation is log-only, not a " +
      "resolution concern). Carries the full {p,f,s} " +
      "blob incl. the percentage/sensitive salt (p.s) so the engine resolves " +
      "the rules (and the hashed comparators) offline.",
    config: canonicalRulesConfig,
    injectionMode: "full-config",
  },
];

/**
 * Look up a canonical config by its `id`, across the boolean, typed and
 * rule-bearing sets. Throws on miss for test-side fail-fast.
 */
export function getConfig(id: string): CanonicalConfig {
  const match = [...CONFIGS, ...CONFIGS_TYPED, ...CONFIGS_RULES].find((c) => c.id === id);
  if (!match) throw new Error(`Unknown canonical config id: ${id}`);
  return match;
}

/**
 * Does the canonical config `id` require the full-config rule-engine
 * injection path (`injectionMode: "full-config"`)? SDK parity runners use
 * this to decide between `createFlagOverridesFromConfig` (full-config) and
 * `createFlagOverridesFromMap` (map), and to gate the capability-probe SKIP
 * so a `"full-config"` tuple is NEVER resolved on the flat-map path
 * (SC-004). Throws on an unknown id (fail-fast).
 */
export function requiresFullConfig(id: string): boolean {
  return getConfig(id).injectionMode === "full-config";
}
