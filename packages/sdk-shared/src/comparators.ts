// SPDX-License-Identifier: MIT

/**
 * The 36 ConfigCat `UserComparator` operations (research.md §R4), ported
 * field-for-field from common-js `RolloutEvaluator.ts`
 * (`github.com/configcat/common-js`, verified against
 * `configcat-common@9.4.1`).
 *
 * Each comparator returns a {@link ConditionOutcome}: `true` (match), `false`
 * (no match), or `{ error }` (a validation / conversion failure — bad semver,
 * non-numeric number, non-array array). An error short-circuits the AND group
 * like `false` but is surfaced rather than silently swallowed (FR-010).
 *
 * The six families:
 *
 *   - **text** (cleartext, case-SENSITIVE, no trim): equals/notEquals,
 *     isOneOf/isNotOneOf, contains/notContains, startsWith/endsWith (+Not).
 *   - **sensitive text** (SHA-256 SALTED): the positional twins of the text
 *     family, comparing `hashComparisonValue(text, configSalt, contextSalt)`
 *     against the config's hashed operand. The startsWith/endsWith variants
 *     hash a BYTE-length-prefixed slice (`"<len>_<hash>"`).
 *   - **semver** (on {@link parseSemVer}): isOneOf/isNotOneOf + the four
 *     relations; an unparseable USER value errors, an unparseable OPERAND is a
 *     non-match (backward-compat, matching upstream).
 *   - **number** (strict whole-string parse, `,`→`.`): the six relations.
 *   - **datetime** (Before/After, Unix seconds): the two relations.
 *   - **array** (contains/notContains, cleartext + sensitive): membership.
 *
 * Attribute conversion + the missing-attribute / no-user gates live in the
 * evaluator's condition dispatch; the functions here receive an already
 * type-converted operand (text/number/version/array) and apply the operator.
 */

import { hashComparisonValue, sha256Bytes } from "./hash.ts";
import { parseSemVer, type SemVer } from "./semver.ts";
import { UserComparator } from "./config-json.ts";
import type { ConditionOutcome } from "./evaluator.ts";

// ---------------------------------------------------------------------------
// Attribute conversion helpers (common-js RolloutEvaluator.ts)
// ---------------------------------------------------------------------------

/** True iff every element of `value` is a string (common-js `isStringArray`). */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string");
}

/**
 * Stringify a user-attribute value exactly as common-js
 * `userAttributeValueToString`: `string` verbatim; `Date` → Unix **seconds**
 * (`getTime()/1000`); string array → `JSON.stringify`; else `+ ""`.
 */
export function userAttributeValueToString(
  value: string | number | boolean | readonly string[] | Date,
): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.getTime() / 1000 + "";
  if (isStringArray(value)) return JSON.stringify(value);
  return value + "";
}

/**
 * Strict whole-string float parse, mirroring common-js `parseFloatStrict`:
 * rejects empty / all-whitespace and a leading `0` followed by a non-digit/
 * non-`.`/non-`e` (octal / hex), else `+value`. JS's `parseFloat` is too
 * forgiving (prefix parse, hex), so `"12abc"` must be `NaN`.
 */
export function parseFloatStrict(value: string): number {
  if (!value.length || /^\s*$|^\s*0[^\d.eE]/.test(value)) return NaN;
  return +value;
}

// ---------------------------------------------------------------------------
// Sensitive hashing (length-prefixed slice scheme)
// ---------------------------------------------------------------------------

/**
 * Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator
 * (common-js `hashComparisonValueSlice`):
 * `sha256(sliceUtf8Bytes ++ utf8Bytes(configSalt) ++ utf8Bytes(contextSalt))`.
 *
 * The slice is raw bytes (a byte-boundary cut of the attribute, which may land
 * mid-codepoint), so the hash MUST run over the concatenated **byte** sequence
 * — re-encoding a binary string as UTF-8 would corrupt multibyte attributes
 * (the `testmatrix_unicode` `*Hashed` rows). Hence {@link sha256Bytes}.
 */
