// SPDX-License-Identifier: MIT

/**
 * Wire types for ConfigCat's `config_v6.json` payload.
 *
 * This file is the SDK's contract with the CDN. It is intentionally NOT
 * imported from `@confeature/contract` — the management API and the eval
 * payload are two different wire-frozen contracts (plan.md Complexity
 * Tracking, research.md §R7). The shapes below mirror ConfigCat's public
 * `config_v6` schema verbatim; reference:
 *   - https://configcat.com/docs/advanced/config-v6/
 *   - https://github.com/configcat/common-js/blob/master/src/ConfigJson.ts
 *
 * v1 forward-compat: we parse the full type shape but the evaluator only
 * consumes the boolean subset (`f[key].t === 0` + `f[key].v.b`). Targeting
 * rules (`r`), percentage options, and segments (`s`) are parsed as-is
 * but never evaluated.
 */

/** Top-level config envelope — `{p, f, s}`. */
export interface IConfig {
  /** Preferences (CDN metadata). */
  p: IPreferences;
  /** Feature flags / settings, keyed by setting key. */
  f: Record<string, ISetting>;
  /** Segments (empty in v1). */
  s: ISegment[];
}

/** Preferences block. */
export interface IPreferences {
  /** Base URL the SDK should hit next time (CDN-side redirect). */
  u: string;
  /** Redirect mode: 0=NoRedirect, 1=ShouldRedirect, 2=ForceRedirect. */
  r: number;
  /** Salt version (used for percentage options hashing — unused in v1). */
  s: string;
}

/** Setting type discriminator. */
export const SettingType = {
  Boolean: 0,
  String: 1,
  Int: 2,
  Double: 3,
} as const;
export type SettingType = (typeof SettingType)[keyof typeof SettingType];

/** A single setting / feature flag. */
export interface ISetting {
  /** Setting type (0=Boolean, 1=String, 2=Int, 3=Double). */
  t: SettingType;
  /** Setting value envelope. Only `b` is consumed in v1. */
  v: ISettingValue;
  /** Variation id (analytics dedup; not consumed in v1). */
  i: string;
  /** Targeting rules (empty in v1; reserved). */
  r: ITargetingRule[];
  /** Percentage options (empty in v1; reserved). */
  p?: IPercentageOption[];
  /**
   * Percentage-options attribute (config_v6 `a`). Names the user attribute
   * percentage bucketing keys on; when absent, bucketing keys on the user's
   * `Identifier`. Confirmed present at the **setting** level in the vendored
   * config_v6 corpus (e.g. `countryPercentageAttribute` → `a: "Country"`,
   * `customPercentageAttribute` → `a: "Custom1"`). Additive parse-type
   * refinement only — config_v6 stays an opaque CDN payload.
   */
  a?: string;
}

/** Setting value envelope. Exactly one of {b,s,i,d} is set per type. */
export interface ISettingValue {
  /** Boolean value (consumed when `setting.t === SettingType.Boolean`). */
  b?: boolean;
  /** String value. */
  s?: string;
  /** Integer value. */
  i?: number;
  /** Double value. */
  d?: number;
}

/**
 * A served value with its variation id — config_v6 `ServedValue` (`{v, i}`).
 * This is the shape a targeting rule's `s` (then-serve) field and a percentage
 * option carry; it is NOT a bare {@link ISettingValue}. Mirrors common-js
 * `ServedValue` (`ConfigJson.d.ts`).
 */
export interface IServedValue {
  /** The served value envelope. */
  v: ISettingValue;
  /** Variation id of the served value. */
  i: string;
}

/** Targeting rule (config_v6 `TargetingRule`). */
export interface ITargetingRule {
  /** Conditions (AND-grouped; the rule matches iff every condition is true). */
  c: ICondition[];
  /**
   * The value served on match (`ServedValue` = `{v, i}`), present when the
   * rule serves a fixed value. Mutually exclusive with {@link ITargetingRule.p}
   * (a rule serves either a fixed value or percentage options).
   */
  s?: IServedValue;
  /** Percentage options served on match (mutually exclusive with `s`). */
  p?: IPercentageOption[];
  /**
   * Percentage-options attribute (config_v6 `a`) for a rule whose match
   * serves percentage options (`p`). Same default semantics as
   * {@link ISetting.a}: absent → bucket on the user `Identifier`. Carried
   * here because config_v6 permits a rule-level `a` even though the current
   * vendored corpus only exercises the setting-level form.
   */
  a?: string;
}

