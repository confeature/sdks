// SPDX-License-Identifier: MIT

/**
 * The shared parity corpus.
 *
 * Every Confeature SDK's parity tier iterates over `CORPUS` and asserts
 * that `confeatureSdk.getValue(key, defaultValue, user)` equals
 * `configcatJs.getValue(key, defaultValue, user)` byte-for-byte, given
 * the same canonical config blob loaded via `flagOverrides`.
 *
 * SC-003: 100 % of tuples must pass. The corpus has two **separate**
 * tiers, exported as two distinct arrays and two distinct JSON files:
 *
 *   1. `CORPUS` — the 58-tuple boolean matrix (`build()`): simple
 *      boolean settings (true / false), missing-key fallback, and
 *      TYPE_MISMATCH on a type-disagreeing default. These 58 tuples
 *      are byte-stable: never reordered, never reshaped (FR-011).
 *      Every one of the 21 SDKs runs this corpus.
 *   2. `CORPUS_TYPED` — the `SettingType × value` extension matrix
 *      (`buildTyped()`, spec 066 / #253): `string` (`t: 1`), `int`
 *      (`t: 2`) and `double` (`t: 3`) settings with representative +
 *      edge-case values (empty string, zero, negative,
 *      precision-sensitive double), plus typed TYPE_MISMATCH tuples.
 *      This is a **separate** corpus — NOT appended to `CORPUS`.
 *      Boolean-only SDKs cannot evaluate it; each SDK opts into the
 *      typed corpus only once it implements typed values (#254-#261).
 *
 * The evaluator resolves a setting's value at its declared
 * `SettingType` — the `v` envelope key (`b` / `s` / `i` / `d`) is
 * selected by the setting's `t` discriminator. A `defaultValue` whose
 * JS primitive type disagrees with the setting's type produces a
 * TYPE_MISMATCH and returns the supplied default. The corpus encodes
 * this behaviour so future SDKs cannot regress it.
 */

import type { User } from "@confeature/sdk-shared";

/**
 * One row of the parity corpus.
 */
export interface ParityTuple {
  /** Human-readable label — used in test failures. */
  readonly description: string;
  /** Which canonical config (from `configs.ts`) to load. */
  readonly configId: string;
  /** Flag key to evaluate. */
  readonly key: string;
  /** Default value passed to `getValue`. */
  readonly defaultValue: boolean | string | number | null;
  /** Optional user context. */
  readonly user?: User;
  /** Expected resolved value — what both SDKs MUST return. */
  readonly expected: boolean | string | number | null;
  /**
   * Optional expected variation ID (spec 150 / #395). When set, the runner
   * ALSO asserts `getValueDetails(...).variationId` equals this 8-hex id (the
   * matched rule's `s.i`, the matched percentage option's `i`, or the
   * setting's base `i`). Absent on the existing value-only tuples — those keep
   * the `getValue`-only assertion (additive, no behaviour change).
   */
  readonly expectedVariationId?: string;
}

/** A minimal user with only `identifier` set. */
const identifierOnlyUser: User = {
  identifier: "alice@example.com",
} as unknown as User;

/** A user with full custom attributes — exercises partial-context handling. */
const richUser: User = {
  identifier: "bob@example.com",
  email: "bob@example.com",
  country: "FR",
  custom: { plan: "pro", betaTester: "true" },
} as unknown as User;

/** A user with only an empty-string identifier — edge case. */
const emptyIdentifierUser: User = {
  identifier: "",
} as unknown as User;

/**
 * The Unicode attribute NAME (`🆃🅴🆇🆃`) targeted by every Unicode-comparator
 * tuple (spec 141 / #398). A normalizing attribute-map lookup would miss it.
 */
const UNICODE_TEXT_ATTR = "🆃🅴🆇🆃";

/**
 * Builds a user whose only custom attribute is the Unicode attribute name
 * `🆃🅴🆇🆃` set to `value`. Promoted to a top-level helper so future Unicode
 * specs can reuse it (alongside `identifierOnlyUser` / `richUser` /
 * `emptyIdentifierUser`).
 */
const unicodeUser = (value: string): User =>
  ({ identifier: "1", custom: { [UNICODE_TEXT_ATTR]: value } }) as unknown as User;

const CONFIG = "boolean-basic";

/**
 * Build the corpus. The structure repeats the same three flags across
 * many user / default-value combinations — every combination is a valid
 * tuple. SC-003 minimum: 50 tuples.
 */
function build(): readonly ParityTuple[] {
  const tuples: ParityTuple[] = [];

  // ---- Simple boolean evaluation: cached value wins over default ----
  // Three flags × two default-value polarities × five user variants = 30
  const flags: { key: string; expected: boolean }[] = [
    { key: "feature.dark-mode", expected: true },
    { key: "feature.beta-toggle", expected: false },
    { key: "feature.unused-key", expected: true },
  ];
  const defaults: boolean[] = [false, true];
  const userVariants: { name: string; user: User | undefined }[] = [
    { name: "no-user", user: undefined },
    { name: "identifier-only", user: identifierOnlyUser },
    { name: "rich-user", user: richUser },
    { name: "empty-id", user: emptyIdentifierUser },
    { name: "no-user-again", user: undefined },
  ];

  for (const flag of flags) {
    for (const def of defaults) {
      for (const variant of userVariants) {
        tuples.push({
          description: `${flag.key} returns cached ${String(flag.expected)} (default=${String(def)}, user=${variant.name})`,
          configId: CONFIG,
          key: flag.key,
          defaultValue: def,
          user: variant.user,
          expected: flag.expected,
        });
      }
    }
  }

  // ---- Missing-key fallback: returns default for every user variant ----
  // Two missing keys × two default polarities × five users = 20
  const missingKeys = ["feature.does-not-exist", "feature.absent"];
  for (const key of missingKeys) {
    for (const def of defaults) {
      for (const variant of userVariants) {
        tuples.push({
          description: `${key} (absent) returns default=${String(def)} (user=${variant.name})`,
          configId: CONFIG,
          key,
          defaultValue: def,
          user: variant.user,
          expected: def,
        });
      }
    }
  }

  // ---- TYPE_MISMATCH cases: non-boolean defaults fall back to default ----
  // Two flags × two non-boolean defaults × two user variants = 8
  const typeMismatchFlags = ["feature.dark-mode", "feature.beta-toggle"];
  const nonBooleanDefaults: (string | number)[] = ["string-default", 42];
  const typeMismatchUsers = [
    { name: "no-user", user: undefined },
    { name: "rich-user", user: richUser },
  ];
  for (const key of typeMismatchFlags) {
    for (const def of nonBooleanDefaults) {
      for (const variant of typeMismatchUsers) {
        tuples.push({
          description: `${key} with non-boolean default (${typeof def}) returns default (user=${variant.name})`,
          configId: CONFIG,
          key,
          defaultValue: def,
          user: variant.user,
          expected: def,
        });
      }
    }
  }

  return tuples;
}

const TYPED_CONFIG = "typed-basic";

/**
 * Build the `SettingType × value` extension matrix (spec 066 / #253).
 *
 * One tuple per `SettingType` (`string` / `int` / `double`) with a
 * representative value, the documented edge-case tuples (empty string,
 * zero, negative, precision-sensitive double), and typed TYPE_MISMATCH
 * tuples (a type-disagreeing default falls back to the default). Every
 * tuple references the `typed-basic` canonical config. These rows form
 * the **separate** `CORPUS_TYPED` array — never merged into `CORPUS`
 * (FR-011), so boolean-only SDKs stay on the 58-tuple corpus untouched.
 */
function buildTyped(): readonly ParityTuple[] {
  return [
    // ---- string: representative + edge case ----
    {
      description: "feature.welcome-text (string) resolves to its cached string value",
      configId: TYPED_CONFIG,
      key: "feature.welcome-text",
      defaultValue: "fallback-text",
      expected: "Welcome to Confeature",
    },
    {
      description: "feature.empty-label (string) resolves to the empty string — a real value",
      configId: TYPED_CONFIG,
      key: "feature.empty-label",
      defaultValue: "fallback-text",
      expected: "",
    },
    {
      description: "feature.missing-string (absent) returns string default",
      configId: TYPED_CONFIG,
      key: "feature.missing-string",
      defaultValue: "fallback-text",
      expected: "fallback-text",
    },
    // ---- int: representative + edge cases (zero, negative) ----
    {
      description: "feature.max-retries (int) resolves to its cached integer value",
      configId: TYPED_CONFIG,
      key: "feature.max-retries",
      defaultValue: -1,
      expected: 5,
    },
    {
      description: "feature.zero-quota (int) resolves to zero — a real value, not missing",
      configId: TYPED_CONFIG,
      key: "feature.zero-quota",
      defaultValue: -1,
      expected: 0,
    },
    {
      description: "feature.offset-days (int) resolves to a negative integer",
      configId: TYPED_CONFIG,
      key: "feature.offset-days",
      defaultValue: 0,
      expected: -3,
    },
    // ---- double: representative + edge cases (zero, negative, precision) ----
    {
      description: "feature.sample-rate (double) resolves to its cached fractional value",
      configId: TYPED_CONFIG,
      key: "feature.sample-rate",
      defaultValue: 1,
      expected: 0.25,
    },
    {
      description: "feature.zero-threshold (double) resolves to zero — a real value, not missing",
      configId: TYPED_CONFIG,
      key: "feature.zero-threshold",
      defaultValue: 1,
      expected: 0,
    },
    {
      description: "feature.temperature-floor (double) resolves to a negative double",
      configId: TYPED_CONFIG,
      key: "feature.temperature-floor",
      defaultValue: 0,
      expected: -273.15,
    },
    {
      description: "feature.precision-sum (double) resolves to a precision-sensitive double",
      configId: TYPED_CONFIG,
      key: "feature.precision-sum",
      defaultValue: 0,
      expected: 0.30000000000000004,
    },
    // ---- typed TYPE_MISMATCH: a type-disagreeing default falls back ----
    {
      description:
        "feature.welcome-text (string) with a number default returns default (TYPE_MISMATCH)",
      configId: TYPED_CONFIG,
      key: "feature.welcome-text",
      defaultValue: 0,
      expected: 0,
    },
    {
      description:
        "feature.max-retries (int) with a string default returns default (TYPE_MISMATCH)",
      configId: TYPED_CONFIG,
      key: "feature.max-retries",
      defaultValue: "not-a-number",
      expected: "not-a-number",
    },
    {
      description:
        "feature.sample-rate (double) with a string default returns default (TYPE_MISMATCH)",
      configId: TYPED_CONFIG,
      key: "feature.sample-rate",
      defaultValue: "not-a-number",
      expected: "not-a-number",
    },
  ];
}

const RULES_CONFIG = "rules-basic";