function hashComparisonValueSlice(
  sliceUtf8: Uint8Array,
  configJsonSalt: string,
  contextSalt: string,
): string {
  const enc = new TextEncoder();
  const saltBytes = enc.encode(configJsonSalt);
  const ctxBytes = enc.encode(contextSalt);
  const buf = new Uint8Array(sliceUtf8.length + saltBytes.length + ctxBytes.length);
  buf.set(sliceUtf8, 0);
  buf.set(saltBytes, sliceUtf8.length);
  buf.set(ctxBytes, sliceUtf8.length + saltBytes.length);
  return sha256Bytes(buf);
}

// ---------------------------------------------------------------------------
// Text — cleartext (case-sensitive, no trim)
// ---------------------------------------------------------------------------

export function evaluateTextEquals(
  text: string,
  comparisonValue: string,
  negate: boolean,
): boolean {
  return (text === comparisonValue) !== negate;
}

export function evaluateTextIsOneOf(
  text: string,
  comparisonValues: readonly string[],
  negate: boolean,
): boolean {
  return comparisonValues.indexOf(text) >= 0 !== negate;
}

export function evaluateTextContainsAnyOf(
  text: string,
  comparisonValues: readonly string[],
  negate: boolean,
): boolean {
  for (let i = 0; i < comparisonValues.length; i++) {
    if (text.indexOf(comparisonValues[i] as string) >= 0) return !negate;
  }
  return negate;
}

/**
 * Cleartext startsWith/endsWith-any-of. `startsWith` selects the prefix check
 * (`lastIndexOf(item, 0) === 0`) vs the suffix check
 * (`indexOf(item, text.length - item.length) >= 0`). Items longer than the
 * text are skipped.
 */