/** Condition (parsed but never evaluated in v1). */
export interface ICondition {
  /** User comparator (see {@link UserComparator}). */
  u?: IUserCondition;
  /** Prerequisite flag comparator (see {@link PrerequisiteFlagComparator}). */
  p?: IPrerequisiteFlagCondition;
  /** Segment comparator (see {@link SegmentComparator}). */
  s?: ISegmentCondition;
}

export interface IUserCondition {
  a: string;
  c: UserComparator;
  s?: string;
  d?: number;
  l?: string[];
}

export interface IPrerequisiteFlagCondition {
  f: string;
  c: PrerequisiteFlagComparator;
  v: ISettingValue;
}

export interface ISegmentCondition {
  s: number;
  c: SegmentComparator;
}

/** Percentage option (parsed but never matched in v1). */
export interface IPercentageOption {
  p: number;
  v: ISettingValue;
  i: string;
}

/**
 * Segment (config_v6 + legacy v5). A named membership predicate referenced by
 * index from an {@link ISegmentCondition}. Its `r[]` entries are **bare user
 * conditions** ({@link IUserCondition}), AND-grouped — the user is in the
 * segment iff every condition matches. Both the v6 (`testmatrix_segments.csv`)
 * and v5 (`testmatrix_segments_old.csv`) blobs carry this same shape; the
 * sensitive-comparator context salt is the segment **name** `n`.
 */
export interface ISegment {
  n: string;
  r: IUserCondition[];
}

/** User comparator enum (re-exported for compat; not evaluated in v1). */
export const UserComparator = {
  TextIsOneOf: 0,
  TextIsNotOneOf: 1,
  TextContainsAnyOf: 2,
  TextNotContainsAnyOf: 3,
  SemVerIsOneOf: 4,
  SemVerIsNotOneOf: 5,
  SemVerLess: 6,
  SemVerLessOrEquals: 7,
  SemVerGreater: 8,
  SemVerGreaterOrEquals: 9,
  NumberEquals: 10,
  NumberNotEquals: 11,
  NumberLess: 12,
  NumberLessOrEquals: 13,
  NumberGreater: 14,
  NumberGreaterOrEquals: 15,
  SensitiveTextIsOneOf: 16,
  SensitiveTextIsNotOneOf: 17,
  DateTimeBefore: 18,
  DateTimeAfter: 19,
  SensitiveTextEquals: 20,
  SensitiveTextNotEquals: 21,
  SensitiveTextStartsWithAnyOf: 22,
  SensitiveTextNotStartsWithAnyOf: 23,
  SensitiveTextEndsWithAnyOf: 24,
  SensitiveTextNotEndsWithAnyOf: 25,
  SensitiveArrayContainsAnyOf: 26,
  SensitiveArrayNotContainsAnyOf: 27,
  TextEquals: 28,
  TextNotEquals: 29,
  TextStartsWithAnyOf: 30,
  TextNotStartsWithAnyOf: 31,
  TextEndsWithAnyOf: 32,
  TextNotEndsWithAnyOf: 33,
  ArrayContainsAnyOf: 34,
  ArrayNotContainsAnyOf: 35,
} as const;
export type UserComparator = (typeof UserComparator)[keyof typeof UserComparator];

/** Prerequisite flag comparator (not evaluated in v1). */
export const PrerequisiteFlagComparator = {
  Equals: 0,
  NotEquals: 1,
} as const;
export type PrerequisiteFlagComparator =
  (typeof PrerequisiteFlagComparator)[keyof typeof PrerequisiteFlagComparator];

/** Segment comparator (not evaluated in v1). */
export const SegmentComparator = {
  IsIn: 0,
  IsNotIn: 1,
} as const;
export type SegmentComparator = (typeof SegmentComparator)[keyof typeof SegmentComparator];

/**
 * Best-effort runtime validation: does the parsed JSON match the
 * top-level `{p, f, s}` shape? Used by the fetcher to short-circuit
 * PARSE_FAILED. Does NOT type-narrow rules / segments — those are parsed
 * permissively.
 */
export function isConfigShape(value: unknown): value is IConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["p"] !== "object" || v["p"] === null) return false;
  if (typeof v["f"] !== "object" || v["f"] === null) return false;
  if (!Array.isArray(v["s"])) return false;
  return true;
}