/**
 * Build the targeting-rule corpus (spec 135 / #383). Ports ConfigCat's
 * `1_targeting_rule.json` (key `stringContainsDogDefaultCat`, one
 * `Email CONTAINS @configcat.com → Dog` rule) and `2_targeting_rules.json`
 * (key `stringIsInDogDefaultCat`, two first-match-wins `IS ONE OF` rules)
 * from the vendored upstream evaluationlog. Each tuple's `expected` is the
 * upstream `returnValue`; the upstream `user` (Identifier / Email / Custom)
 * maps onto the corpus `User` shape.
 *
 * Spec 136 / #384 extends this with the remaining text comparators — EQUALS,
 * NOT EQUALS, STARTS WITH, ENDS WITH and IS NOT ONE OF — each in cleartext AND
 * SHA-256 sensitive (hashed) form, ported 1:1 from
 * `fixtures/upstream/testmatrix_comparators_v6.csv` (and `testmatrix.csv` for
 * `stringIsNotInDogDefaultCat`). The hashed comparison values are pre-hashed
 * against this config's salt `p.s`; each hashed tuple is the salt-drop canary
 * for its cleartext twin (same logical match → same outcome). Appended after
 * the existing 8 tuples (byte-stability, FR-006).
 *
 * Spec 137 / #389 further extends this with the six number comparators —
 * NumberEquals (10), NumberNotEquals (11), NumberLess (12), NumberLessOrEquals
 * (13), NumberGreater (14), NumberGreaterOrEquals (15) — on the numeric
 * `Custom1` attribute, ported 1:1 from `fixtures/upstream/testmatrix_number.csv`
 * (the `number` and `numberWithPercentage` columns). Thresholds live in the
 * condition's `d` (double) field. Includes the locale-independent decimal-parse
 * canary: `0` / `0.0` / `0,0` (and int-vs-double pairs) MUST resolve
 * identically. The `numberWithPercentage` flag's number rules are asserted
 * here; its pure percentage-bucketing rows are deferred to #385 (research R6).
 * Appended after the existing 38 tuples (byte-stability, FR-005).
 *
 * Spec 138 / #388 further extends this with the six semver comparators —
 * SemVerIsOneOf (4), SemVerIsNotOneOf (5), SemVerLess (6), SemVerLessOrEquals
 * (7), SemVerGreater (8), SemVerGreaterOrEquals (9) — on the `Custom1` /
 * `AppVersion` attributes, ported 1:1 from
 * `fixtures/upstream/testmatrix_semantic.csv` (isOneOf / isNotOneOf /
 * relations) and `testmatrix_semantic_2.csv` (the precedenceTests ordering
 * chain). The comparison value lives in each condition's `s` (string, single)
 * / `l` (string-list, sets) field — NOT `d`. The IS-ONE-OF lists keep the
 * upstream stray whitespace verbatim so the trim-parity is exercised. The
 * curated precedence subset (research R5) covers every distinct ordering
 * behaviour: numeric-vs-alphanumeric prerelease identifiers,
 * fewer-identifiers-precede, prerelease-below-release, major/minor/patch
 * ordering, build-metadata-ignored and `<=`/`=` boundary inclusion. Appended
 * after the existing 68 tuples (byte-stability, FR-005).
 *
 * Spec 139 / #391 completes the SHA-256-salted sensitive family with the
 * three comparators #384 left out — SensitiveTextIsOneOf (16, positive),
 * SensitiveTextNotStartsWithAnyOf (23) and SensitiveTextNotEndsWithAnyOf (25)
 * — plus the multi-attribute `isOneOfSensitive` (16) / `isNotOneOfSensitive`
 * (17) cases ported 1:1 from `fixtures/upstream/testmatrix_sensitive.csv`
 * (identifier / email / country, first-match-wins, Hungarian-animal served
 * values). Every comparison value is pre-hashed `SHA-256(value + p.s +
 * <setting-key>)`, computed programmatically via `sdk-shared/src/hash.ts`
 * (NEVER hand-authored — the #388 lesson); the NotStartsWith/NotEndsWith
 * entries carry the `<byte-length>_<hash>` encoding. Appended after the
 * existing 95 tuples (byte-stability, FR-005).
 *
 * Spec 140 / #393 adds the array comparators — ArrayContainsAnyOf (34),
 * ArrayNotContainsAnyOf (35) in cleartext and SensitiveArrayContainsAnyOf
 * (26), SensitiveArrayNotContainsAnyOf (27) in SHA-256-salted form — plus the
 * two case-check settings (`arrayContainsCaseCheckDogDefaultCat` 26 /
 * `arrayDoesNotContainCaseCheckDogDefaultCat` 27), ported 1:1 from the
 * `stringArray*` and `arrayContainsCaseCheck*` columns of
 * `fixtures/upstream/testmatrix_comparators_v6.csv`. The targeted attribute
 * `Custom1` is a **JSON-array string** (e.g. `["read","execute"]`) that the
 * engine parses before testing membership. The cleartext lists are verbatim
 * upstream (`["read","write","execute"]`); the sensitive list entries are
 * pre-hashed `SHA-256(value + p.s + <setting-key>)`, computed programmatically
 * via `sdk-shared/src/hash.ts` (NEVER hand-authored — the #388 lesson). The
 * case-check rows prove cleartext-array membership is case-sensitive (`Read` in
 * the operand does not match `read` in the array). Appended after the existing
 * 118 tuples (byte-stability, FR-005).
 *
 * Spec 141 / #398 adds the Unicode-comparator coverage — the highest
 * cross-SDK normalization risk — across the text + array comparators
 * (cleartext + hashed): TextEquals (28 / 20), IsOneOf (0 / 16) and
 * ArrayContainsAnyOf (34 / 26), ALL targeting the Unicode attribute NAME
 * `🆃🅴🆇🆃`, ported 1:1 from a representative subset of
 * `fixtures/upstream/testmatrix_unicode.csv`. It exercises the four distinct
 * Unicode behaviours (FR-007): the Unicode attribute-name lookup itself, an
 * accent/case-folding pair (`ÁRVÍZTŰRŐ tükörfúrógép` vs `árvíztűrő
 * tükörfúrógép` — cleartext is case-SENSITIVE, so they differ), a
 * surrogate-pair pair (`u𝖓𝖎𝖈𝖔𝖉e` vs `u𝖓𝖎𝖈𝖔𝖉𝖊`, mathematical-bold — exact
 * code-unit comparison, no normalization), and a Unicode-array value. The
 * hashed operands are `SHA-256(utf8(value) + p.s + <setting-key>)` over the
 * EXACT UTF-8 bytes of the Unicode value, computed via `sdk-shared/src/hash.ts`
 * (NEVER transliterated/simplified — the #388 lesson). Appended after the
 * existing 136 tuples (byte-stability, FR-004/005).
 *
 * The #398 review (nit, MEDIUM) closed the hashed-array surrogate-pair
 * coverage gap by adding one tuple for `boolArrayContainsHashed` on CSV row 12
 * (`["ÁRVÍZTŰRŐ", "tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]` → Dog): the surrogate-pair
 * member `u𝖓𝖎𝖈𝖔𝖉e` is already in the setting's hashed operand list (no new
 * hash), exercising the highest-risk path — a surrogate pair through the
 * HASHED array comparator. Inserted in CSV order (between rows 11 and 13).
 *
 * Spec 142 / #386 adds the AND/OR condition-group DIMENSION (not a comparator
 * family): an `emailAnd` setting (ONE rule with THREE AND conditions — Email
 * STARTS WITH `jane` AND CONTAINS `@` AND ENDS WITH `sensitivecompany.com` →
 * Dog, all-must-match) and an `emailOr` setting (THREE first-match-wins rules —
 * Email STARTS WITH `jane@` → Jane, `john@` → John, `mark@` → Mark, else Cat),
 * ported 1:1 from the `emailAnd` / `emailOr` columns of
 * `testmatrix_and_or.csv` and the AND-rule shape in
 * `evaluationlog/and_rules.json` / `content-by-key.json`. Covers AND all-match
 * (served Dog), AND one-condition-fails (short-circuit → base Cat, both the
 * leading STARTS-WITH and the trailing ENDS-WITH failures), OR each
 * first-match branch (Jane / John / Mark) and OR none-match (Cat). The
 * sensitive operands are re-hashed `SHA-256(value + p.s + <setting-key>)`
 * (`<byte-length>_<hash>` encoding) — never hand-authored (the #388 lesson).
 * Appended after the existing 154 tuples (byte-stability, FR-004).
 *
 * Spec 143 / #392 adds the datetime comparators — DateTimeBefore (18),
 * DateTimeAfter (19) on a Unix-epoch `Date` attribute — ported 1:1 from the
 * vendored `content-by-key.json` `allinone` setting (the
 * `Date BEFORE 1693497600 AND Date AFTER 1693497600 → "12"` rule, base
 * "default") and the `evaluationlog/comparators.json` `allinone` case (user
 * `Date: "1693497500"` → "default"). The source AND-rule is split into two
 * single-comparator settings (`datetimeBeforeDogDefaultCat` /
 * `datetimeAfterDogDefaultCat`), each carrying the EXACT upstream threshold
 * (1693497600), served value ("12") and base ("default"). The epoch threshold
 * lives in each condition's `d` (double) field; the `Date` attribute is a
 * STRING Unix-epoch on user.custom exactly as ConfigCat feeds it
 * (`"1693497500"`). Each comparator gets holds / does-not-hold / boundary
 * (Date == threshold, strict → excluded) plus the epoch-parse edge cases —
 * a FRACTIONAL-seconds value (`...500.5` / `...700.5`, exact double, no
 * truncation) and an int-vs-double pair (`...500` vs `...500.0`) that MUST
 * resolve identically (FR-004). Appended after the existing 163 tuples
 * (byte-stability, FR-005).
 *
 * Spec 144 / #394 adds comparison-attribute & comparison-VALUE trimming, a
 * representative subset (FR-007) ported 1:1 from the vendored
 * `comparison_attribute_trimming.json` / `comparison_value_trimming.json`
 * fixtures: an attribute-trimming case (SemVerGreater 8, whitespace-bearing
 * attribute `" 0.2.0 "` trimmed before parse) and a comparison-value-trimming
 * case (SemVerGreater 8 whose stored comparison value keeps the surrounding
 * whitespace `" 0.1.1 "` verbatim — the #388 keep-whitespace lesson — and is
 * trimmed by the engine). Semver (number/date) comparators trim both sides; the
 * text comparators do NOT. Appended after the existing 175 tuples
 * (byte-stability, FR-004).
 *
 * Spec 145 / #390 adds the segment-condition DIMENSION (not a comparator
 * family): IS-IN-SEGMENT (c:0) and IS-NOT-IN-SEGMENT (c:1) referencing the
 * config's now non-empty top-level `s[]`. Two segments are ported 1:1 from the
 * vendored `content-by-key.json` segment config + `testmatrix_segments.csv`: a
 * HASHED `Developers` segment (Email IS-ONE-OF {kate@, john@}, comparator 16)
 * and a cleartext `Beta Users (cleartext)` segment (Email IS-ONE-OF
 * {jane@, john@}, comparator 0). Three single-segment-condition settings
 * reference them (`segDeveloperIsInDogDefaultCat`,
 * `segBetaCleartextIsInDogDefaultCat`, `segDeveloperIsNotInDogDefaultCat`). The
 * CRITICAL salt rule (spec-128/129): a hashed condition INSIDE a segment salts
 * with the SEGMENT NAME, not the setting key — the `Developers` operands are
 * `SHA-256(value + p.s + "Developers")`, computed via `sdk-shared/src/hash.ts`
 * `hashComparisonValue` (NEVER hand-authored). Covers IS-IN in→served /
 * not-in→fallback for the hashed AND the cleartext segment, plus IS-NOT-IN
 * (inversion: not-in→served, in→fallback), plus the no-user error (returned
 * un-negated so IS-NOT-IN does NOT flip it into a match → base value). Only
 * STRING user attributes are used. Appended after the existing 177 tuples
 * (byte-stability, FR-004).
 *
 * Spec 146 / #385 adds the percentage-rollout DIMENSION (deterministic
 * hash-bucketing, not a comparator family): the `string75Cat0Dog25Falcon0Horse`
 * setting (a setting-level `p[]` percentage-options array — Cat 75% [0,75) /
 * Dog 0% / Falcon 25% [75,100) / Horse 0%, base served "Chicken"), ported 1:1
 * from the canonical `content-by-key.json` config + the (Identifier →
 * returnValue) cases in `evaluationlog/options_based_on_user_id.json`. The
 * served option is the DETERMINISTIC bucket `parseInt(sha1(settingKey +
 * Identifier).substring(0,7), 16) % 100` accumulated across option widths —
 * UNSALTED (percentage bucketing does NOT use `p.s`, unlike the sensitive
 * comparators). Covers ≥2 Identifiers landing in DIFFERENT options (Identifier
 * "12345" → bucket 21 → Cat, matching the upstream returnValue exactly;
 * Identifier "0" → bucket 88 → Falcon, exercising the cumulative-range mapping
 * past the Dog 0%-width boundary) plus the no-user fallback (→ base "Chicken").
 * Only the STRING Identifier attribute is used (#468). Appended after the
 * existing 186 tuples (byte-stability, FR-005).
 *
 * Spec 147 / #397 adds the percentage-option PLACEMENT variants (where the
 * `p[]` block sits / which attribute keys the bucket), ported 1:1 from the
 * three vendored `evaluationlog/options_*` fixtures + their canonical configs
 * (`content-by-key.json` / `evaluationlog/_configs-by-key.json`). Bucketing is
 * the same UNSALTED `parseInt(sha1(settingKey + attrValue).substring(0,7), 16)
 * % 100` accumulated across option widths — so the upstream returnValues (which
 * depend only on settingKey + attrValue, never the config salt) transfer
 * verbatim even though the corpus config carries a different `p.s`. Three
 * placements, each appended after the existing 189 tuples (byte-stability,
 * FR-004):
 *   - AFTER-rule: `integer25One25Two25Three25FourAdvancedRules` (int, options
 *     One/Two/Three/Four 25% each, a rule Email CONTAINS "@configcat.com" →
 *     fixed 5, base -1). When the rule FAILS the setting-level `p[]` is served;
 *     when it MATCHES the rule's fixed value wins. Identifier "12345" + a
 *     non-matching Email → bucket 25 ∈ [25,50) → Two → 5… i.e. → 2; the matching
 *     Email → rule's fixed 5 (the rule wins, no bucketing); no user → base -1.
 *   - WITHIN-rule: `stringContainsString75Cat0Dog25Falcon0HorseDefaultCat`
 *     (string, `a`=Country, base "Cat", a rule Email CONTAINS "@configcat.com"
 *     whose served value is itself a `r[].p` split Cat 75% [0,75) / Falcon 25%
 *     [75,100)). The matched rule serves a PERCENTAGE split keyed by Country:
 *     Country "US" → bucket 70 ∈ [0,75) → Cat (matches upstream); Country "JP"
 *     → bucket 80 ∈ [75,100) → Falcon (a DIFFERENT served value than the base
 *     "Cat", so the within-rule split is proven distinctly); no rule-match
 *     (Email not "@configcat.com") → base "Cat".
 *   - BY-CUSTOM-ATTR: `string75Cat0Dog25Falcon0HorseCustomAttr` (string,
 *     `a`=Country selects the bucketing attribute, setting-level `p[]` Cat 75%
 *     [0,75) / Falcon 25% [75,100), base "Chicken"). Bucket keyed by Country
 *     (NOT Identifier): Country "US" → bucket 70 ∈ [0,75) → Cat (matches
 *     upstream); Country "DE" → bucket 79 ∈ [75,100) → Falcon (different
 *     option); missing Country attr → no bucket → base "Chicken" (upstream
 *     `no_options_custom_attribute` case). Only STRING user attributes are used
 *     (#468).
 *
 * Spec 149 / #396 adds the attribute-validation ERROR-path coverage — a
 * MALFORMED user attribute for a number / semver / datetime comparator makes
 * the attribute→typed conversion error, which the engine treats as the rule
 * NOT matching (fall through to the next rule / served fallback; NOT a crash,
 * NOT a spurious match). Ported 1:1 from `evaluationlog/number_validation.json`
 * (key `number`, Custom1="not_a_number" → "Default"), `semver_validation.json`
 * (keys `isNotOneOf` AND `relations`, Custom1="wrong_semver" → "Default") and
 * `epoch_date_validation.json` (a dotted-date attribute → invalid Unix
 * timestamp → fallback, fed to the existing `datetimeBeforeDogDefaultCat` rule
 * → base "default"), plus the long-list / truncation resolution case from
 * `list_truncation.json` + `_overrides/test_list_truncation.json` (`booleanKey1`,
 * three AND `Identifier CONTAINS ANY OF <long list>` conditions, Identifier="12"
 * → every list matches → rule serves true; truncation is log-only, never a
 * resolution concern). STRING (malformed) attributes only (#468). Appended
 * after the existing 205 tuples (byte-stability, FR-004).
 *
 * SCOPE NOTE: non-string-attribute CONVERSION coverage (number→string,
 * date→string, array→string) is DEFERRED to the typed-user-attributes
 * prerequisite feature. Those cases require TYPED user attributes (number /
 * Date / array), but the 14 non-JS SDK ports model custom attributes as
 * STRING-ONLY (`HashMap<String,String>` etc.), so a number/array attribute
 * fails to even deserialize the corpus on the string-only runners (rust:
 * `invalid type: integer 125, expected a string`; elixir: array case). The
 * remaining tuples here use ONLY plain string user attributes, so every
 * string-only SDK runner deserializes and resolves them.
 *
 * A **separate** corpus — NOT merged into `CORPUS` / `CORPUS_TYPED`
 * (FR-006 byte-stability). It is injected through the full-config rule
 * engine (`createFlagOverridesFromConfig`), never the flat-map path.
 */