export function evaluateTextSliceEqualsAnyOf(
  text: string,
  comparisonValues: readonly string[],
  startsWith: boolean,
  negate: boolean,
): boolean {
  for (let i = 0; i < comparisonValues.length; i++) {
    const item = comparisonValues[i] as string;
    if (text.length < item.length) continue;
    const result =
      (startsWith ? text.lastIndexOf(item, 0) : text.indexOf(item, text.length - item.length)) >= 0;
    if (result) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Text — sensitive (SHA-256 salted)
// ---------------------------------------------------------------------------

export function evaluateSensitiveTextEquals(
  text: string,
  comparisonValue: string,
  configJsonSalt: string,
  contextSalt: string,
  negate: boolean,
): boolean {
  const hash = hashComparisonValue(text, configJsonSalt, contextSalt);
  return (hash === comparisonValue) !== negate;
}

export function evaluateSensitiveTextIsOneOf(
  text: string,
  comparisonValues: readonly string[],
  configJsonSalt: string,
  contextSalt: string,
  negate: boolean,
): boolean {
  const hash = hashComparisonValue(text, configJsonSalt, contextSalt);
  return comparisonValues.indexOf(hash) >= 0 !== negate;
}

/**
 * Sensitive startsWith/endsWith-any-of. Each operand is `"<byteLen>_<hash>"`;
 * the SDK hashes the matching-length BYTE prefix/suffix of the attribute and
 * compares to `<hash>`. Slicing is over the UTF-8 binary string (not code
 * points), matching common-js `evaluateSensitiveTextSliceEqualsAnyOf`.
 */
export function evaluateSensitiveTextSliceEqualsAnyOf(
  text: string,
  comparisonValues: readonly string[],
  configJsonSalt: string,
  contextSalt: string,
  startsWith: boolean,
  negate: boolean,
): boolean {
  const textUtf8 = new TextEncoder().encode(text);
  for (let i = 0; i < comparisonValues.length; i++) {
    const item = comparisonValues[i] as string;
    const index = item.indexOf("_");
    const sliceLength = parseInt(item.slice(0, index), 10);
    if (textUtf8.length < sliceLength) continue;
    const sliceUtf8 = startsWith
      ? textUtf8.subarray(0, sliceLength)
      : textUtf8.subarray(textUtf8.length - sliceLength);
    const hash = hashComparisonValueSlice(sliceUtf8, configJsonSalt, contextSalt);
    if (hash === item.slice(index + 1)) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

/**
 * Semver IS-ONE-OF / IS-NOT-ONE-OF (comparators 4/5). Each operand is trimmed
 * first; an operand that is empty AFTER trimming (incl. whitespace-only) is
 * skipped — matching ConfigCat, which trims before the empty check. A non-empty
 * but unparseable operand makes the whole comparator `false` (backward-compat).
 * Iterates ALL operands (no early-out on match) to match upstream's "none
 * invalid" requirement.
 */
export function evaluateSemVerIsOneOf(
  version: SemVer,
  comparisonValues: readonly string[],
  negate: boolean,
): boolean {
  let result = false;
  for (let i = 0; i < comparisonValues.length; i++) {
    const item = (comparisonValues[i] as string).trim();
    if (!item.length) continue;
    const version2 = parseSemVer(item);
    if (!version2) return false;
    if (!result && version.compare(version2) === 0) result = true;
  }
  return result !== negate;
}

/**
 * Semver relations (comparators 6–9). An unparseable operand is a non-match
 * (`false`), matching upstream `evaluateSemVerRelation`.
 */
export function evaluateSemVerRelation(
  version: SemVer,
  comparator: UserComparator,
  comparisonValue: string,
): boolean {
  const version2 = parseSemVer(comparisonValue.trim());
  if (!version2) return false;
  const cmp = version.compare(version2);
  switch (comparator) {
    case UserComparator.SemVerLess:
      return cmp < 0;
    case UserComparator.SemVerLessOrEquals:
      return cmp <= 0;
    case UserComparator.SemVerGreater:
      return cmp > 0;
    case UserComparator.SemVerGreaterOrEquals:
      return cmp >= 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

export function evaluateNumberRelation(
  num: number,
  comparator: UserComparator,
  comparisonValue: number,
): boolean {
  switch (comparator) {
    case UserComparator.NumberEquals:
      return num === comparisonValue;
    case UserComparator.NumberNotEquals:
      return num !== comparisonValue;
    case UserComparator.NumberLess:
      return num < comparisonValue;
    case UserComparator.NumberLessOrEquals:
      return num <= comparisonValue;
    case UserComparator.NumberGreater:
      return num > comparisonValue;
    case UserComparator.NumberGreaterOrEquals:
      return num >= comparisonValue;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Datetime (Unix seconds)
// ---------------------------------------------------------------------------

export function evaluateDateTimeRelation(
  seconds: number,
  comparisonValue: number,
  before: boolean,
): boolean {
  return before ? seconds < comparisonValue : seconds > comparisonValue;
}

// ---------------------------------------------------------------------------
// Array (cleartext + sensitive)
// ---------------------------------------------------------------------------

export function evaluateArrayContainsAnyOf(
  array: readonly string[],
  comparisonValues: readonly string[],
  negate: boolean,
): boolean {
  for (let i = 0; i < array.length; i++) {
    if (comparisonValues.indexOf(array[i] as string) >= 0) return !negate;
  }
  return negate;
}

export function evaluateSensitiveArrayContainsAnyOf(
  array: readonly string[],
  comparisonValues: readonly string[],
  configJsonSalt: string,
  contextSalt: string,
  negate: boolean,
): boolean {
  for (let i = 0; i < array.length; i++) {
    const hash = hashComparisonValue(array[i] as string, configJsonSalt, contextSalt);
    if (comparisonValues.indexOf(hash) >= 0) return !negate;
  }
  return negate;
}

// ---------------------------------------------------------------------------
// Attribute → typed value, with three-valued error outcome (FR-010)
// ---------------------------------------------------------------------------

/** Result of an attribute conversion: the typed value, or an error string. */
type ConvertResult<T> = { ok: true; value: T } | { ok: false; error: string };

const invalidAttr = (attr: string, reason: string): { ok: false; error: string } => ({
  ok: false,
  error: `cannot evaluate, the User.${attr} attribute is invalid (${reason})`,
});

const invalidComparisonValue = (value: string, reason: string): { ok: false; error: string } => ({
  ok: false,
  error: `comparison value '${value}' is invalid (${reason})`,
});

/** Attribute → text (string verbatim; else stringified — never errors). */
export function attributeAsText(
  value: string | number | boolean | readonly string[] | Date,
): string {
  return typeof value === "string" ? value : userAttributeValueToString(value);
}

/** Attribute → semver, or a validation error (common-js getUserAttributeValueAsSemVer). */
export function attributeAsSemVer(
  attr: string,
  value: string | number | boolean | readonly string[] | Date,
): ConvertResult<SemVer> {
  if (typeof value === "string") {
    const version = parseSemVer(value.trim());
    if (version) return { ok: true, value: version };
  }
  return invalidAttr(
    attr,
    `'${userAttributeValueToString(value)}' is not a valid semantic version`,
  );
}

/** Attribute → number, or a validation error (common-js getUserAttributeValueAsNumber). */
export function attributeAsNumber(
  attr: string,
  value: string | number | boolean | readonly string[] | Date,
): ConvertResult<number> {
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "string") {
    const num = parseFloatStrict(value.replace(",", "."));
    if (!Number.isNaN(num) || value.trim() === "NaN") return { ok: true, value: num };
  }
  return invalidAttr(attr, `'${userAttributeValueToString(value)}' is not a valid decimal number`);
}

/**
 * Attribute → Unix seconds, or a validation error (common-js
 * getUserAttributeValueAsUnixTimeSeconds). `Date` → `getTime()/1000`; a
 * numeric attribute is already seconds; a string is parsed strictly.
 */
export function attributeAsUnixTimeSeconds(
  attr: string,
  value: string | number | boolean | readonly string[] | Date,
): ConvertResult<number> {
  if (value instanceof Date) return { ok: true, value: value.getTime() / 1000 };
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "string") {
    const num = parseFloatStrict(value.replace(",", "."));
    if (!Number.isNaN(num) || value.trim() === "NaN") return { ok: true, value: num };
  }
  return invalidAttr(
    attr,
    `'${userAttributeValueToString(value)}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)`,
  );
}

/**
 * Attribute → string array, or a validation error (common-js
 * getUserAttributeValueAsStringArray). A string attribute is JSON-parsed; the
 * result must be a string array.
 */
export function attributeAsStringArray(
  attr: string,
  value: string | number | boolean | readonly string[] | Date,
): ConvertResult<readonly string[]> {
  let arr: unknown = value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      // Intentional: a non-JSON string is simply not a valid array and falls
      // through to the validation error below (matches common-js no-op catch).
    }
  }
  if (isStringArray(arr)) return { ok: true, value: arr };
  return invalidAttr(attr, `'${userAttributeValueToString(value)}' is not a valid string array`);
}

// ---------------------------------------------------------------------------
// Comparison value (config operand) → typed value, with the same three-valued
// error outcome (validation-order parity, #509). configcat-common validates
// the CONFIG comparison value BEFORE the user attribute for the semver
// relations, number relations, and datetime comparators; a malformed operand
// surfaces a distinct "comparison value '<v>' is invalid (<reason>)" error,
// which wins even when the user attribute is ALSO malformed.
// ---------------------------------------------------------------------------

/**
 * Comparison value → semver (config operand for the semver relations). Mirrors
 * configcat-common's `getComparisonValueAsSemVer`: a non-parseable operand is a
 * comparison-value error carrying ConfigCat's canonical reason. The operand is
 * trimmed before parsing (parity with {@link evaluateSemVerRelation}).
 */
export function comparisonValueAsSemVer(value: string): ConvertResult<SemVer> {
  const version = parseSemVer(value.trim());
  if (version) return { ok: true, value: version };
  return invalidComparisonValue(value, `'${value}' is not a valid semantic version`);
}

/**
 * Comparison value → number (config operand for the number relations). Mirrors
 * configcat-common's `getComparisonValueAsNumber`: a non-numeric operand is a
 * comparison-value error.
 */
export function comparisonValueAsNumber(value: number | undefined): ConvertResult<number> {
  if (typeof value === "number" && !Number.isNaN(value)) return { ok: true, value };
  return invalidComparisonValue(String(value), `'${value}' is not a valid decimal number`);
}

/**
 * Comparison value → Unix seconds (config operand for the datetime
 * comparators). Mirrors configcat-common's `getComparisonValueAsNumber` for the
 * BEFORE/AFTER comparators: a non-numeric operand is a comparison-value error.
 */
export function comparisonValueAsUnixTimeSeconds(value: number | undefined): ConvertResult<number> {
  if (typeof value === "number" && !Number.isNaN(value)) return { ok: true, value };
  return invalidComparisonValue(
    String(value),
    `'${value}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)`,
  );
}

/** Re-export so the evaluator can build a `{ error }` outcome from a string. */
export function errorOutcome(error: string): ConditionOutcome {
  return { error };
}