function buildRules(): readonly ParityTuple[] {
  // ---- 1_targeting_rule: Email CONTAINS @configcat.com → Dog (else Cat) ----
  const oneRule: ParityTuple[] = [
    {
      description: "stringContainsDogDefaultCat: no user → base value Cat (rule needs a user)",
      configId: RULES_CONFIG,
      key: "stringContainsDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringContainsDogDefaultCat: identifier only, no Email → no targeted attribute → Cat",
      configId: RULES_CONFIG,
      key: "stringContainsDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        "stringContainsDogDefaultCat: Email joe@example.com does not CONTAIN @configcat.com → Cat",
      configId: RULES_CONFIG,
      key: "stringContainsDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@example.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        "stringContainsDogDefaultCat: Email joe@configcat.com CONTAINS @configcat.com → rule serves Dog",
      configId: RULES_CONFIG,
      key: "stringContainsDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@configcat.com" } as unknown as User,
      expected: "Dog",
    },
  ];

  // ---- 2_targeting_rules: two first-match-wins IS-ONE-OF rules ----
  // Rule 1: Email IS ONE OF [a@configcat.com, b@configcat.com] → Dog
  // Rule 2: Custom1 IS ONE OF [admin] → Dog ; else base Cat.
  const twoRules: ParityTuple[] = [
    {
      description: "stringIsInDogDefaultCat: no user → base value Cat",
      configId: RULES_CONFIG,
      key: "stringIsInDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description: "stringIsInDogDefaultCat: identifier only, no targeted attribute → Cat",
      configId: RULES_CONFIG,
      key: "stringIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        "stringIsInDogDefaultCat: Custom1=user matches neither rule (precedence/no-match) → Cat",
      configId: RULES_CONFIG,
      key: "stringIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: "user" } } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        "stringIsInDogDefaultCat: Custom1=admin matches the second rule → rule serves Dog",
      configId: RULES_CONFIG,
      key: "stringIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: "admin" } } as unknown as User,
      expected: "Dog",
    },
  ];

  // ---- Text-comparator matrix (spec 136 / #384): EQUALS, NOT EQUALS,
  //      STARTS WITH, ENDS WITH, IS NOT ONE OF — each cleartext + SHA-256
  //      sensitive (hashed). Ported 1:1 from the vendored
  //      `testmatrix_comparators_v6.csv` (EQUALS / NOT EQUALS / STARTS WITH /
  //      ENDS WITH columns) and `testmatrix.csv` (`stringIsNotInDogDefaultCat`).
  //      Each cleartext/hashed twin shares the same logical match and outcome —
  //      the salt-drop canary (the hashed operand only resolves when `p.s`
  //      reaches the comparator via the full-config path). Every `expected`
  //      traces to an upstream row (FR-002). Email is the targeted attribute.
  const textComparators: ParityTuple[] = [
    // ---- EQUALS: Email == a@configcat.com → Dog (else Cat) ----
    // upstream rows: Email="" → Cat; a@configcat.com → Dog; b@configcat.com → Cat
    {
      description: "stringEqualsCleartextDogDefaultCat (EQUALS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringEqualsCleartextDogDefaultCat (EQUALS): Email a@configcat.com equals operand → Dog",
      configId: RULES_CONFIG,
      key: "stringEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringEqualsCleartextDogDefaultCat (EQUALS): Email b@configcat.com not equal → Cat",
      configId: RULES_CONFIG,
      key: "stringEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "b@configcat.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description: "stringEqualsDogDefaultCat (sensitive EQUALS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringEqualsDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringEqualsDogDefaultCat (sensitive EQUALS): Email a@configcat.com hash equals → Dog",
      configId: RULES_CONFIG,
      key: "stringEqualsDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringEqualsDogDefaultCat (sensitive EQUALS): Email b@configcat.com hash not equal → Cat",
      configId: RULES_CONFIG,
      key: "stringEqualsDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "b@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- NOT EQUALS: Email != b@configcat.com → Dog (else Cat) ----
    // upstream rows: Email="" → Cat; a@configcat.com → Dog; b@configcat.com → Cat
    {
      description: "stringNotEqualsCleartextDogDefaultCat (NOT EQUALS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringNotEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringNotEqualsCleartextDogDefaultCat (NOT EQUALS): Email a@configcat.com != b@configcat.com → Dog",
      configId: RULES_CONFIG,
      key: "stringNotEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringNotEqualsCleartextDogDefaultCat (NOT EQUALS): Email b@configcat.com equals operand → Cat",
      configId: RULES_CONFIG,
      key: "stringNotEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "b@configcat.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description: "stringDoseNotEqualDogDefaultCat (sensitive NOT EQUALS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringDoseNotEqualDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringDoseNotEqualDogDefaultCat (sensitive NOT EQUALS): Email a@configcat.com hash != → Dog",
      configId: RULES_CONFIG,
      key: "stringDoseNotEqualDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringDoseNotEqualDogDefaultCat (sensitive NOT EQUALS): Email b@configcat.com hash equals → Cat",
      configId: RULES_CONFIG,
      key: "stringDoseNotEqualDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "b@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- STARTS WITH: Email startsWith [u@, a@, b@] → Dog (else Cat) ----
    // upstream rows: Email="" → Cat; a@configcat.com → Dog; b@configcat.com → Dog; c@configcat.com → Cat
    {
      description: "stringStartsWithAnyOfCleartextDogDefaultCat (STARTS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringStartsWithAnyOfCleartextDogDefaultCat (STARTS WITH): Email a@configcat.com starts with a@ → Dog",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringStartsWithAnyOfCleartextDogDefaultCat (STARTS WITH): Email c@configcat.com matches no prefix → Cat",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "c@configcat.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description: "stringStartsWithAnyOfDogDefaultCat (sensitive STARTS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringStartsWithAnyOfDogDefaultCat (sensitive STARTS WITH): Email a@configcat.com hashed prefix a@ → Dog",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringStartsWithAnyOfDogDefaultCat (sensitive STARTS WITH): Email c@configcat.com no hashed prefix → Cat",
      configId: RULES_CONFIG,
      key: "stringStartsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "c@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- ENDS WITH: Email endsWith [@verizon.com, @verizon.net, @aol.com] → Dog (else Cat) ----
    // upstream rows: Email="" → Cat; bogjobber@verizon.net → Dog; cliffordj@aol.com → Dog; a@configcat.com → Cat
    {
      description: "stringEndsWithAnyOfCleartextDogDefaultCat (ENDS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringEndsWithAnyOfCleartextDogDefaultCat (ENDS WITH): Email bogjobber@verizon.net ends with @verizon.net → Dog",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "bogjobber@verizon.net" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringEndsWithAnyOfCleartextDogDefaultCat (ENDS WITH): Email a@configcat.com matches no suffix → Cat",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description: "stringEndsWithAnyOfDogDefaultCat (sensitive ENDS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringEndsWithAnyOfDogDefaultCat (sensitive ENDS WITH): Email cliffordj@aol.com hashed suffix @aol.com → Dog",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "cliffordj@aol.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringEndsWithAnyOfDogDefaultCat (sensitive ENDS WITH): Email a@configcat.com no hashed suffix → Cat",
      configId: RULES_CONFIG,
      key: "stringEndsWithAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- IS NOT ONE OF: Email NOT ONE OF [a@configcat.com, b@configcat.com] → Dog (else Cat) ----
    // upstream rows (testmatrix.csv stringIsNotInDogDefaultCat):
    //   Email="" → Cat (missing attr, rule does not match); a@configcat.com (in set) → Cat;
    //   c@configcat.com (not in set) → Dog
    {
      description: "stringIsNotInCleartextDogDefaultCat (IS NOT ONE OF): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringIsNotInCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringIsNotInCleartextDogDefaultCat (IS NOT ONE OF): Email c@configcat.com not in set → Dog",
      configId: RULES_CONFIG,
      key: "stringIsNotInCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "c@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringIsNotInCleartextDogDefaultCat (IS NOT ONE OF): Email a@configcat.com in set → Cat",
      configId: RULES_CONFIG,
      key: "stringIsNotInCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description: "stringIsNotInHashedDogDefaultCat (sensitive IS NOT ONE OF): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringIsNotInHashedDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "stringIsNotInHashedDogDefaultCat (sensitive IS NOT ONE OF): Email c@configcat.com hash not in set → Dog",
      configId: RULES_CONFIG,
      key: "stringIsNotInHashedDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "c@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "stringIsNotInHashedDogDefaultCat (sensitive IS NOT ONE OF): Email a@configcat.com hash in set → Cat",
      configId: RULES_CONFIG,
      key: "stringIsNotInHashedDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Cat",
    },
  ];

  // ---- Number-comparator matrix (spec 137 / #389): NumberEquals (10),
  //      NumberNotEquals (11), NumberLess (12), NumberLessOrEquals (13),
  //      NumberGreater (14), NumberGreaterOrEquals (15). Ported 1:1 from the
  //      vendored `testmatrix_number.csv` (the `number` and
  //      `numberWithPercentage` columns) on the numeric `Custom1` attribute.
  //      The threshold lives in each condition's `d` (double) field — locale-
  //      free in JSON. Every `expected` traces to an upstream row (FR-002).
  //
  //      `number` is the single `<>5` (NumberNotEquals, threshold 5) setting:
  //      serves "<>5" when Custom1 != 5, else base "Default".
  //
  //      `numberWithPercentage` is a first-match-wins chain over all six
  //      comparators (`<2.1`, `<=2,1`, `=3.5`, `>=5`, `>5`, `<>4.2`), capped
  //      with a 20/80 percentage block. We assert only the deterministic
  //      number-rule outcomes here; the `4.2`/`4,2` rows fall through to the
  //      percentage bucket (`80%`/`20%`) — a bucketing-only outcome deferred
  //      to #385 (research R6), so those two rows are intentionally omitted.
  //
  //      Parse canary (FR-004): the SAME logical value written as `0` / `0.0`
  //      / `0,0` MUST yield the identical `expected` (locale-independent
  //      decimal parse), and an int-vs-double pair (`1` vs `1.0`, `5` vs
  //      `5.0`) MUST resolve identically. Custom1 is supplied as a STRING (the
  //      coercion-to-number path the comparator exercises), mirroring how
  //      ConfigCat's matrix feeds the attribute. Appended after the existing
  //      38 tuples (byte-stability, FR-005).
  const numberComparators: ParityTuple[] = [
    // ---- number: NumberNotEquals 5 → "<>5" (else base "Default") ----
    // upstream `number` column: Custom1=5/5.0/5,0 → Default; everything else → <>5
    {
      description: "number (NumberNotEquals 5): no user → base Default (rule needs Custom1)",
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      expected: "Default",
    },
    {
      description: "number (NumberNotEquals 5): Custom1=6 != 5 → rule serves <>5",
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id", custom: { Custom1: "6" } } as unknown as User,
      expected: "<>5",
    },
    {
      description:
        "number (NumberNotEquals 5): Custom1=5 equals threshold (boundary) → base Default",
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id12", custom: { Custom1: "5" } } as unknown as User,
      expected: "Default",
    },
    {
      description:
        'number (NumberNotEquals 5): Custom1="5.0" equals 5 (int-vs-double, same as "5") → base Default',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id13", custom: { Custom1: "5.0" } } as unknown as User,
      expected: "Default",
    },
    {
      description:
        'number (NumberNotEquals 5): Custom1="5,0" equals 5 (comma-decimal, same as "5.0") → base Default',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id14", custom: { Custom1: "5,0" } } as unknown as User,
      expected: "Default",
    },
    // parse canary: Custom1 written as 0 / 0.0 / 0,0 all parse to zero, 0 != 5 → <>5
    {
      description: 'number parse canary: Custom1="0" → 0 != 5 → <>5',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0" } } as unknown as User,
      expected: "<>5",
    },
    {
      description: 'number parse canary: Custom1="0.0" → 0 != 5 → <>5 (same as "0")',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0.0" } } as unknown as User,
      expected: "<>5",
    },
    {
      description: 'number parse canary: Custom1="0,0" → 0 != 5 → <>5 (comma-decimal, same as "0")',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0,0" } } as unknown as User,
      expected: "<>5",
    },

    // ---- numberWithPercentage: first-match-wins over all six comparators ----

    // NumberLess (12), threshold 2.1 → "<2.1"
    // upstream rows: Custom1 in {0,0.2,1,1.0,1.5,...} (all < 2.1) → <2.1
    {
      description: "numberWithPercentage (NumberLess 2.1): Custom1=1.5 < 2.1 → <2.1",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id6", custom: { Custom1: "1.5" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description:
        'numberWithPercentage (NumberLess 2.1): Custom1="1,5" < 2.1 (comma-decimal, same as "1.5") → <2.1',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id7", custom: { Custom1: "1,5" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description: "numberWithPercentage (NumberLess 2.1): Custom1=0.2 < 2.1 → <2.1",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id_a", custom: { Custom1: "0.2" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description:
        'numberWithPercentage (NumberLess 2.1): Custom1="0,2" < 2.1 (comma-decimal, same as "0.2") → <2.1',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id2", custom: { Custom1: "0,2" } } as unknown as User,
      expected: "<2.1",
    },
    // int-vs-double parse pair: Custom1=1 and Custom1=1.0 both < 2.1 → <2.1 (identical)
    {
      description: 'numberWithPercentage int-vs-double: Custom1="1" → <2.1',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id3", custom: { Custom1: "1" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description: 'numberWithPercentage int-vs-double: Custom1="1.0" → <2.1 (same as "1")',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id4", custom: { Custom1: "1.0" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description:
        'numberWithPercentage parse canary: Custom1="1,0" → <2.1 (comma-decimal, same as "1.0")',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id5", custom: { Custom1: "1,0" } } as unknown as User,
      expected: "<2.1",
    },
    // parse canary on the percentage flag: 0 / 0.0 / 0,0 all < 2.1 → <2.1
    {
      description: 'numberWithPercentage parse canary: Custom1="0" → <2.1',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description: 'numberWithPercentage parse canary: Custom1="0.0" → <2.1 (same as "0")',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0.0" } } as unknown as User,
      expected: "<2.1",
    },
    {
      description:
        'numberWithPercentage parse canary: Custom1="0,0" → <2.1 (comma-decimal, same as "0")',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0,0" } } as unknown as User,
      expected: "<2.1",
    },

    // NumberLessOrEquals (13), threshold 2.1 → "<=2,1" (boundary: 2.1 included)
    // upstream rows: Custom1=2.1 / 2,1 → <=2,1
    {
      description:
        "numberWithPercentage (NumberLessOrEquals 2.1): Custom1=2.1 equals threshold (boundary, < excluded → <= holds) → <=2,1",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id8", custom: { Custom1: "2.1" } } as unknown as User,
      expected: "<=2,1",
    },
    {
      description:
        'numberWithPercentage (NumberLessOrEquals 2.1): Custom1="2,1" boundary (comma-decimal, same as "2.1") → <=2,1',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id9", custom: { Custom1: "2,1" } } as unknown as User,
      expected: "<=2,1",
    },

    // NumberEquals (10), threshold 3.5 → "=3.5"
    // upstream rows: Custom1=3.50 / 3,50 → =3.5
    {
      description: "numberWithPercentage (NumberEquals 3.5): Custom1=3.50 == 3.5 → =3.5",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id10", custom: { Custom1: "3.50" } } as unknown as User,
      expected: "=3.5",
    },
    {
      description:
        'numberWithPercentage (NumberEquals 3.5): Custom1="3,50" == 3.5 (comma-decimal, same as "3.50") → =3.5',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id11", custom: { Custom1: "3,50" } } as unknown as User,
      expected: "=3.5",
    },

    // NumberGreaterOrEquals (15), threshold 5 → ">=5" (boundary: 5 included)
    // upstream rows: Custom1=5 / 5.0 / 5,0 → >=5
    {
      description:
        "numberWithPercentage (NumberGreaterOrEquals 5): Custom1=5 equals threshold (boundary, >= holds, > excluded) → >=5",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id12", custom: { Custom1: "5" } } as unknown as User,
      expected: ">=5",
    },
    {
      description:
        'numberWithPercentage (NumberGreaterOrEquals 5): Custom1="5.0" boundary (int-vs-double, same as "5") → >=5',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id13", custom: { Custom1: "5.0" } } as unknown as User,
      expected: ">=5",
    },
    {
      description:
        'numberWithPercentage (NumberGreaterOrEquals 5): Custom1="5,0" boundary (comma-decimal, same as "5.0") → >=5',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id14", custom: { Custom1: "5,0" } } as unknown as User,
      expected: ">=5",
    },

    // NumberGreater (14), threshold 5 → ">5" (boundary: 5 excluded → caught by >=5 above)
    // upstream rows: Custom1=5.76 / 5,76 → >5
    {
      description: "numberWithPercentage (NumberGreater 5): Custom1=5.76 > 5 → >5",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id13", custom: { Custom1: "5.76" } } as unknown as User,
      expected: ">5",
    },
    {
      description:
        'numberWithPercentage (NumberGreater 5): Custom1="5,76" > 5 (comma-decimal, same as "5.76") → >5',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id14", custom: { Custom1: "5,76" } } as unknown as User,
      expected: ">5",
    },

    // NumberNotEquals (11), threshold 4.2 → "<>4.2" (last rule before percentage block)
    // upstream rows: Custom1=4 / 4.0 / 4,0 → <>4.2
    {
      description:
        "numberWithPercentage (NumberNotEquals 4.2): Custom1=4 != 4.2 (no earlier rule matches) → <>4.2",
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id15", custom: { Custom1: "4" } } as unknown as User,
      expected: "<>4.2",
    },
    {
      description:
        'numberWithPercentage (NumberNotEquals 4.2): Custom1="4.0" != 4.2 (int-vs-double, same as "4") → <>4.2',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id16", custom: { Custom1: "4.0" } } as unknown as User,
      expected: "<>4.2",
    },
    {
      description:
        'numberWithPercentage (NumberNotEquals 4.2): Custom1="4,0" != 4.2 (comma-decimal, same as "4.0") → <>4.2',
      configId: RULES_CONFIG,
      key: "numberWithPercentage",
      defaultValue: "default",
      user: { identifier: "id17", custom: { Custom1: "4,0" } } as unknown as User,
      expected: "<>4.2",
    },
  ];

  // ---- Semver-comparator matrix (spec 138 / #388): SemVerIsOneOf (4),
  //      SemVerIsNotOneOf (5), SemVerLess (6), SemVerLessOrEquals (7),
  //      SemVerGreater (8), SemVerGreaterOrEquals (9). Ported 1:1 from the
  //      vendored `testmatrix_semantic.csv` (isOneOf / isNotOneOf / relations
  //      columns) + `testmatrix_semantic_2.csv` (the precedenceTests ordering
  //      chain) on the `Custom1` / `AppVersion` attributes. The comparison
  //      value lives in each condition's `s` (string) field for single values
  //      and `l` (string-list) field for sets — NOT `d` (that is numbers).
  //      Every `expected` traces to an upstream row (FR-003).
  //
  //      `isOneOf` (4) / `isNotOneOf` (5): the version set lives in `l`, with
  //      the upstream STRAY WHITESPACE preserved verbatim ("   ", " 2.0.1",
  //      " 2.0.0   ", "    ") so the trim-parity is exercised — ConfigCat
  //      trims each list entry before parsing, and empty/blank entries are
  //      unparseable and ignored.
  //
  //      `relations` (6-9): a first-match-wins chain `< 1.0.0` / `<=1.0.0` /
  //      `>2.0.0` / `>=2.0.0`, each serving its label string (matrix
  //      `relations` column).
  //
  //      `precedenceTests`: an ordered `SemVerLess` chain (+ `<=` and a final
  //      `= 2.0.0` SemVerIsOneOf tail) mirroring `testmatrix_semantic_2.csv` —
  //      each rule `< X` serves the string `"< X"`; first-match-wins means the
  //      served string is the expected output for a given AppVersion. The
  //      curated subset (research R5) covers every distinct precedence
  //      behaviour: numeric vs alphanumeric prerelease identifiers, fewer-
  //      identifiers-precede, prerelease-below-release, major/minor/patch
  //      ordering, build-metadata-ignored, and `<=`/`=` boundary inclusion.
  //      Appended after the existing 68 tuples (byte-stability, FR-005).
  const semverComparators: ParityTuple[] = [
    // ---- isOneOf: SemVerIsOneOf [   , 2.0.1, 2.0.2,    ] → "InSet" (else base) ----
    // upstream `isOneOf` column (stray-whitespace list "(   , 2.0.1, 2.0.2,    )")
    {
      description: "isOneOf (SemVerIsOneOf): no user → base Default (rule needs Custom1)",
      configId: RULES_CONFIG,
      key: "isOneOf",
      defaultValue: "default",
      expected: "Default",
    },
    {
      description:
        "isOneOf (SemVerIsOneOf): Custom1=2.0.1 in set (trim parity, leading-space entry) → InSet",
      configId: RULES_CONFIG,
      key: "isOneOf",
      defaultValue: "default",
      user: { identifier: "id22", custom: { Custom1: "2.0.1" } } as unknown as User,
      expected: "InSet",
    },
    {
      description: "isOneOf (SemVerIsOneOf): Custom1=2.0.2 in set → InSet",
      configId: RULES_CONFIG,
      key: "isOneOf",
      defaultValue: "default",
      user: { identifier: "id24", custom: { Custom1: "2.0.2" } } as unknown as User,
      expected: "InSet",
    },
    {
      description:
        "isOneOf (SemVerIsOneOf): Custom1=1.0.0 not in the whitespace set (blank entries trimmed away) → base Default",
      configId: RULES_CONFIG,
      key: "isOneOf",
      defaultValue: "default",
      user: { identifier: "id3", custom: { Custom1: "1.0.0" } } as unknown as User,
      expected: "Default",
    },
    {
      description: "isOneOf (SemVerIsOneOf): Custom1=3.0.0 not in set → base Default",
      configId: RULES_CONFIG,
      key: "isOneOf",
      defaultValue: "default",
      user: { identifier: "id26", custom: { Custom1: "3.0.0" } } as unknown as User,
      expected: "Default",
    },

    // ---- isNotOneOf: SemVerIsNotOneOf [1.0.0,1.0.1,2.0.0,2.0.1,2.0.2,] → "NotInSet" ----
    // upstream `isNotOneOf` column (stray-whitespace list
    // "(1.0.0, 1.0.1, 2.0.0   , 2.0.1, 2.0.2,    )")
    {
      description: "isNotOneOf (SemVerIsNotOneOf): no user → base Default (rule needs Custom1)",
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      expected: "Default",
    },
    {
      description: "isNotOneOf (SemVerIsNotOneOf): Custom1=0.0.0 not in set → rule serves NotInSet",
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0.0.0" } } as unknown as User,
      expected: "NotInSet",
    },
    {
      description: "isNotOneOf (SemVerIsNotOneOf): Custom1=3.0.0 not in set → NotInSet",
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      user: { identifier: "id26", custom: { Custom1: "3.0.0" } } as unknown as User,
      expected: "NotInSet",
    },
    {
      description:
        "isNotOneOf (SemVerIsNotOneOf): Custom1=1.0.0 IS in set (trim parity) → rule does not hold → base Default",
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      user: { identifier: "id3", custom: { Custom1: "1.0.0" } } as unknown as User,
      expected: "Default",
    },
    {
      description:
        "isNotOneOf (SemVerIsNotOneOf): Custom1=2.0.0 IS in set (entry had stray trailing space, trimmed) → base Default",
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      user: { identifier: "id21", custom: { Custom1: "2.0.0" } } as unknown as User,
      expected: "Default",
    },

    // ---- relations: first-match-wins < 1.0.0 / <=1.0.0 / >2.0.0 / >=2.0.0 ----
    // upstream `relations` column
    {
      description: "relations (SemVerLess 1.0.0): Custom1=0.0.0 < 1.0.0 → < 1.0.0",
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "id1", custom: { Custom1: "0.0.0" } } as unknown as User,
      expected: "< 1.0.0",
    },
    {
      description:
        "relations (SemVerLessOrEquals 1.0.0): Custom1=1.0.0 equals threshold (boundary, < excluded → <= holds) → <=1.0.0",
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "id3", custom: { Custom1: "1.0.0" } } as unknown as User,
      expected: "<=1.0.0",
    },
    {
      description: "relations (SemVerGreater 2.0.0): Custom1=2.0.1 > 2.0.0 → >2.0.0",
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "id22", custom: { Custom1: "2.0.1" } } as unknown as User,
      expected: ">2.0.0",
    },
    {
      description:
        "relations (SemVerGreaterOrEquals 2.0.0): Custom1=2.0.0 equals threshold (boundary, > excluded → >= holds) → >=2.0.0",
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "id21", custom: { Custom1: "2.0.0" } } as unknown as User,
      expected: ">=2.0.0",
    },
    {
      description:
        "relations: Custom1=1.1.0 satisfies no relation (1.0.0 < 1.1.0 < 2.0.0) → base Default",
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "id13", custom: { Custom1: "1.1.0" } } as unknown as User,
      expected: "Default",
    },

    // ---- precedenceTests: ordered SemVerLess chain (+ <= and = tail), the
    //      curated subset of testmatrix_semantic_2.csv covering every distinct
    //      ordering behaviour. Each tuple's expected is the first-match served
    //      string; AppVersion is the targeted attribute. (research R5 / FR-002)
    {
      description:
        "precedenceTests: AppVersion=1.9.1-1 < 1.9.1-2 (numeric prerelease ordering) → < 1.9.1-2",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.1-1" } } as unknown as User,
      expected: "< 1.9.1-2",
    },
    {
      description:
        "precedenceTests: AppVersion=1.9.1-2 → < 1.9.1-10 (proves -2 < -10 compares NUMERICALLY, not lexically)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.1-2" } } as unknown as User,
      expected: "< 1.9.1-10",
    },
    {
      description:
        "precedenceTests: AppVersion=1.9.1-10 → < 1.9.1-10a (numeric identifier 10 < alphanumeric 10a)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.1-10" } } as unknown as User,
      expected: "< 1.9.1-10a",
    },
    {
      description:
        "precedenceTests: AppVersion=1.9.99-rc → < 1.9.99-rc.1 (fewer identifiers precede)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.99-rc" } } as unknown as User,
      expected: "< 1.9.99-rc.1",
    },
    {
      description:
        "precedenceTests: AppVersion=1.9.99-rc.2a → < 1.9.99 (prerelease orders BELOW release)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.99-rc.2a" } } as unknown as User,
      expected: "< 1.9.99",
    },
    {
      description: "precedenceTests: AppVersion=1.9.99 → < 1.9.100 (patch ordering)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.99" } } as unknown as User,
      expected: "< 1.9.100",
    },
    {
      description: "precedenceTests: AppVersion=1.9.100 → < 1.10.0-alpha (minor ordering)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.100" } } as unknown as User,
      expected: "< 1.10.0-alpha",
    },
    {
      description:
        "precedenceTests: AppVersion=1.10.0-alpha → <= 1.10.0-alpha (SemVerLessOrEquals boundary: equal included)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.10.0-alpha" } } as unknown as User,
      expected: "<= 1.10.0-alpha",
    },
    {
      description:
        "precedenceTests: AppVersion=1.10.0 → <= 1.10.0 (release > its prerelease; <= boundary inclusion)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.10.0" } } as unknown as User,
      expected: "<= 1.10.0",
    },
    {
      description:
        "precedenceTests: AppVersion=2.0.0 → = 2.0.0 (SemVerIsOneOf equality tail; no earlier < / <= matches)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "2.0.0" } } as unknown as User,
      expected: "= 2.0.0",
    },
    {
      description:
        "precedenceTests: AppVersion=2.0.0+build3 → = 2.0.0 (build metadata IGNORED for precedence/equality)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "2.0.0+build3" } } as unknown as User,
      expected: "= 2.0.0",
    },
    {
      // Build-metadata-on-a-PRERELEASE — a distinct semver code path from the
      // release case above (the `+build3` row drops metadata off a release core;
      // here it drops off a `-alpha` prerelease, exercising prerelease-compare
      // AFTER the build-metadata strip). Upstream `testmatrix_semantic_2.csv`
      // row 8 (`1.9.99-alpha+build1` → `= 1.9.99-alpha`) asserts the metadata is
      // ignored. The full upstream chain carries a `= 1.9.99-alpha` rule that
      // this curated precedence subset (research R5) deliberately omits, so
      // against THIS encoded chain the first-match-wins result is the earliest
      // `<` whose threshold `1.9.99-alpha` falls below: `< 1.9.99-rc.1`
      // (`alpha` < `rc` by prerelease precedence). The parity property under
      // test is unchanged: `1.9.99-alpha+build1` MUST resolve identically to
      // `1.9.99-alpha`, i.e. the `+build1` is stripped before comparison.
      description:
        "precedenceTests: AppVersion=1.9.99-alpha+build1 → < 1.9.99-rc.1 (build metadata stripped off a PRERELEASE, then alpha < rc.1)",
      configId: RULES_CONFIG,
      key: "precedenceTests",
      defaultValue: "default",
      user: { identifier: "x", custom: { AppVersion: "1.9.99-alpha+build1" } } as unknown as User,
      expected: "< 1.9.99-rc.1",
    },
  ];

  // ---- Sensitive-comparator matrix (spec 139 / #391): the remaining
  //      SHA-256-salted comparators not yet covered by #384 —
  //      SensitiveTextIsOneOf (16, positive), SensitiveTextNotStartsWithAnyOf
  //      (23) and SensitiveTextNotEndsWithAnyOf (25) — plus the multi-attribute
  //      `isOneOfSensitive` (16) / `isNotOneOfSensitive` (17) cases ported 1:1
  //      from the vendored `testmatrix_sensitive.csv` (identifier / email /
  //      country, first-match-wins). #384 already covered SensitiveTextEquals
  //      (20) / NotEquals (21) / StartsWith (22) / EndsWith (24) / IsNotOneOf
  //      (17), so those are NOT duplicated here.
  //
  //      Every comparison value is pre-hashed as SHA-256(value + p.s +
  //      <setting-key>) lowercase hex, computed programmatically via
  //      sdk-shared/src/hash.ts — never hand-authored (the #388 lesson). For
  //      the NotStartsWith/NotEndsWith family each list entry is the
  //      `<byte-length>_<hash>` encoding of the cleartext prefix/suffix
  //      (ported verbatim as #384 did for the positive StartsWith/EndsWith).
  //
  //      The `isOneOfSensitive` / `isNotOneOfSensitive` rule structure + list
  //      entries are the real upstream ConfigCat config (recovered from the
  //      vendored content-by-key blob and re-salted against this config's p.s):
  //      isOneOfSensitive = Email[macska@example.com]→Macska, Identifier[Kutya,
  //      Cica]→Allat, Country[England,Wales,Scotland]→Britt (base ToAll);
  //      isNotOneOfSensitive = Identifier!∈[Kutya,Macska]→Kigyo,
  //      Email!∈[kutya@example.com,macska@example.com]→Angolna,
  //      Country!∈[England,Wales,Scotland]→Ireland (base ToAll). Each tuple's
  //      `expected` traces to a testmatrix_sensitive.csv row (FR-003). Appended
  //      after the existing 95 tuples (byte-stability, FR-005).
  const sensitiveComparators: ParityTuple[] = [
    // ---- SensitiveTextIsOneOf (16): Email hash IS ONE OF [a@configcat.com] → Dog ----
    {
      description: "sensitiveIsOneOf (sensitive IS ONE OF): no user → base Cat",
      configId: RULES_CONFIG,
      key: "sensitiveIsOneOf",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "sensitiveIsOneOf (sensitive IS ONE OF): Email a@configcat.com hash in set → Dog",
      configId: RULES_CONFIG,
      key: "sensitiveIsOneOf",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "sensitiveIsOneOf (sensitive IS ONE OF): Email b@configcat.com hash not in set → Cat",
      configId: RULES_CONFIG,
      key: "sensitiveIsOneOf",
      defaultValue: "default",
      user: { identifier: "12345", email: "b@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- SensitiveTextNotStartsWithAnyOf (23): Email hash NOT STARTS WITH
    //      ANY OF [a@, b@] → Dog (matches on absence) ----
    {
      description: "sensitiveNotStartsWith (sensitive NOT STARTS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "sensitiveNotStartsWith",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "sensitiveNotStartsWith (sensitive NOT STARTS WITH): Email c@configcat.com starts with no listed prefix → Dog",
      configId: RULES_CONFIG,
      key: "sensitiveNotStartsWith",
      defaultValue: "default",
      user: { identifier: "12345", email: "c@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "sensitiveNotStartsWith (sensitive NOT STARTS WITH): Email a@configcat.com starts with a@ → rule fails → Cat",
      configId: RULES_CONFIG,
      key: "sensitiveNotStartsWith",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- SensitiveTextNotEndsWithAnyOf (25): Email hash NOT ENDS WITH ANY OF
    //      [@configcat.com] → Dog (matches on absence) ----
    {
      description: "sensitiveNotEndsWith (sensitive NOT ENDS WITH): no user → base Cat",
      configId: RULES_CONFIG,
      key: "sensitiveNotEndsWith",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "sensitiveNotEndsWith (sensitive NOT ENDS WITH): Email joe@example.com ends with no listed suffix → Dog",
      configId: RULES_CONFIG,
      key: "sensitiveNotEndsWith",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@example.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "sensitiveNotEndsWith (sensitive NOT ENDS WITH): Email joe@configcat.com ends with @configcat.com → rule fails → Cat",
      configId: RULES_CONFIG,
      key: "sensitiveNotEndsWith",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@configcat.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- testmatrix_sensitive.csv: isOneOfSensitive (16) on
    //      identifier/email/country, first-match-wins. One tuple per CSV row;
    //      base value ToAll. Each expected is the CSV `isOneOfSensitive` cell. ----
    {
      // CSV row 1: ##null## / / / → ToAll (no user → no targeted attribute)
      description: "isOneOfSensitive (CSV ##null##): no user → base ToAll",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      expected: "ToAll",
    },
    {
      // CSV row 2: id1 / macska@example.com → Macska (Email rule, first-match)
      description: "isOneOfSensitive (CSV id1+macska@example.com): Email hash in set → Macska",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "id1", email: "macska@example.com" } as unknown as User,
      expected: "Macska",
    },
    {
      // CSV row 3: Kutya → Allat (Identifier rule)
      description: "isOneOfSensitive (CSV Kutya): Identifier hash in set → Allat",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Kutya" } as unknown as User,
      expected: "Allat",
    },
    {
      // CSV row 4: Sas → ToAll (no rule matches)
      description: "isOneOfSensitive (CSV Sas): Identifier hash not in any set → base ToAll",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Sas" } as unknown as User,
      expected: "ToAll",
    },
    {
      // CSV row 5: Kutya / macska@example.com → Macska (Email rule wins by precedence over Identifier)
      description:
        "isOneOfSensitive (CSV Kutya+macska@example.com): Email rule precedes Identifier → Macska",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Kutya", email: "macska@example.com" } as unknown as User,
      expected: "Macska",
    },
    {
      // CSV row 6: id1 / / Scotland → Britt (Country rule)
      description: "isOneOfSensitive (CSV id1+Scotland): Country hash in set → Britt",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "id1", country: "Scotland" } as unknown as User,
      expected: "Britt",
    },
    {
      // CSV row 7: Macska / / USA → ToAll (no rule matches; USA not in country set)
      description: "isOneOfSensitive (CSV Macska+USA): no rule matches → base ToAll",
      configId: RULES_CONFIG,
      key: "isOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Macska", country: "USA" } as unknown as User,
      expected: "ToAll",
    },

    // ---- testmatrix_sensitive.csv: isNotOneOfSensitive (17) on
    //      identifier/email/country, first-match-wins. One tuple per CSV row;
    //      base value ToAll. Each expected is the CSV `isNotOneOfSensitive` cell. ----
    {
      // CSV row 1: ##null## → ToAll (no targeted attribute present)
      description: "isNotOneOfSensitive (CSV ##null##): no user → base ToAll",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      expected: "ToAll",
    },
    {
      // CSV row 2: id1 / macska@example.com → Kigyo (Identifier id1 not in [Kutya,Macska])
      description:
        "isNotOneOfSensitive (CSV id1+macska@example.com): Identifier id1 not in set → Kigyo",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "id1", email: "macska@example.com" } as unknown as User,
      expected: "Kigyo",
    },
    {
      // CSV row 3: Kutya → ToAll (Identifier IS in set → rule fails; no other attribute)
      description:
        "isNotOneOfSensitive (CSV Kutya): Identifier in set → rule fails, no other attr → base ToAll",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Kutya" } as unknown as User,
      expected: "ToAll",
    },
    {
      // CSV row 4: Sas → Kigyo (Identifier Sas not in set)
      description: "isNotOneOfSensitive (CSV Sas): Identifier Sas not in set → Kigyo",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Sas" } as unknown as User,
      expected: "Kigyo",
    },
    {
      // CSV row 5: Kutya / macska@example.com → ToAll (Identifier in set; Email macska@example.com IS in set → both fail)
      description:
        "isNotOneOfSensitive (CSV Kutya+macska@example.com): Identifier in set + Email in set → base ToAll",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Kutya", email: "macska@example.com" } as unknown as User,
      expected: "ToAll",
    },
    {
      // CSV row 6: id1 / / Scotland → Kigyo (Identifier id1 not in set → Kigyo before Country evaluated)
      description:
        "isNotOneOfSensitive (CSV id1+Scotland): Identifier rule serves Kigyo (precedes Country) → Kigyo",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "id1", country: "Scotland" } as unknown as User,
      expected: "Kigyo",
    },
    {
      // CSV row 7: Macska / / USA → Ireland (Identifier Macska IS in set → fails; Country USA not in set → Ireland)
      description:
        "isNotOneOfSensitive (CSV Macska+USA): Identifier in set (fails), Country USA not in set → Ireland",
      configId: RULES_CONFIG,
      key: "isNotOneOfSensitive",
      defaultValue: "default",
      user: { identifier: "Macska", country: "USA" } as unknown as User,
      expected: "Ireland",
    },
  ];

  // ---- Array-comparator matrix (spec 140 / #393): ArrayContainsAnyOf (34) /
  //      ArrayNotContainsAnyOf (35) in cleartext + SensitiveArrayContainsAnyOf
  //      (26) / SensitiveArrayNotContainsAnyOf (27) hashed, plus the two
  //      case-check settings, ported 1:1 from the `stringArray*` /
  //      `arrayContainsCaseCheck*` columns of `testmatrix_comparators_v6.csv`.
  //
  //      The targeted `Custom1` attribute is a JSON-array string (e.g.
  //      `["read","execute"]`); the engine parses it before testing
  //      membership. Cleartext operand lists are verbatim upstream
  //      (`["read","write","execute"]`); sensitive list entries are pre-hashed
  //      SHA-256(value + p.s + <setting-key>) via sdk-shared/src/hash.ts —
  //      never hand-authored (the #388 lesson). Each `expected` is the matching
  //      CSV cell for the JSON-array Custom1 rows (FR-002); the case-check rows
  //      prove membership is case-sensitive (`Read` ≠ `read`). Appended after
  //      the existing 118 tuples (byte-stability, FR-005).
  const arrayComparators: ParityTuple[] = [
    // ---- ArrayContainsAnyOf (34, cleartext): Custom1 array contains any of
    //      [read, write, execute] → Dog (else Cat). CSV col
    //      stringArrayContainsAnyOfCleartextDogDefaultCat. ----
    {
      description:
        "stringArrayContainsAnyOfCleartextDogDefaultCat (ARRAY CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["read","execute"] → Dog (contains "read")
      description:
        'stringArrayContainsAnyOfCleartextDogDefaultCat (ARRAY CONTAINS): ["read","execute"] contains read → Dog',
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["Write"] → Cat (case-sensitive; "Write" ≠ "write")
      description:
        'stringArrayContainsAnyOfCleartextDogDefaultCat (ARRAY CONTAINS): ["Write"] case mismatch → Cat',
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["Write"]' } } as unknown as User,
      expected: "Cat",
    },

    // ---- ArrayNotContainsAnyOf (35, cleartext): Custom1 array contains NONE of
    //      [read, write, execute] → Dog (else Cat). CSV col
    //      stringArrayNotContainsAnyOfCleartextDogDefaultCat. ----
    {
      description:
        "stringArrayNotContainsAnyOfCleartextDogDefaultCat (ARRAY NOT CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["Write"] → Dog (contains none of read/write/execute)
      description:
        'stringArrayNotContainsAnyOfCleartextDogDefaultCat (ARRAY NOT CONTAINS): ["Write"] has none listed → Dog',
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["Write"]' } } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["read","execute"] → Cat (contains "read" → rule fails)
      description:
        'stringArrayNotContainsAnyOfCleartextDogDefaultCat (ARRAY NOT CONTAINS): ["read","execute"] contains read → Cat',
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Cat",
    },

    // ---- SensitiveArrayContainsAnyOf (26): Custom1 array (hashed) contains any
    //      of [read, write, execute] → Dog (else Cat). CSV col
    //      stringArrayContainsAnyOfDogDefaultCat. ----
    {
      description:
        "stringArrayContainsAnyOfDogDefaultCat (sensitive ARRAY CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["read","execute"] → Dog (hash of "read" in set)
      description:
        'stringArrayContainsAnyOfDogDefaultCat (sensitive ARRAY CONTAINS): ["read","execute"] hash contains read → Dog',
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["Write"] → Cat (hash of "Write" not in set)
      description:
        'stringArrayContainsAnyOfDogDefaultCat (sensitive ARRAY CONTAINS): ["Write"] hash not in set → Cat',
      configId: RULES_CONFIG,
      key: "stringArrayContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["Write"]' } } as unknown as User,
      expected: "Cat",
    },

    // ---- SensitiveArrayNotContainsAnyOf (27): Custom1 array (hashed) contains
    //      NONE of [read, write, execute] → Dog (else Cat). CSV col
    //      stringArrayNotContainsAnyOfDogDefaultCat. ----
    {
      description:
        "stringArrayNotContainsAnyOfDogDefaultCat (sensitive ARRAY NOT CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["Write"] → Dog (no hashed entry listed)
      description:
        'stringArrayNotContainsAnyOfDogDefaultCat (sensitive ARRAY NOT CONTAINS): ["Write"] hash has none listed → Dog',
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["Write"]' } } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["read","execute"] → Cat (hash of "read" present → rule fails)
      description:
        'stringArrayNotContainsAnyOfDogDefaultCat (sensitive ARRAY NOT CONTAINS): ["read","execute"] hash contains read → Cat',
      configId: RULES_CONFIG,
      key: "stringArrayNotContainsAnyOfDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Cat",
    },

    // ---- Case-check CONTAINS (26, hashed operand "Read"): proves cleartext
    //      array membership is case-sensitive. CSV col
    //      arrayContainsCaseCheckDogDefaultCat. ----
    {
      description: "arrayContainsCaseCheckDogDefaultCat (case-check CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "arrayContainsCaseCheckDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["execute","Read"] → Dog (exact "Read" present)
      description:
        'arrayContainsCaseCheckDogDefaultCat (case-check CONTAINS): ["execute","Read"] contains Read → Dog',
      configId: RULES_CONFIG,
      key: "arrayContainsCaseCheckDogDefaultCat",
      defaultValue: "default",
      user: {
        identifier: "12345",
        custom: { Custom1: '["execute", "Read"]' },
      } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["read","execute"] → Cat (only lowercase "read"; "Read" absent)
      description:
        'arrayContainsCaseCheckDogDefaultCat (case-check CONTAINS): ["read","execute"] lacks Read → Cat',
      configId: RULES_CONFIG,
      key: "arrayContainsCaseCheckDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Cat",
    },

    // ---- Case-check NOT CONTAINS (27, hashed operand "Write"): CSV col
    //      arrayDoesNotContainCaseCheckDogDefaultCat. ----
    {
      description:
        "arrayDoesNotContainCaseCheckDogDefaultCat (case-check NOT CONTAINS): no user → base Cat",
      configId: RULES_CONFIG,
      key: "arrayDoesNotContainCaseCheckDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row: Custom1=["read","execute"] → Dog (no exact "Write")
      description:
        'arrayDoesNotContainCaseCheckDogDefaultCat (case-check NOT CONTAINS): ["read","execute"] lacks Write → Dog',
      configId: RULES_CONFIG,
      key: "arrayDoesNotContainCaseCheckDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: '["read","execute"]' } } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row: Custom1=["Read","Write","execute"] → Cat (exact "Write" present → rule fails)
      description:
        'arrayDoesNotContainCaseCheckDogDefaultCat (case-check NOT CONTAINS): ["Read","Write","execute"] contains Write → Cat',
      configId: RULES_CONFIG,
      key: "arrayDoesNotContainCaseCheckDogDefaultCat",
      defaultValue: "default",
      user: {
        identifier: "12345",
        custom: { Custom1: '["Read", "Write",  "execute"]' },
      } as unknown as User,
      expected: "Cat",
    },
  ];

  // ---- Unicode-comparator matrix (spec 141 / #398): the highest cross-SDK
  //      normalization risk. A representative subset of
  //      `fixtures/upstream/testmatrix_unicode.csv`, ported 1:1, exercising
  //      every distinct Unicode behaviour through the text + array comparators
  //      (cleartext + hashed):
  //
  //        (a) the Unicode attribute NAME `🆃🅴🆇🆃` is the targeted user.custom
  //            key on EVERY tuple — a normalizing attribute-map lookup would
  //            miss it;
  //        (b) accent / case-folding: `ÁRVÍZTŰRŐ tükörfúrógép` (in the IsOneOf
  //            operand → Dog) vs its lowercased twin `árvíztűrő tükörfúrógép`
  //            (NOT in the operand → Cat), proving cleartext is case-sensitive
  //            with NO implicit case folding;
  //        (c) surrogate pairs: `u𝖓𝖎𝖈𝖔𝖉e` (mathematical-bold, U+1D593… — the
  //            interior code units; in the operand → Dog) vs `u𝖓𝖎𝖈𝖔𝖉𝖊` (bold
  //            final `𝖊` U+1D58A; NOT in the operand → Cat), proving the
  //            comparator operates on exact code units with no normalization;
  //        (d) a Unicode-ARRAY value: a JSON-array-string custom attribute
  //            whose members are Unicode strings, tested for membership.
  //
  //      Operands are derived 1:1 from the CSV truth table (Principle II,
  //      invent nothing): TextEquals operand = `ʄǟռƈʏ ȶɛӼȶ` (only row 1 True);
  //      IsOneOf / ArrayContains operand = `["ÁRVÍZTŰRŐ tükörfúrógép",
  //      "u𝖓𝖎𝖈𝖔𝖉e"]` (rows 3/7 and 11/12 True, rows 4/9/13 False). The hashed
  //      operands in `config-v6.rules.json` are `SHA-256(utf8(value) + p.s +
  //      <setting-key>)` over the EXACT UTF-8 bytes of the Unicode value,
  //      computed via sdk-shared `hash.ts` — never transliterated/simplified
  //      (the #388 lesson). Each `expected` traces to a CSV cell (FR-002).
  //      Appended after the existing 136 tuples (byte-stability, FR-004/005).
  const unicodeComparators: ParityTuple[] = [
    // ---- TextEquals on the Unicode attribute name (cleartext c=28 / hashed
    //      c=20), operand `ʄǟռƈʏ ȶɛӼȶ`. CSV cols boolTextEqualsCleartext /
    //      boolTextEqualsHashed. ----
    {
      description: "unicodeTextEqualsCleartext (UNICODE attr-name TextEquals): no user → base Cat",
      configId: RULES_CONFIG,
      key: "unicodeTextEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row 1: 🆃🅴🆇🆃=ʄǟռƈʏ ȶɛӼȶ → boolTextEqualsCleartext True
      description:
        "unicodeTextEqualsCleartext (UNICODE attr-name TextEquals): ʄǟռƈʏ ȶɛӼȶ equals → Dog",
      configId: RULES_CONFIG,
      key: "unicodeTextEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ʄǟռƈʏ ȶɛӼȶ"),
      expected: "Dog",
    },
    {
      // CSV row 2: 🆃🅴🆇🆃=ʄaռƈʏ ȶɛӼȶ → boolTextEqualsCleartext False (one byte differs)
      description:
        "unicodeTextEqualsCleartext (UNICODE attr-name TextEquals): ʄaռƈʏ ȶɛӼȶ differs → Cat",
      configId: RULES_CONFIG,
      key: "unicodeTextEqualsCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ʄaռƈʏ ȶɛӼȶ"),
      expected: "Cat",
    },
    {
      // CSV row 1: boolTextEqualsHashed True — hash over EXACT UTF-8 bytes
      description:
        "unicodeTextEqualsHashed (UNICODE attr-name SensitiveTextEquals): ʄǟռƈʏ ȶɛӼȶ hash equals → Dog",
      configId: RULES_CONFIG,
      key: "unicodeTextEqualsHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ʄǟռƈʏ ȶɛӼȶ"),
      expected: "Dog",
    },
    {
      // CSV row 2: boolTextEqualsHashed False
      description:
        "unicodeTextEqualsHashed (UNICODE attr-name SensitiveTextEquals): ʄaռƈʏ ȶɛӼȶ hash differs → Cat",
      configId: RULES_CONFIG,
      key: "unicodeTextEqualsHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ʄaռƈʏ ȶɛӼȶ"),
      expected: "Cat",
    },

    // ---- IsOneOf (cleartext c=0 / hashed c=16), operand
    //      ["ÁRVÍZTŰRŐ tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]. Exercises the
    //      accent/case-folding pair AND the surrogate-pair pair. CSV cols
    //      boolIsOneOfCleartext / boolIsOneOfHashed. ----
    {
      // CSV row 3: 🆃🅴🆇🆃=ÁRVÍZTŰRŐ tükörfúrógép → boolIsOneOfCleartext True
      description:
        "unicodeIsOneOfCleartext (UNICODE IsOneOf, ACCENT): ÁRVÍZTŰRŐ tükörfúrógép in set → Dog",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ÁRVÍZTŰRŐ tükörfúrógép"),
      expected: "Dog",
    },
    {
      // CSV row 4: 🆃🅴🆇🆃=árvíztűrő tükörfúrógép → boolIsOneOfCleartext False
      //            (case-folding twin; cleartext is case-SENSITIVE → no match)
      description:
        "unicodeIsOneOfCleartext (UNICODE IsOneOf, CASE-FOLD): árvíztűrő tükörfúrógép case-mismatch → Cat",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("árvíztűrő tükörfúrógép"),
      expected: "Cat",
    },
    {
      // CSV row 7: 🆃🅴🆇🆃=u𝖓𝖎𝖈𝖔𝖉e → boolIsOneOfCleartext True (surrogate pairs)
      description: "unicodeIsOneOfCleartext (UNICODE IsOneOf, SURROGATE): u𝖓𝖎𝖈𝖔𝖉e in set → Dog",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("u𝖓𝖎𝖈𝖔𝖉e"),
      expected: "Dog",
    },
    {
      // CSV row 9: 🆃🅴🆇🆃=u𝖓𝖎𝖈𝖔𝖉𝖊 → boolIsOneOfCleartext False (bold final 𝖊,
      //            differing surrogate pair; exact code-unit comparison → no match)
      description:
        "unicodeIsOneOfCleartext (UNICODE IsOneOf, SURROGATE): u𝖓𝖎𝖈𝖔𝖉𝖊 differing pair → Cat",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("u𝖓𝖎𝖈𝖔𝖉𝖊"),
      expected: "Cat",
    },
    {
      // CSV row 3: boolIsOneOfHashed True — hash over EXACT accented UTF-8 bytes
      description:
        "unicodeIsOneOfHashed (UNICODE SensitiveIsOneOf, ACCENT): ÁRVÍZTŰRŐ tükörfúrógép hash in set → Dog",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("ÁRVÍZTŰRŐ tükörfúrógép"),
      expected: "Dog",
    },
    {
      // CSV row 7: boolIsOneOfHashed True — hash over EXACT surrogate-pair UTF-8 bytes
      description:
        "unicodeIsOneOfHashed (UNICODE SensitiveIsOneOf, SURROGATE): u𝖓𝖎𝖈𝖔𝖉e hash in set → Dog",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("u𝖓𝖎𝖈𝖔𝖉e"),
      expected: "Dog",
    },
    {
      // CSV row 4: boolIsOneOfHashed False (case-folding twin hashes differently)
      description:
        "unicodeIsOneOfHashed (UNICODE SensitiveIsOneOf, CASE-FOLD): árvíztűrő tükörfúrógép hash absent → Cat",
      configId: RULES_CONFIG,
      key: "unicodeIsOneOfHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser("árvíztűrő tükörfúrógép"),
      expected: "Cat",
    },

    // ---- ArrayContainsAnyOf (cleartext c=34 / hashed c=26), operand
    //      ["ÁRVÍZTŰRŐ tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"], on a JSON-array-string
    //      custom attribute with Unicode members. CSV cols
    //      boolArrayContainsCleartext / boolArrayContainsHashed. ----
    {
      // CSV row 11: 🆃🅴🆇🆃=["ÁRVÍZTŰRŐ tükörfúrógép", "unicode"]
      //             → boolArrayContainsCleartext True (accented member matches)
      description:
        'unicodeArrayContainsCleartext (UNICODE ARRAY contains, ACCENT): ["ÁRVÍZTŰRŐ tükörfúrógép","unicode"] → Dog',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ tükörfúrógép", "unicode"]'),
      expected: "Dog",
    },
    {
      // CSV row 12: 🆃🅴🆇🆃=["ÁRVÍZTŰRŐ", "tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]
      //             → boolArrayContainsCleartext True (surrogate-pair member matches)
      description:
        'unicodeArrayContainsCleartext (UNICODE ARRAY contains, SURROGATE): ["ÁRVÍZTŰRŐ","tükörfúrógép","u𝖓𝖎𝖈𝖔𝖉e"] → Dog',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ", "tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]'),
      expected: "Dog",
    },
    {
      // CSV row 13: 🆃🅴🆇🆃=["ÁRVÍZTŰRŐ", "tükörfúrógép", "unicode"]
      //             → boolArrayContainsCleartext False (no member in the operand)
      description:
        'unicodeArrayContainsCleartext (UNICODE ARRAY contains): ["ÁRVÍZTŰRŐ","tükörfúrógép","unicode"] none match → Cat',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsCleartextDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ", "tükörfúrógép", "unicode"]'),
      expected: "Cat",
    },
    {
      // CSV row 11: boolArrayContainsHashed True — each array member hashed over EXACT UTF-8
      description:
        'unicodeArrayContainsHashed (UNICODE SensitiveARRAY contains, ACCENT): ["ÁRVÍZTŰRŐ tükörfúrógép","unicode"] hash match → Dog',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ tükörfúrógép", "unicode"]'),
      expected: "Dog",
    },
    {
      // CSV row 12: 🆃🅴🆇🆃=["ÁRVÍZTŰRŐ", "tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]
      //             → boolArrayContainsHashed True (the surrogate-pair member
      //             u𝖓𝖎𝖈𝖔𝖉e hashes into the operand set). The highest-risk path:
      //             a surrogate pair through the HASHED array comparator. The
      //             u𝖓𝖎𝖈𝖔𝖉e hash already lives in the setting's operand list
      //             (no new hash — same operand as the IsOneOf surrogate tuple).
      description:
        'unicodeArrayContainsHashed (UNICODE SensitiveARRAY contains, SURROGATE): ["ÁRVÍZTŰRŐ","tükörfúrógép","u𝖓𝖎𝖈𝖔𝖉e"] hash match → Dog',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ", "tükörfúrógép", "u𝖓𝖎𝖈𝖔𝖉e"]'),
      expected: "Dog",
    },
    {
      // CSV row 13: boolArrayContainsHashed False (no member hash in the operand set)
      description:
        'unicodeArrayContainsHashed (UNICODE SensitiveARRAY contains): ["ÁRVÍZTŰRŐ","tükörfúrógép","unicode"] none → Cat',
      configId: RULES_CONFIG,
      key: "unicodeArrayContainsHashedDogDefaultCat",
      defaultValue: "default",
      user: unicodeUser('["ÁRVÍZTŰRŐ", "tükörfúrógép", "unicode"]'),
      expected: "Cat",
    },
  ];

  // ---- AND/OR condition-group matrix (spec 142 / #386): the condition-group
  //      DIMENSION (not a comparator family). Ported 1:1 from the
  //      `emailAnd` / `emailOr` columns of `testmatrix_and_or.csv` and the
  //      AND-rule config shape in `evaluationlog/and_rules.json` /
  //      `content-by-key.json`. Two settings:
  //
  //        `emailAnd` — ONE rule with THREE AND conditions (all-must-match):
  //          Email STARTS WITH `jane` (sensitive, c=22) AND Email CONTAINS `@`
  //          (cleartext, c=2) AND Email ENDS WITH `sensitivecompany.com`
  //          (sensitive, c=24) → Dog, else base Cat. Serves Dog only when ALL
  //          three hold; one failing condition short-circuits the rule to the
  //          base value (the AND-short-circuit edge case).
  //
  //        `emailOr` — THREE first-match-wins rules, each a single STARTS WITH
  //          condition (sensitive, c=22): Email STARTS WITH `jane@` → Jane,
  //          `john@` → John, `mark@` → Mark, else base Cat. Rule ORDER matters
  //          (first-match-wins).
  //
  //      The sensitive operands are re-hashed against THIS config's salt
  //      (`p.s`) + setting key via the `<byte-length>_<SHA-256 lowercase-hex>`
  //      encoding — `SHA-256(value + p.s + <setting-key>)`, computed
  //      programmatically (NEVER hand-authored — the #388 lesson). Each
  //      `expected` traces to a `testmatrix_and_or.csv` row (FR-002). Appended
  //      after the existing 154 tuples (byte-stability, FR-004).
  const andOrConditionGroups: ParityTuple[] = [
    // ---- emailAnd: AND-group, all-three-must-match → Dog (else base Cat) ----
    {
      // CSV rows 1-2 (##null## / empty): no user → AND-group cannot match → base Cat
      description: "emailAnd (AND-group): no user → base Cat (AND-rule needs Email)",
      configId: RULES_CONFIG,
      key: "emailAnd",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row 9: jane@sensitivecompany.com (England) → emailAnd Dog
      //   starts-with jane ✓ AND contains @ ✓ AND ends-with sensitivecompany.com ✓
      description:
        "emailAnd (AND-group): jane@sensitivecompany.com matches ALL three conditions → Dog",
      configId: RULES_CONFIG,
      key: "emailAnd",
      defaultValue: "default",
      user: { identifier: "12345", email: "jane@sensitivecompany.com" } as unknown as User,
      expected: "Dog",
    },
    {
      // CSV row 10: anna@sensitivecompany.com → emailAnd Cat
      //   contains @ ✓ AND ends-with sensitivecompany.com ✓ BUT starts-with jane ✗
      //   → first AND condition fails → whole rule fails → base Cat
      description:
        "emailAnd (AND-group): anna@sensitivecompany.com fails the STARTS-WITH-jane condition → base Cat",
      configId: RULES_CONFIG,
      key: "emailAnd",
      defaultValue: "default",
      user: { identifier: "12345", email: "anna@sensitivecompany.com" } as unknown as User,
      expected: "Cat",
    },
    {
      // CSV row 3: jane@example.com → emailAnd Cat
      //   starts-with jane ✓ AND contains @ ✓ BUT ends-with sensitivecompany.com ✗
      //   → the trailing AND condition fails → base Cat (AND short-circuit)
      description:
        "emailAnd (AND-group): jane@example.com fails the ENDS-WITH-sensitivecompany.com condition → base Cat",
      configId: RULES_CONFIG,
      key: "emailAnd",
      defaultValue: "default",
      user: { identifier: "12345", email: "jane@example.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- emailOr: three first-match-wins STARTS-WITH rules ----
    {
      // CSV rows 1-2 (##null## / empty): no user → no rule matches → base Cat
      description: "emailOr (OR / first-match-wins): no user → base Cat",
      configId: RULES_CONFIG,
      key: "emailOr",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      // CSV row 3: jane@example.com → emailOr Jane (first rule, STARTS WITH jane@)
      description: "emailOr (OR / first-match-wins): jane@example.com starts with jane@ → Jane",
      configId: RULES_CONFIG,
      key: "emailOr",
      defaultValue: "default",
      user: { identifier: "12345", email: "jane@example.com" } as unknown as User,
      expected: "Jane",
    },
    {
      // CSV row 4: john@example.com → emailOr John (second rule, STARTS WITH john@)
      description: "emailOr (OR / first-match-wins): john@example.com starts with john@ → John",
      configId: RULES_CONFIG,
      key: "emailOr",
      defaultValue: "default",
      user: { identifier: "12345", email: "john@example.com" } as unknown as User,
      expected: "John",
    },
    {
      // CSV row 6: mark@example.com → emailOr Mark (third rule, STARTS WITH mark@)
      description: "emailOr (OR / first-match-wins): mark@example.com starts with mark@ → Mark",
      configId: RULES_CONFIG,
      key: "emailOr",
      defaultValue: "default",
      user: { identifier: "12345", email: "mark@example.com" } as unknown as User,
      expected: "Mark",
    },
    {
      // CSV row 5: a@example.com → emailOr Cat (matches none of jane@/john@/mark@)
      description: "emailOr (OR / first-match-wins): a@example.com matches no rule → base Cat",
      configId: RULES_CONFIG,
      key: "emailOr",
      defaultValue: "default",
      user: { identifier: "12345", email: "a@example.com" } as unknown as User,
      expected: "Cat",
    },
  ];

  // ---- Datetime-comparator matrix (spec 143 / #392): DateTimeBefore (18),
  //      DateTimeAfter (19) on a Unix-epoch `Date` attribute. Ported 1:1 from
  //      the vendored `content-by-key.json` `allinone` setting (the
  //      `Date BEFORE 1693497600 AND Date AFTER 1693497600 → "12"` rule, base
  //      "default") and the `evaluationlog/comparators.json` `allinone` case
  //      (user `Date: "1693497500"` → "default", because 1693497500 < the
  //      1693497600 threshold so BEFORE holds but AFTER fails → the AND fails).
  //
  //      We split that source into two single-comparator settings —
  //      `datetimeBeforeDogDefaultCat` (one DateTimeBefore rule) and
  //      `datetimeAfterDogDefaultCat` (one DateTimeAfter rule) — each carrying
  //      the EXACT upstream threshold (1693497600), served value ("12") and
  //      base value ("default"), so each comparator is independently provable
  //      through public getValue. The epoch threshold lives in each condition's
  //      `d` (double) field — locale-free in JSON. The targeted `Date`
  //      attribute is supplied on user.custom as a STRING Unix-epoch (seconds),
  //      exactly as ConfigCat's `comparators.json` feeds it (`"1693497500"`).
  //
  //      Each comparator gets: a holds case (served "12"), a does-not-hold case
  //      (base "default"), a boundary case (Date == threshold; BEFORE/AFTER are
  //      strict so the exact epoch is EXCLUDED → "default"), a FRACTIONAL-epoch
  //      case (`...500.5` / `...700.5` — must parse to the exact double, no
  //      truncation, FR-004), and an int-vs-double pair (`...500` vs `...500.0`)
  //      that MUST resolve identically (FR-004). The `1693497500` does-not-hold
  //      case on DateTimeAfter is the comparators.json datapoint verbatim.
  //      Every `expected` traces to the upstream source (FR-002). Appended after
  //      the existing 163 tuples (byte-stability, FR-005).
  const datetimeComparators: ParityTuple[] = [
    // ---- DateTimeBefore (18): Date < 1693497600 → "12" (else base "default") ----
    {
      description:
        "datetimeBeforeDogDefaultCat (DateTimeBefore 1693497600): no user → base default (rule needs Date)",
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      expected: "default",
    },
    {
      description:
        'datetimeBeforeDogDefaultCat (DateTimeBefore 1693497600): Date="1693497500" < threshold → 12 (comparators.json datapoint)',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Date: "1693497500" } } as unknown as User,
      expected: "12",
    },
    {
      description:
        'datetimeBeforeDogDefaultCat (DateTimeBefore 1693497600): Date="1693497700" > threshold → base default',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12346", custom: { Date: "1693497700" } } as unknown as User,
      expected: "default",
    },
    {
      description:
        'datetimeBeforeDogDefaultCat (DateTimeBefore 1693497600): Date="1693497600" equals threshold (strict, BEFORE excludes) → base default',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12347", custom: { Date: "1693497600" } } as unknown as User,
      expected: "default",
    },
    {
      description:
        'datetimeBeforeDogDefaultCat (DateTimeBefore 1693497600): Date="1693497500.5" fractional < threshold → 12 (exact double, no truncation)',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12348", custom: { Date: "1693497500.5" } } as unknown as User,
      expected: "12",
    },
    {
      description:
        'datetimeBeforeDogDefaultCat int-vs-double: Date="1693497500.0" < threshold → 12 (same as "1693497500")',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12349", custom: { Date: "1693497500.0" } } as unknown as User,
      expected: "12",
    },

    // ---- DateTimeAfter (19): Date > 1693497600 → "12" (else base "default") ----
    {
      description:
        "datetimeAfterDogDefaultCat (DateTimeAfter 1693497600): no user → base default (rule needs Date)",
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      expected: "default",
    },
    {
      description:
        'datetimeAfterDogDefaultCat (DateTimeAfter 1693497600): Date="1693497700" > threshold → 12',
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12350", custom: { Date: "1693497700" } } as unknown as User,
      expected: "12",
    },
    {
      description:
        'datetimeAfterDogDefaultCat (DateTimeAfter 1693497600): Date="1693497500" < threshold → base default (comparators.json datapoint)',
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12351", custom: { Date: "1693497500" } } as unknown as User,
      expected: "default",
    },
    {
      description:
        'datetimeAfterDogDefaultCat (DateTimeAfter 1693497600): Date="1693497600" equals threshold (strict, AFTER excludes) → base default',
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12352", custom: { Date: "1693497600" } } as unknown as User,
      expected: "default",
    },
    {
      description:
        'datetimeAfterDogDefaultCat (DateTimeAfter 1693497600): Date="1693497700.5" fractional > threshold → 12 (exact double, no truncation)',
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12353", custom: { Date: "1693497700.5" } } as unknown as User,
      expected: "12",
    },
    {
      description:
        'datetimeAfterDogDefaultCat int-vs-double: Date="1693497700.0" > threshold → 12 (same as "1693497700")',
      configId: RULES_CONFIG,
      key: "datetimeAfterDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12354", custom: { Date: "1693497700.0" } } as unknown as User,
      expected: "12",
    },
  ];

  // ---- Attribute & comparison-value trimming (spec 144 / #394) ----------------
  //      A representative subset (FR-007) ported 1:1 from the vendored
  //      `comparison_attribute_trimming.json` and `comparison_value_trimming.json`
  //      fixtures — proving the per-comparator trim semantics through the public
  //      `getValue`. SCOPE: trimming only. The non-string-attribute CONVERSION
  //      cases (number→string, date→string, array→string) are DEFERRED to the
  //      typed-user-attributes prerequisite feature: they require TYPED user
  //      attributes (number / Date / array), but the 14 non-JS SDK ports model
  //      custom attributes as STRING-ONLY (`HashMap<String,String>` etc.), so a
  //      number/array attribute fails to even deserialize the corpus on those
  //      runners (rust: `invalid type: integer 125, expected a string`; elixir:
  //      the array case). Every tuple below uses ONLY a plain STRING user
  //      attribute so the string-only SDK runners deserialize and resolve it.
  //
  //      Trimming: per ConfigCat, the SEMVER (and number/date) comparators trim
  //      BOTH the user attribute and the rule's comparison value before parsing;
  //      the TEXT comparators do NOT. The two trimming cases use SemVerGreater (8)
  //      on `Custom1`, ported from the `semvergreater` rule of the two trimming
  //      fixtures:
  //        - attribute-trimming: comparison value `"0.1.1"` (clean) +
  //          whitespace-bearing attribute `" 0.2.0 "` → the engine trims the
  //          ATTRIBUTE, `0.2.0 > 0.1.1` holds → Dog (proves attribute trim).
  //        - comparison-value-trimming (FR-007): comparison value kept VERBATIM
  //          with surrounding whitespace `" 0.1.1 "` (the #388 keep-whitespace
  //          lesson) + clean attribute `"0.2.0"` → the engine trims the stored
  //          COMPARISON VALUE, `0.2.0 > 0.1.1` holds → Dog (proves value trim).
  //
  //      Every `expected` was proven through the JS family's public
  //      `getValueAsync` (T008). Appended after the existing 175 tuples
  //      (byte-stability, FR-004).
  const attrConversionAndTrimming: ParityTuple[] = [
    // ---- attribute trimming (comparison_attribute_trimming.json, semvergreater 8) ----
    {
      description:
        'semverGreaterAttrTrimDogDefaultCat (SemVerGreater 8): Custom1=" 0.2.0 " (whitespace) → attribute TRIMMED, 0.2.0 > 0.1.1 → Dog',
      configId: RULES_CONFIG,
      key: "semverGreaterAttrTrimDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "attr-trim", custom: { Custom1: " 0.2.0 " } } as unknown as User,
      expected: "Dog",
    },
    // ---- comparison-value trimming (comparison_value_trimming.json, semvergreater 8) ----
    {
      description:
        'semverGreaterValueTrimDogDefaultCat (SemVerGreater 8): comparison value " 0.1.1 " (whitespace, verbatim) TRIMMED, Custom1="0.2.0" > 0.1.1 → Dog (FR-007)',
      configId: RULES_CONFIG,
      key: "semverGreaterValueTrimDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "value-trim", custom: { Custom1: "0.2.0" } } as unknown as User,
      expected: "Dog",
    },
  ];

  // ---- TYPED attribute-CONVERSION matrix (spec 151 / #468): the deferred
  //      half of #394. A non-string Custom1 attribute (NUMBER / DATE / ARRAY)
  //      is converted to ConfigCat's canonical string BEFORE a TextEquals
  //      (comparator 28) test on the rule; when the converted string matches,
  //      the rule's percentage block (5 × 20%, options "1".."5") serves the
  //      bucket the user lands in, else the setting's base "0". Ported 1:1 from
  //      the vendored `comparison_attribute_conversion.json` settings
  //      (numberToStringConversion{,Int,PositiveExp,NegativeExp},
  //      dateToStringConversion,
  //      stringArrayToStringConversion{,Empty,SpecialChars,Unicode}), embedded
  //      verbatim in `config-v6.rules.json`'s `f`. The conversion rules (FR-003,
  //      ConfigCat-exact, invent nothing):
  //        - number → invariant-culture decimal (`125`→"125", `0.12345`→"0.12345",
  //          and the exponent forms).
  //
  //      SCOPE NOTE (spec 151 / #468): the six NON-FINITE number conversions
  //      (numberToStringConversion{NaN,PositiveInf,NegativeInf} and
  //      dateToStringConversion{NaN,PositiveInf,NegativeInf}) are DEFERRED. The
  //      JSON-corpus path is lossy for them: `JSON.stringify(NaN)`,
  //      `JSON.stringify(Infinity)` and `JSON.stringify(-Infinity)` all collapse
  //      to `null` in `parity-corpus-rules.json`, so the three distinct special
  //      floats become one indistinguishable `null` that the non-JS
  //      (JSON-reading) federation runners cannot reconstruct. A follow-up will
  //      reintroduce them behind a non-lossy `{"$num":"NaN"|"Infinity"|
  //      "-Infinity"}` encoding tag (tracked follow-up). Until then this matrix
  //      ships only the 10 FINITE conversions.
  //        - Date   → Unix epoch SECONDS (fractional preserved):
  //          `1680307199.999`. A NUMERIC epoch attribute is already seconds, so
  //          a `Date` object and the equivalent number resolve identically.
  //        - array  → deterministic JSON (`["read","Write"," eXecute "]`),
  //          incl. the empty array, special-char escaping and Unicode forms.
  //      The served option ("1".."5") is the UNSALTED bucket
  //      parseInt(sha1(settingKey + convertedCustom1String).substring(0,7),16)
  //      % 100 accumulated across the 5×20% widths — so the upstream served
  //      values transfer verbatim even though our config carries a different
  //      `p.s` (percentage bucketing does NOT use the salt; the spec-147 lesson).
  //
  //      The expected served values are ConfigCat-exact (from the official
  //      conformance suite's
  //      `ComparisonAttributeConversionToCanonicalStringTestSuite`) and were
  //      re-proven through the JS family's public `getValueAsync` (T007). The
  //      Custom1 attribute is a TYPED value (number / `Date` / `string[]`) on
  //      `User.custom` — the JS-family runner decodes it from the corpus typed-
  //      attribute encoding (number→number, `{"$date":n}`→`new Date(n*1000)`,
  //      array→string[]). Appended after the existing 220 tuples (byte-stability,
  //      FR-002): the existing string-attr tuples are unchanged-in-place and
  //      serialize byte-identically (the encoding is natural-JSON for strings).
  const attrConversion: ParityTuple[] = [
    // ---- number → invariant-culture decimal string ----
    {
      description:
        "numberToStringConversion (TextEquals 28): Custom1=0.12345 (number) → '0.12345' matches → option 1",
      configId: RULES_CONFIG,
      key: "numberToStringConversion",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: 0.12345 } } as unknown as User,
      expected: "1",
    },
    {
      description:
        "numberToStringConversionInt (TextEquals 28): Custom1=125 (number) → '125' matches → option 4",
      configId: RULES_CONFIG,
      key: "numberToStringConversionInt",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: 125 } } as unknown as User,
      expected: "4",
    },
    {
      description:
        "numberToStringConversionPositiveExp (TextEquals 28): Custom1=-1.23456789e96 → '-1.23456789e+96' matches → option 2",
      configId: RULES_CONFIG,
      key: "numberToStringConversionPositiveExp",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: -1.23456789e96 } } as unknown as User,
      expected: "2",
    },
    {
      description:
        "numberToStringConversionNegativeExp (TextEquals 28): Custom1=-12345.6789e-100 → '-1.23456789e-96' matches → option 4",
      configId: RULES_CONFIG,
      key: "numberToStringConversionNegativeExp",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: -12345.6789e-100 } } as unknown as User,
      expected: "4",
    },
    // ---- Date → Unix epoch SECONDS (fractional preserved) ----
    {
      description:
        "dateToStringConversion (TextEquals 28): Custom1=Date(1680307199999) → '1680307199.999' (epoch seconds) matches → option 3",
      configId: RULES_CONFIG,
      key: "dateToStringConversion",
      defaultValue: "fallback",
      user: {
        identifier: "12345",
        custom: { Custom1: new Date(1680307199999) },
      } as unknown as User,
      expected: "3",
    },
    {
      description:
        "dateToStringConversion (TextEquals 28): Custom1=1680307199.999 (numeric epoch) → same as the Date object → option 3",
      configId: RULES_CONFIG,
      key: "dateToStringConversion",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: 1680307199.999 } } as unknown as User,
      expected: "3",
    },
    // ---- array → deterministic JSON string ----
    {
      description:
        'stringArrayToStringConversion (TextEquals 28): Custom1=["read","Write"," eXecute "] → JSON matches → option 4',
      configId: RULES_CONFIG,
      key: "stringArrayToStringConversion",
      defaultValue: "fallback",
      user: {
        identifier: "12345",
        custom: { Custom1: ["read", "Write", " eXecute "] },
      } as unknown as User,
      expected: "4",
    },
    {
      description:
        "stringArrayToStringConversionEmpty (TextEquals 28): Custom1=[] (empty array) → '[]' matches → option 5",
      configId: RULES_CONFIG,
      key: "stringArrayToStringConversionEmpty",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: [] } } as unknown as User,
      expected: "5",
    },
    {
      description:
        "stringArrayToStringConversionSpecialChars (TextEquals 28): Custom1 array with escapes → JSON matches → option 3",
      configId: RULES_CONFIG,
      key: "stringArrayToStringConversionSpecialChars",
      defaultValue: "fallback",
      user: {
        identifier: "12345",
        custom: { Custom1: ["+<>%\"'\\/\t\r\n"] },
      } as unknown as User,
      expected: "3",
    },
    {
      description:
        "stringArrayToStringConversionUnicode (TextEquals 28): Custom1 Unicode array → JSON matches → option 2",
      configId: RULES_CONFIG,
      key: "stringArrayToStringConversionUnicode",
      defaultValue: "fallback",
      user: {
        identifier: "12345",
        custom: { Custom1: ["äöüÄÖÜçéèñışğâ¢™✓😀"] },
      } as unknown as User,
      expected: "2",
    },
    // ---- non-finite number → "NaN" / "Infinity" / "-Infinity" (#479) ----
    //
    // `userAttributeValueToString(value)` renders a non-finite number as
    // `value + ""` → "NaN" / "Infinity" / "-Infinity", which the TextEquals(28)
    // condition matches → the setting's 5×20% percentage rollout picks an
    // option (deterministic per key for identifier "12345"). The `date*` keys
    // take the SAME non-finite NUMBER input — a JS `Date` cannot represent
    // ±Infinity (only NaN), and the conversion is value-based — they differ
    // from the `number*` keys ONLY by setting key (→ a different rollout
    // option). In the JSON corpus these encode via the `{"$num": ...}` tag
    // (export-corpus.ts) since `JSON.stringify` collapses all three to `null`.
    // The JS runner reads the in-memory `CORPUS_RULES` (real NaN/±Infinity),
    // so it needs no decode; the 14 native runners decode `{"$num"}`.
    {
      description:
        'numberToStringConversionNaN (TextEquals 28): Custom1=NaN (number) → "NaN" matches → percentage option',
      configId: RULES_CONFIG,
      key: "numberToStringConversionNaN",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: NaN } } as unknown as User,
      expected: "3",
    },
    {
      description:
        'numberToStringConversionPositiveInf (TextEquals 28): Custom1=Infinity → "Infinity" matches → percentage option',
      configId: RULES_CONFIG,
      key: "numberToStringConversionPositiveInf",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: Infinity } } as unknown as User,
      expected: "4",
    },
    {
      description:
        'numberToStringConversionNegativeInf (TextEquals 28): Custom1=-Infinity → "-Infinity" matches → percentage option',
      configId: RULES_CONFIG,
      key: "numberToStringConversionNegativeInf",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: -Infinity } } as unknown as User,
      expected: "3",
    },
    {
      description:
        'dateToStringConversionNaN (TextEquals 28): Custom1=NaN (number) → "NaN" matches → percentage option',
      configId: RULES_CONFIG,
      key: "dateToStringConversionNaN",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: NaN } } as unknown as User,
      expected: "3",
    },
    {
      description:
        'dateToStringConversionPositiveInf (TextEquals 28): Custom1=Infinity → "Infinity" matches → percentage option',
      configId: RULES_CONFIG,
      key: "dateToStringConversionPositiveInf",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: Infinity } } as unknown as User,
      expected: "1",
    },
    {
      description:
        'dateToStringConversionNegativeInf (TextEquals 28): Custom1=-Infinity → "-Infinity" matches → percentage option',
      configId: RULES_CONFIG,
      key: "dateToStringConversionNegativeInf",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Custom1: -Infinity } } as unknown as User,
      expected: "5",
    },
  ];

  // ---- Segment-condition matrix (spec 145 / #390): IS-IN-SEGMENT (c:0) and
  //      IS-NOT-IN-SEGMENT (c:1), covering a HASHED segment and a cleartext
  //      segment. Ported 1:1 from `testmatrix_segments.csv` (the
  //      developerAndBetaUserSegment [hashed] / developerAndBetaUserCleartextSegment
  //      columns) + the vendored `content-by-key.json` segment config
  //      (`configcat-sdk-1/.../h99HYXWWNE2bH8eWyLAVMA`, segments `Developers`
  //      and `Beta Users (cleartext)`).
  //
  //      The DIMENSION here is the rule's segment reference, not a comparator:
  //      a rule condition is `{ s: { s: <index>, c: 0|1 } }`, referencing a
  //      named segment in the config's top-level `s[]`
  //      (`{ n: <name>, r: [<bare user conditions>] }`). The segment's `r[]`
  //      is AND-grouped; the user IS-IN the segment iff every condition matches,
  //      and IS-NOT-IN (c:1) negates that membership.
  //
  //      CRITICAL salt rule (the spec-128/129 lesson): a HASHED condition INSIDE
  //      a segment salts with the SEGMENT NAME — `SHA-256(value + p.s +
  //      <segment-name>)` — NOT the setting key. The `Developers` segment's
  //      Email IS-ONE-OF operands are pre-hashed against this config's `p.s`
  //      salt + the segment name "Developers" (computed via
  //      `sdk-shared/src/hash.ts` `hashComparisonValue`, NEVER hand-authored —
  //      the #388 lesson). A wrong salt → silent non-match.
  //
  //      Segment membership (ported from the upstream config's operands):
  //        - `Developers` (HASHED, c:16 SENSITIVE_IS_ONE_OF): {kate@, john@}.
  //        - `Beta Users (cleartext)` (c:0 IS_ONE_OF): {jane@, john@}.
  //      Three single-segment-condition settings reference them:
  //        - `segDeveloperIsInDogDefaultCat`     IS-IN Developers (c:0) → Dog/Cat
  //        - `segBetaCleartextIsInDogDefaultCat` IS-IN Beta cleartext (c:0) → Dog/Cat
  //        - `segDeveloperIsNotInDogDefaultCat`  IS-NOT-IN Developers (c:1) → Dog/Cat
  //
  //      Per CSV (developerAndBetaUserSegment is the compound
  //      `IS-IN Developers AND IS-NOT-IN Beta Users` setting; the rows confirm
  //      the segment memberships used here): kate@ is in Developers; jane@ is
  //      not in Developers but is in Beta Users (cleartext). No-user / missing
  //      Email → the segment condition is the missing-user error (returned
  //      un-negated, so IS-NOT-IN does NOT flip it into a match) → the rule does
  //      not match → base Cat. Only STRING user attributes are used (the
  //      string-only SDK runners, #394/#468). Appended after the existing 177
  //      tuples (byte-stability, FR-004).
  const segmentConditions: ParityTuple[] = [
    // ---- IS-IN-SEGMENT, HASHED segment: Developers {kate@, john@} → Dog ----
    {
      description:
        "segDeveloperIsInDogDefaultCat (IS-IN Developers, hashed segment): no user → base Cat (segment needs a user)",
      configId: RULES_CONFIG,
      key: "segDeveloperIsInDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "segDeveloperIsInDogDefaultCat (IS-IN Developers, hashed segment): Email kate@example.com in Developers (segment-name salt) → Dog",
      configId: RULES_CONFIG,
      key: "segDeveloperIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "kate", email: "kate@example.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "segDeveloperIsInDogDefaultCat (IS-IN Developers, hashed segment): Email jane@example.com not in Developers → Cat",
      configId: RULES_CONFIG,
      key: "segDeveloperIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "jane", email: "jane@example.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- IS-IN-SEGMENT, cleartext segment: Beta Users (cleartext) {jane@, john@} → Dog ----
    {
      description:
        "segBetaCleartextIsInDogDefaultCat (IS-IN Beta Users cleartext): no user → base Cat (segment needs a user)",
      configId: RULES_CONFIG,
      key: "segBetaCleartextIsInDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "segBetaCleartextIsInDogDefaultCat (IS-IN Beta Users cleartext): Email jane@example.com in Beta Users (cleartext) → Dog",
      configId: RULES_CONFIG,
      key: "segBetaCleartextIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "jane", email: "jane@example.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "segBetaCleartextIsInDogDefaultCat (IS-IN Beta Users cleartext): Email kate@example.com not in Beta Users (cleartext) → Cat",
      configId: RULES_CONFIG,
      key: "segBetaCleartextIsInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "kate", email: "kate@example.com" } as unknown as User,
      expected: "Cat",
    },

    // ---- IS-NOT-IN-SEGMENT (inversion), hashed segment: NOT IN Developers → Dog ----
    {
      description:
        "segDeveloperIsNotInDogDefaultCat (IS-NOT-IN Developers, hashed segment): no user → missing-user error un-negated → base Cat",
      configId: RULES_CONFIG,
      key: "segDeveloperIsNotInDogDefaultCat",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        "segDeveloperIsNotInDogDefaultCat (IS-NOT-IN Developers, hashed segment): Email jane@example.com NOT in Developers → Dog",
      configId: RULES_CONFIG,
      key: "segDeveloperIsNotInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "jane", email: "jane@example.com" } as unknown as User,
      expected: "Dog",
    },
    {
      description:
        "segDeveloperIsNotInDogDefaultCat (IS-NOT-IN Developers, hashed segment): Email kate@example.com in Developers → Cat",
      configId: RULES_CONFIG,
      key: "segDeveloperIsNotInDogDefaultCat",
      defaultValue: "default",
      user: { identifier: "kate", email: "kate@example.com" } as unknown as User,
      expected: "Cat",
    },
  ];

  // ---- Percentage-rollout DIMENSION (spec 146 / #385): deterministic
  //      hash-bucketing through the public getValue. Setting
  //      `string75Cat0Dog25Falcon0Horse` (ported 1:1 from the canonical config
  //      `content-by-key.json`) carries a setting-level `p[]` percentage-options
  //      array — Cat 75% [0,75) / Dog 0% / Falcon 25% [75,100) / Horse 0% —
  //      with base served value "Chicken" (no-user fallback). The bucket is the
  //      DETERMINISTIC `parseInt(sha1(settingKey + Identifier).substring(0,7),
  //      16) % 100` (no config salt — percentage bucketing is unsalted, unlike
  //      the sensitive comparators), accumulated across option widths. Each
  //      `expected` is the deterministic served option for that exact
  //      Identifier (FR-002/FR-004), verified against the engine's recipe:
  //        - Identifier "12345" → bucket 21 → [0,75) → Cat (matches the upstream
  //          `options_based_on_user_id.json` returnValue exactly)
  //        - Identifier "0"     → bucket 88 → [75,100) → Falcon (a DIFFERENT
  //          option, so the cumulative-range mapping past the Dog 0%-width
  //          boundary is exercised)
  //        - no user            → no Identifier to bucket → base served "Chicken"
  //          (the configured no-user fallback, upstream `..._no_user` case)
  //      Only the STRING Identifier attribute is used (#468). Appended after the
  //      existing 186 tuples (byte-stability, FR-005).
  const percentageOptions: ParityTuple[] = [
    {
      description:
        "string75Cat0Dog25Falcon0Horse (% rollout): no user → no Identifier to bucket → base served Chicken",
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0Horse",
      defaultValue: "default",
      expected: "Chicken",
    },
    {
      description:
        'string75Cat0Dog25Falcon0Horse (% rollout): Identifier "12345" → bucket 21 ∈ [0,75) → Cat',
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0Horse",
      defaultValue: "default",
      user: { identifier: "12345" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        'string75Cat0Dog25Falcon0Horse (% rollout): Identifier "0" → bucket 88 ∈ [75,100) → Falcon (different option)',
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0Horse",
      defaultValue: "default",
      user: { identifier: "0" } as unknown as User,
      expected: "Falcon",
    },
  ];

  // ---- Percentage-option PLACEMENT variants (spec 147 / #397): deterministic
  //      hash-bucketing through the public getValue, exercising WHERE the `p[]`
  //      block sits and WHICH attribute keys the bucket. Each setting is ported
  //      1:1 from its vendored `evaluationlog/options_*` fixture + canonical
  //      config; bucketing is the same UNSALTED `parseInt(sha1(settingKey +
  //      attrValue).substring(0,7), 16) % 100` accumulated across option widths,
  //      so the upstream returnValues (settingKey + attrValue only, salt-
  //      independent) transfer verbatim. STRING attributes only (#468).
  //      Appended after the existing 189 tuples (byte-stability, FR-004).
  const placementOptions: ParityTuple[] = [
    // AFTER-rule: setting-level p[] served when the rule FAILS; the rule wins
    // when it matches. `integer25One25Two25Three25FourAdvancedRules` (int):
    // One/Two/Three/Four 25% each, rule Email CONTAINS "@configcat.com" → 5,
    // base -1. (options_after_targeting_rule.json)
    {
      description: "after-rule: no user → no rule match + no Identifier to bucket → base served -1",
      configId: RULES_CONFIG,
      key: "integer25One25Two25Three25FourAdvancedRules",
      defaultValue: 42,
      expected: -1,
    },
    {
      description:
        'after-rule: Identifier "12345" + Email "joe@example.com" (rule FAILS) → fall through to setting p[]: bucket 25 ∈ [25,50) → Two → 2',
      configId: RULES_CONFIG,
      key: "integer25One25Two25Three25FourAdvancedRules",
      defaultValue: 42,
      user: { identifier: "12345", email: "joe@example.com" } as unknown as User,
      expected: 2,
    },
    {
      description:
        'after-rule: Identifier "12345" + Email "joe@configcat.com" (rule MATCHES) → rule fixed value 5 wins (no bucketing)',
      configId: RULES_CONFIG,
      key: "integer25One25Two25Three25FourAdvancedRules",
      defaultValue: 42,
      user: { identifier: "12345", email: "joe@configcat.com" } as unknown as User,
      expected: 5,
    },
    // WITHIN-rule: the MATCHED rule's served value is itself a r[].p split keyed
    // by Country (a=Country). `stringContainsString75Cat0Dog25Falcon0HorseDefaultCat`
    // (string): rule Email CONTAINS "@configcat.com" → split Cat 75% [0,75) /
    // Falcon 25% [75,100), base "Cat". (options_within_targeting_rule.json)
    {
      description: 'within-rule: Email "joe@example.com" (rule does NOT match) → base served Cat',
      configId: RULES_CONFIG,
      key: "stringContainsString75Cat0Dog25Falcon0HorseDefaultCat",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@example.com" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        'within-rule: Email "joe@configcat.com" (rule MATCHES) + Country "US" → rule split bucket 70 ∈ [0,75) → Cat (matches upstream)',
      configId: RULES_CONFIG,
      key: "stringContainsString75Cat0Dog25Falcon0HorseDefaultCat",
      defaultValue: "default",
      user: {
        identifier: "12345",
        email: "joe@configcat.com",
        country: "US",
      } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        'within-rule: Email "joe@configcat.com" (rule MATCHES) + Country "JP" → rule split bucket 80 ∈ [75,100) → Falcon (distinct from base Cat)',
      configId: RULES_CONFIG,
      key: "stringContainsString75Cat0Dog25Falcon0HorseDefaultCat",
      defaultValue: "default",
      user: {
        identifier: "12345",
        email: "joe@configcat.com",
        country: "JP",
      } as unknown as User,
      expected: "Falcon",
    },
    // BY-CUSTOM-ATTR: a=Country selects the bucketing attribute (NOT Identifier)
    // for a setting-level p[]. `string75Cat0Dog25Falcon0HorseCustomAttr`
    // (string): Cat 75% [0,75) / Falcon 25% [75,100), base "Chicken".
    // (options_based_on_custom_attr.json)
    {
      description:
        'custom-attr: Identifier "12345" but NO Country attr → no bucket → base served Chicken',
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0HorseCustomAttr",
      defaultValue: "default",
      user: { identifier: "12345" } as unknown as User,
      expected: "Chicken",
    },
    {
      description:
        'custom-attr: Country "US" → bucket keyed by Country = 70 ∈ [0,75) → Cat (matches upstream)',
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0HorseCustomAttr",
      defaultValue: "default",
      user: { identifier: "12345", country: "US" } as unknown as User,
      expected: "Cat",
    },
    {
      description:
        'custom-attr: Country "DE" → bucket keyed by Country = 79 ∈ [75,100) → Falcon (different option)',
      configId: RULES_CONFIG,
      key: "string75Cat0Dog25Falcon0HorseCustomAttr",
      defaultValue: "default",
      user: { identifier: "12345", country: "DE" } as unknown as User,
      expected: "Falcon",
    },
  ];

  // ---- prerequisite-flag conditions (spec 148 / #387) ------------------
  // Single-level prerequisite resolution + circular-dependency detection,
  // ported 1:1 from the vendored evaluationlog/prerequisite_flag.json (the
  // mainStringFlag → stringDependsOnString pair, JoGwdqJZ config) and
  // evaluationlog/circular_dep.json + _overrides/test_circulardependency_v6.json
  // (the key2 ↔ key3 circular pair). A prerequisite condition
  // (`{ p: { f: <prereqKey>, c: 0|1, v: <value> } }`) is satisfied only when
  // the prerequisite flag's resolved value EQUALS (c:0) the expected `v`. A
  // circular chain (key2's prereq is key3, key3's prereq is key2) is DETECTED
  // by the shared visited-stack and FAILS CLOSED — the dependent flag returns
  // the SDK-call default. STRING attributes only (#468).
  const prerequisiteConditions: ParityTuple[] = [
    // -- prerequisite-SATISFIED: mainStringFlag serves "private" for
    //    kate@configcat.com → stringDependsOnString's prereq (EQUALS
    //    "private") holds → the dependent rule serves "Dog".
    {
      description:
        'prereq-satisfied: Email kate@configcat.com → mainStringFlag="private" → stringDependsOnString prereq EQUALS "private" holds → Dog',
      configId: RULES_CONFIG,
      key: "stringDependsOnString",
      defaultValue: "default",
      user: { identifier: "12345", email: "kate@configcat.com" } as unknown as User,
      expected: "Dog",
    },
    // -- prerequisite-NOT-satisfied (fallback): with no user (and with a
    //    non-targeted email) mainStringFlag serves its base "public" → the
    //    prereq EQUALS "private" fails → the dependent flag falls back to its
    //    own base value "Cat".
    {
      description:
        'prereq-not-satisfied: no user → mainStringFlag="public" → stringDependsOnString prereq EQUALS "private" fails → fallback Cat',
      configId: RULES_CONFIG,
      key: "stringDependsOnString",
      defaultValue: "default",
      expected: "Cat",
    },
    {
      description:
        'prereq-not-satisfied: Email joe@example.com → mainStringFlag="public" → stringDependsOnString prereq EQUALS "private" fails → fallback Cat',
      configId: RULES_CONFIG,
      key: "stringDependsOnString",
      defaultValue: "default",
      user: { identifier: "12345", email: "joe@example.com" } as unknown as User,
      expected: "Cat",
    },
    // -- the prerequisite flag itself resolves normally through public
    //    getValue: mainStringFlag serves "private" for the targeted email,
    //    "public" otherwise (proves the prereq flag exists as its own setting).
    {
      description: 'prereq flag: mainStringFlag base value "public" (no user)',
      configId: RULES_CONFIG,
      key: "mainStringFlag",
      defaultValue: "default",
      expected: "public",
    },
    {
      description: 'prereq flag: mainStringFlag Email kate@configcat.com → rule serves "private"',
      configId: RULES_CONFIG,
      key: "mainStringFlag",
      defaultValue: "default",
      user: { identifier: "12345", email: "kate@configcat.com" } as unknown as User,
      expected: "private",
    },
    // -- CIRCULAR-detected (fallback): key2's prereq is key3, key3's prereq is
    //    key2. Evaluating key2 recurses into key3, which recurses back into
    //    key2 — the shared visited-stack detects the cycle and the engine
    //    fails closed, so public getValue returns the SDK-call default.
    //    Ported 1:1 from circular_dep.json (key2/key4 → "default").
    {
      description:
        "circular-detected: key2 → prereq key3 → prereq key2 (cycle) → engine fails closed → SDK default",
      configId: RULES_CONFIG,
      key: "key2",
      defaultValue: "default",
      expected: "default",
    },
    {
      description:
        "circular-detected: key3 → prereq key2 → prereq key3 (cycle) → engine fails closed → SDK default",
      configId: RULES_CONFIG,
      key: "key3",
      defaultValue: "default",
      expected: "default",
    },
  ];

  // ---- Attribute-validation error paths (spec 149 / #396): a MALFORMED user
  //      attribute for a number / semver / datetime comparator makes the
  //      attribute→typed conversion ERROR; the engine treats a condition error
  //      as the rule NOT matching and continues to the next rule / served
  //      fallback — NOT a crash, NOT a spurious match (sdk-shared
  //      comparators.ts `invalidAttr` + evaluator.ts: a non-`true` condition
  //      outcome skips the rule). Ported 1:1 from the vendored
  //      `evaluationlog/number_validation.json` (key `number`,
  //      Custom1="not_a_number" → returnValue "Default"),
  //      `semver_validation.json` (keys `isNotOneOf` AND `relations`,
  //      Custom1="wrong_semver" → "Default") and `epoch_date_validation.json`
  //      (a malformed dotted-date attribute → fallback; the upstream fixture
  //      uses Custom1="2023.04.10", which `getUserAttributeValueAsUnixSeconds`
  //      rejects as not a valid Unix timestamp — fed here to the existing
  //      `datetimeBeforeDogDefaultCat` DateTimeBefore (18) rule on its `Date`
  //      attribute → fallback to base "default"). Plus the long-list /
  //      truncation resolution case ported 1:1 from `list_truncation.json` +
  //      its `_overrides/test_list_truncation.json` (`booleanKey1`: one rule,
  //      three AND `Identifier CONTAINS ANY OF <long list>` conditions, user
  //      Identifier="12" → "12" contains "1"/"2" so every list matches → rule
  //      serves true; truncation is a LOG concern, not a resolution concern, so
  //      the resolved value is unaffected). The malformed attributes are STRING
  //      values only (#468) — no typed-attribute dependency. Each `expected`
  //      traces to a fixture `returnValue` (FR-002/FR-007). Appended after the
  //      existing 205 tuples (byte-stability, FR-004).
  const validationErrors: ParityTuple[] = [
    // -- malformed NUMBER: Custom1="not_a_number" for NumberNotEquals (11, d:5)
    //    → conversion error → rule no-match → base "Default"
    //    (number_validation.json: key `number`, returnValue "Default").
    {
      description:
        'validation: number (NumberNotEquals 5) Custom1="not_a_number" → conversion error → rule no-match → base Default',
      configId: RULES_CONFIG,
      key: "number",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: "not_a_number" } } as unknown as User,
      expected: "Default",
    },
    // -- malformed SEMVER: Custom1="wrong_semver" for SemVerIsNotOneOf (5)
    //    → unparseable user version → error → rule no-match → base "Default"
    //    (semver_validation.json: key `isNotOneOf`, returnValue "Default").
    {
      description:
        'validation: isNotOneOf (SemVerIsNotOneOf) Custom1="wrong_semver" → unparseable semver → rule no-match → base Default',
      configId: RULES_CONFIG,
      key: "isNotOneOf",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: "wrong_semver" } } as unknown as User,
      expected: "Default",
    },
    // -- malformed SEMVER (relations): Custom1="wrong_semver" for the
    //    SemVerLess/LessOrEquals/Greater/GreaterOrEquals (6/7/8/9) chain
    //    → unparseable user version → every relation errors → rule no-match →
    //    base "Default" (semver_validation.json: key `relations`, "Default").
    {
      description:
        'validation: relations (SemVer relations 6-9) Custom1="wrong_semver" → unparseable semver → rule no-match → base Default',
      configId: RULES_CONFIG,
      key: "relations",
      defaultValue: "default",
      user: { identifier: "12345", custom: { Custom1: "wrong_semver" } } as unknown as User,
      expected: "Default",
    },
    // -- malformed EPOCH: Date="2023.04.10" for DateTimeBefore (18, d:1693497600)
    //    → not a valid Unix timestamp → conversion error → rule no-match → base
    //    "default" (epoch_date_validation.json malformed-attribute pattern; the
    //    dotted-date value the upstream fixture feeds is rejected by the
    //    Unix-seconds conversion exactly like the fixture's returnValue path).
    {
      description:
        'validation: datetimeBeforeDogDefaultCat (DateTimeBefore) Date="2023.04.10" → invalid Unix timestamp → rule no-match → base default',
      configId: RULES_CONFIG,
      key: "datetimeBeforeDogDefaultCat",
      defaultValue: "fallback",
      user: { identifier: "12345", custom: { Date: "2023.04.10" } } as unknown as User,
      expected: "default",
    },
    // -- long-list / truncation resolution: booleanKey1, one rule with three
    //    AND `Identifier CONTAINS ANY OF <long list>` conditions; Identifier="12"
    //    is a substring-match for every list → all three match → rule serves
    //    true. Truncation only shrinks the LOG, never the resolution
    //    (list_truncation.json: key `booleanKey1`, returnValue true).
    {
      description:
        'validation: booleanKey1 long IS-CONTAINS lists, Identifier="12" matches every list → rule serves true (truncation is log-only)',
      configId: RULES_CONFIG,
      key: "booleanKey1",
      defaultValue: false,
      user: { identifier: "12" } as unknown as User,
      expected: true,
    },
  ];

  // ---- Variation-ID resolution (spec 150 / #395, decimals re-added spec 152 /
  //      #475): the boolean / decimal / text / whole settings ported 1:1 from
  //      the canonical config (each with
  //      its base `i`, its targeting rule's `s.i`, and its setting-level `p[]`
  //      percentage-option `i`s) + the (user → expected variationId) cases from
  //      `fixtures/upstream/testmatrix_variationId.csv`. These tuples carry
  //      `expectedVariationId`, so the JS-family runner ALSO asserts
  //      `getValueDetails(...).variationId` (the variationId seam). Value-only
  //      tuples above are unaffected (no `expectedVariationId` → value-only).
  //
  //      The targeted attribute is Email — a CLEARTEXT comparator (CONTAINS
  //      `@configcat.com`, IS-ONE-OF `@test.com`/`a@test.com`/`b@test.com`), so
  //      these settings do NOT depend on this config's salt and port verbatim.
  //      STRING attributes only (#468). variationId provenance, per CSV column:
  //        - base (`##null##` row): boolean a0e56eda / decimal 63612d39 /
  //          text 3f05be89 / whole cf2e9162 (the setting's own `i`).
  //        - rule-served (`a@configcat.com` row): boolean 67787ae4 /
  //          decimal 8f9559cf / text 9bdc6a1f / whole ab30533b (the matched
  //          rule's `s.i`).
  //        - rule-served `@test.com` (`a@test.com` row): decimal d66c5781 /
  //          text 65310deb (the second matched rule's `s.i`).
  //        - percentage-served (`bryanw@verizon.net` row, no @configcat/@test
  //          match → setting-level `p[]` bucket on Identifier): decimal
  //          d0dbc27f / text 30ba32b9 / whole 61a5a033 / boolean a0e56eda.
  //      `expected` is the served VALUE (b/d/s/i) for that same path; the
  //      variationId is the option's `i`. Appended after the existing 210
  //      tuples (byte-stability: the new optional field does not alter any
  //      existing tuple's serialized bytes).
  //
  //      DECIMALS RE-ADDED (spec 152 / #475): the 4 decimal variationId tuples
  //      (and the `decimal` setting) descoped in #395 are restored 1:1 from
  //      `testmatrix_variationId.csv` (variationIds 63612d39 / 8f9559cf /
  //      d66c5781 / d0dbc27f). JS resolves them via numeric equality; the
  //      non-JS runners compare values numerically (spec 152 US2).
  const variationIdCases: ParityTuple[] = [
    // -- base (no user): each setting's own `i` (##null## CSV row) --
    {
      description: "variationId: boolean no user → base false, variationId a0e56eda (setting `i`)",
      configId: RULES_CONFIG,
      key: "boolean",
      defaultValue: true,
      expected: false,
      expectedVariationId: "a0e56eda",
    },
    {
      description: "variationId: decimal no user → base 0, variationId 63612d39 (setting `i`)",
      configId: RULES_CONFIG,
      key: "decimal",
      defaultValue: -1,
      expected: 0,
      expectedVariationId: "63612d39",
    },
    {
      description: 'variationId: text no user → base "c", variationId 3f05be89 (setting `i`)',
      configId: RULES_CONFIG,
      key: "text",
      defaultValue: "default",
      expected: "c",
      expectedVariationId: "3f05be89",
    },
    {
      description: "variationId: whole no user → base 999999, variationId cf2e9162 (setting `i`)",
      configId: RULES_CONFIG,
      key: "whole",
      defaultValue: -1,
      expected: 999999,
      expectedVariationId: "cf2e9162",
    },
    // -- rule-served (Email a@configcat.com): the matched rule's `s.i` --
    {
      description:
        "variationId: boolean Email a@configcat.com → rule true, variationId 67787ae4 (rule `s.i`)",
      configId: RULES_CONFIG,
      key: "boolean",
      defaultValue: false,
      user: { identifier: "id", email: "a@configcat.com" } as unknown as User,
      expected: true,
      expectedVariationId: "67787ae4",
    },
    {
      description:
        "variationId: decimal Email a@configcat.com → rule -2147483647.2147484, variationId 8f9559cf (rule `s.i`)",
      configId: RULES_CONFIG,
      key: "decimal",
      defaultValue: -1,
      user: { identifier: "id", email: "a@configcat.com" } as unknown as User,
      expected: -2147483647.2147484,
      expectedVariationId: "8f9559cf",
    },
    {
      description:
        'variationId: text Email a@configcat.com → rule "true", variationId 9bdc6a1f (rule `s.i`)',
      configId: RULES_CONFIG,
      key: "text",
      defaultValue: "default",
      user: { identifier: "id", email: "a@configcat.com" } as unknown as User,
      expected: "true",
      expectedVariationId: "9bdc6a1f",
    },
    {
      description:
        "variationId: whole Email a@configcat.com → rule 1, variationId ab30533b (rule `s.i`)",
      configId: RULES_CONFIG,
      key: "whole",
      defaultValue: -1,
      user: { identifier: "id", email: "a@configcat.com" } as unknown as User,
      expected: 1,
      expectedVariationId: "ab30533b",
    },
    // -- rule-served (Email a@test.com): the second matched rule's `s.i` --
    {
      description:
        "variationId: decimal Email a@test.com → rule 0.12345678912345678, variationId d66c5781 (rule `s.i`)",
      configId: RULES_CONFIG,
      key: "decimal",
      defaultValue: -1,
      user: { identifier: "id", email: "a@test.com" } as unknown as User,
      expected: 0.12345678912345678,
      expectedVariationId: "d66c5781",
    },
    {
      description:
        'variationId: text Email a@test.com → rule "false", variationId 65310deb (rule `s.i`)',
      configId: RULES_CONFIG,
      key: "text",
      defaultValue: "default",
      user: { identifier: "id", email: "a@test.com" } as unknown as User,
      expected: "false",
      expectedVariationId: "65310deb",
    },
    // -- percentage-served (Email bryanw@verizon.net: no @configcat/@test match
    //    → setting-level p[] bucket on Identifier): the matched option's `i`.
    //    Ported 1:1 from the testmatrix_variationId.csv bryanw@verizon.net row.
    {
      description:
        "variationId: boolean Identifier bryanw@verizon.net → percentage option false, variationId a0e56eda (option `i`)",
      configId: RULES_CONFIG,
      key: "boolean",
      defaultValue: true,
      user: {
        identifier: "bryanw@verizon.net",
        email: "bryanw@verizon.net",
      } as unknown as User,
      expected: false,
      expectedVariationId: "a0e56eda",
    },
    {
      description:
        "variationId: decimal Identifier bryanw@verizon.net → percentage option 1, variationId d0dbc27f (option `i`)",
      configId: RULES_CONFIG,
      key: "decimal",
      defaultValue: -1,
      user: {
        identifier: "bryanw@verizon.net",
        email: "bryanw@verizon.net",
      } as unknown as User,
      expected: 1,
      expectedVariationId: "d0dbc27f",
    },
    {
      description:
        'variationId: text Identifier bryanw@verizon.net → percentage option "a", variationId 30ba32b9 (option `i`)',
      configId: RULES_CONFIG,
      key: "text",
      defaultValue: "default",
      user: {
        identifier: "bryanw@verizon.net",
        email: "bryanw@verizon.net",
      } as unknown as User,
      expected: "a",
      expectedVariationId: "30ba32b9",
    },
    {
      description:
        "variationId: whole Identifier bryanw@verizon.net → percentage option -1, variationId 61a5a033 (option `i`)",
      configId: RULES_CONFIG,
      key: "whole",
      defaultValue: -999,
      user: {
        identifier: "bryanw@verizon.net",
        email: "bryanw@verizon.net",
      } as unknown as User,
      expected: -1,
      expectedVariationId: "61a5a033",
    },
  ];

  return [
    ...oneRule,
    ...twoRules,
    ...textComparators,
    ...numberComparators,
    ...semverComparators,
    ...sensitiveComparators,
    ...arrayComparators,
    ...unicodeComparators,
    ...andOrConditionGroups,
    ...datetimeComparators,
    ...attrConversionAndTrimming,
    ...segmentConditions,
    ...percentageOptions,
    ...placementOptions,
    ...prerequisiteConditions,
    ...validationErrors,
    ...variationIdCases,
    ...attrConversion,
  ];
}

/**
 * The shared 58-tuple boolean corpus. Every Confeature SDK runs this.
 */
export const CORPUS: readonly ParityTuple[] = build();

/**
 * The typed `SettingType × value` extension corpus (spec 066 / #253).
 *
 * A **separate** deliverable: SDKs opt into it as they implement typed
 * values (#254-#261). Boolean-only SDKs never load it.
 */
export const CORPUS_TYPED: readonly ParityTuple[] = buildTyped();

/**
 * The targeting-rule corpus (spec 135 / #383).
 *
 * A **separate** deliverable injected through the full-config rule engine
 * (`createFlagOverridesFromConfig`). SDKs opt into it once they adopt the
 * full-config override path; a runner that lacks the capability SKIPs these
 * tuples with a reason, never resolves them on the flat-map path (SC-004).
 */
export const CORPUS_RULES: readonly ParityTuple[] = buildRules();

/**
 * Programmatic getter — exposed so test runners can filter or count
 * without depending on the array name directly.
 */
export function getCorpus(): readonly ParityTuple[] {
  return CORPUS;
}

/**
 * Programmatic getter for the typed extension corpus (spec 066 / #253).
 */
export function getCorpusTyped(): readonly ParityTuple[] {
  return CORPUS_TYPED;
}

/**
 * Programmatic getter for the targeting-rule corpus (spec 135 / #383).
 */
export function getCorpusRules(): readonly ParityTuple[] {
  return CORPUS_RULES;
}
