// SPDX-License-Identifier: MIT

/**
 * ConfigCat-compatible evaluation-log trace builder (ADR 0003 / #495).
 *
 * Produces the byte-identical indented textual trace ConfigCat's SDKs emit
 * during flag evaluation — its `evaluationlog/` test corpus is the byte-oracle.
 * This builder is the REFERENCE implementation the JS family consumes directly
 * and every native federation port mirrors (epic #494).
 *
 * Scope of this phase (#495): the **no-targeting-rule path** — the
 * `Evaluating '<key>'` header + the `Returning '<value>'.` footer — which is
 * byte-identical for the `simple_value` scenario. The rule-walk / condition /
 * percentage-option / prerequisite middle sections are threaded through
 * `RolloutEvaluator` by the sibling children (#497–#500); the indentation
 * primitives below are the seam they build on.
 *
 * The trace is emitted via the SDK logger at the INFO level under event id
 * 5000 (ConfigCat's verbosity contract) — see `RolloutEvaluator.evaluate`.
 */

import {
  type IUserCondition,
  PrerequisiteFlagComparator,
  SegmentComparator,
  UserComparator,
} from "./config-json.ts";

/** ConfigCat indents each nested eval-log line by two spaces per level. */
const INDENT_UNIT = "  ";

// Placeholders ConfigCat substitutes for malformed condition parts (parity
// with configcat-common's EvaluateLogBuilder).
const INVALID_VALUE_PLACEHOLDER = "<invalid value>";
const INVALID_NAME_PLACEHOLDER = "<invalid name>";
const INVALID_OPERATOR_PLACEHOLDER = "<invalid operator>";

/** Max IS-ONE-OF / list items rendered before truncation (configcat parity). */
const STRING_LIST_MAX_LENGTH = 10;

/**
 * Format a string list for the eval log exactly as configcat-common's
 * `formatStringList` (Utils.ts): `'a', 'b'` joined by `, `, with an optional
 * truncation appendix once `maxLength` is exceeded.
 */
function formatStringList(
  items: readonly string[],
  maxLength: number,
  getOmittedItemsText: (count: number) => string,
): string {
  const length = items.length;
  if (!length) {
    return "";
  }
  let appendix = "";
  let shown = items;
  if (maxLength > 0 && length > maxLength) {
    shown = items.slice(0, maxLength);
    appendix = getOmittedItemsText(length - maxLength);
  }
  return "'" + shown.join("', '") + "'" + appendix;
}

/**
 * Per-comparator eval-log metadata (configcat-common parity), as
 * `[token, kind, sensitive]` — `token` is the operator rendering, `kind`
 * selects the condition value slot (`l`=list, `s`=string, `n`=number,
 * `dt`=datetime), `sensitive` masks the value as `<hashed value>`. One table
 * drives BOTH `formatUserComparator` and `appendUserCondition`, replacing two
 * 36-way switches (DRY + a leaner browser bundle — Principle I, SC-002).
 */
type ComparatorKind = "l" | "s" | "n" | "dt";
const COMPARATOR_META: Readonly<Record<number, readonly [string, ComparatorKind, boolean]>> = {
  [UserComparator.TextIsOneOf]: ["IS ONE OF", "l", false],
  [UserComparator.TextIsNotOneOf]: ["IS NOT ONE OF", "l", false],
  [UserComparator.TextContainsAnyOf]: ["CONTAINS ANY OF", "l", false],
  [UserComparator.TextNotContainsAnyOf]: ["NOT CONTAINS ANY OF", "l", false],
  [UserComparator.SemVerIsOneOf]: ["IS ONE OF", "l", false],
  [UserComparator.SemVerIsNotOneOf]: ["IS NOT ONE OF", "l", false],
  [UserComparator.SemVerLess]: ["<", "s", false],
  [UserComparator.SemVerLessOrEquals]: ["<=", "s", false],
  [UserComparator.SemVerGreater]: [">", "s", false],
  [UserComparator.SemVerGreaterOrEquals]: [">=", "s", false],
  [UserComparator.NumberEquals]: ["=", "n", false],
  [UserComparator.NumberNotEquals]: ["!=", "n", false],
  [UserComparator.NumberLess]: ["<", "n", false],
  [UserComparator.NumberLessOrEquals]: ["<=", "n", false],
  [UserComparator.NumberGreater]: [">", "n", false],
  [UserComparator.NumberGreaterOrEquals]: [">=", "n", false],
  [UserComparator.SensitiveTextIsOneOf]: ["IS ONE OF", "l", true],
  [UserComparator.SensitiveTextIsNotOneOf]: ["IS NOT ONE OF", "l", true],
  [UserComparator.DateTimeBefore]: ["BEFORE", "dt", false],
  [UserComparator.DateTimeAfter]: ["AFTER", "dt", false],
  [UserComparator.SensitiveTextEquals]: ["EQUALS", "s", true],
  [UserComparator.SensitiveTextNotEquals]: ["NOT EQUALS", "s", true],
  [UserComparator.SensitiveTextStartsWithAnyOf]: ["STARTS WITH ANY OF", "l", true],
  [UserComparator.SensitiveTextNotStartsWithAnyOf]: ["NOT STARTS WITH ANY OF", "l", true],
  [UserComparator.SensitiveTextEndsWithAnyOf]: ["ENDS WITH ANY OF", "l", true],
  [UserComparator.SensitiveTextNotEndsWithAnyOf]: ["NOT ENDS WITH ANY OF", "l", true],
  [UserComparator.SensitiveArrayContainsAnyOf]: ["ARRAY CONTAINS ANY OF", "l", true],
  [UserComparator.SensitiveArrayNotContainsAnyOf]: ["ARRAY NOT CONTAINS ANY OF", "l", true],
  [UserComparator.TextEquals]: ["EQUALS", "s", false],
  [UserComparator.TextNotEquals]: ["NOT EQUALS", "s", false],
  [UserComparator.TextStartsWithAnyOf]: ["STARTS WITH ANY OF", "l", false],
  [UserComparator.TextNotStartsWithAnyOf]: ["NOT STARTS WITH ANY OF", "l", false],
  [UserComparator.TextEndsWithAnyOf]: ["ENDS WITH ANY OF", "l", false],
  [UserComparator.TextNotEndsWithAnyOf]: ["NOT ENDS WITH ANY OF", "l", false],
  [UserComparator.ArrayContainsAnyOf]: ["ARRAY CONTAINS ANY OF", "l", false],
  [UserComparator.ArrayNotContainsAnyOf]: ["ARRAY NOT CONTAINS ANY OF", "l", false],
};

/** Render a {@link UserComparator} as ConfigCat's eval-log operator token. */
export function formatUserComparator(comparator: UserComparator): string {
  return COMPARATOR_META[comparator]?.[0] ?? INVALID_OPERATOR_PLACEHOLDER;
}

/**
 * ConfigCat's event id for the "config evaluated" INFO log line. Passed to the
 * logger as the eventId so the captured trace reads `… [5000] …`, matching the
 * upstream `evaluationlog/` expected outputs.
 */
export const EVAL_LOG_EVENT_ID = "5000";

export class EvaluateLogBuilder {
  private readonly chunks: string[] = [];
  private indentLevel = 0;

  /** `eol` defaults to `"\n"` — the byte the upstream `.txt` oracle uses. */
  constructor(private readonly eol = "\n") {}

  /** Append text to the current line. */
  append(text: string): this {
    this.chunks.push(text);
    return this;
  }

  /** Break to a new line at the current indent, then optionally append `text`. */
  newLine(text?: string): this {
    this.chunks.push(this.eol + INDENT_UNIT.repeat(this.indentLevel));
    if (text !== undefined) {
      this.chunks.push(text);
    }
    return this;
  }

  increaseIndent(): this {
    this.indentLevel++;
    return this;
  }

  decreaseIndent(): this {
    if (this.indentLevel > 0) {
      this.indentLevel--;
    }
    return this;
  }

  // ---- condition formatting (ADR 0003 / #497) ------------------------------
  // Ports configcat-common's EvaluateLogBuilder condition rendering, adapted to
  // Confeature's compact `IUserCondition` ({ a, c, s?/d?/l? }) — the value lives
  // in `l` (list comparators), `s` (string / sensitive-equals), or `d`
  // (number / datetime).

  private appendUserConditionCore(attr: string, comparator: UserComparator, value?: unknown): this {
    // `String(...)` is what the template literal already does at runtime;
    // making it explicit narrows the `unknown` value to `string` for the
    // type checker (restrict-template-expressions) — byte-identical output.
    const rendered = String(value ?? INVALID_VALUE_PLACEHOLDER);
    return this.append(`User.${attr} ${formatUserComparator(comparator)} '${rendered}'`);
  }

  private appendUserConditionString(
    attr: string,
    comparator: UserComparator,
    value: string | undefined,
    isSensitive: boolean,
  ): this {
    if (typeof value !== "string") {
      return this.appendUserConditionCore(attr, comparator);
    }
    return this.appendUserConditionCore(attr, comparator, !isSensitive ? value : "<hashed value>");
  }

  private appendUserConditionStringList(
    attr: string,
    comparator: UserComparator,
    values: readonly string[] | undefined,
    isSensitive: boolean,
  ): this {
    if (!Array.isArray(values)) {
      return this.appendUserConditionCore(attr, comparator);
    }
    const comparatorText = formatUserComparator(comparator);
    if (isSensitive) {
      const word = values.length === 1 ? "value" : "values";
      return this.append(`User.${attr} ${comparatorText} [<${values.length} hashed ${word}>]`);
    }
    const listText = formatStringList(
      values,
      STRING_LIST_MAX_LENGTH,
      (count) => `, ... <${count} more ${count === 1 ? "value" : "values"}>`,
    );
    return this.append(`User.${attr} ${comparatorText} [${listText}]`);
  }

  private appendUserConditionNumber(
    attr: string,
    comparator: UserComparator,
    value: number | undefined,
    isDateTime: boolean,
  ): this {
    if (typeof value !== "number") {
      return this.appendUserConditionCore(attr, comparator);
    }
    const comparatorText = formatUserComparator(comparator);
    let date: Date;
    return isDateTime && !isNaN((date = new Date(value * 1000)) as unknown as number)
      ? this.append(`User.${attr} ${comparatorText} '${value}' (${date.toISOString()} UTC)`)
      : this.append(`User.${attr} ${comparatorText} '${value}'`);
  }

  /** Render one user condition (`User.<attr> <COMP> <value>`). */
  appendUserCondition(condition: IUserCondition): this {
    const attr = typeof condition.a === "string" ? condition.a : INVALID_NAME_PLACEHOLDER;
    const c = condition.c;
    const meta = COMPARATOR_META[c];
    if (!meta) {
      return this.appendUserConditionCore(attr, c, condition.s ?? condition.d ?? condition.l);
    }
    const [, kind, sensitive] = meta;
    switch (kind) {
      case "l":
        return this.appendUserConditionStringList(attr, c, condition.l, sensitive);
      case "s":
        return this.appendUserConditionString(attr, c, condition.s, sensitive);
      case "n":
        return this.appendUserConditionNumber(attr, c, condition.d, false);
      case "dt":
        return this.appendUserConditionNumber(attr, c, condition.d, true);
    }
  }

  /** Append a single condition's boolean result (` => true` / ` => false, …`). */
  appendConditionConsequence(result: boolean): this {
    this.append(` => ${result}`);
    return result ? this : this.append(", skipping the remaining AND conditions");
  }

  /**
   * Append a targeting rule's THEN consequence (configcat-common parity):
   *
   *   ` THEN 'Dog' => MATCH, applying rule`   (newLine=false, single-line)
   *   `\n  THEN 'Dog' => no match`            (newLine=true, indented line)
   *
   * `thenValue` is the rule's formatted served value (e.g. `Dog`) for a
   * fixed-value rule, or `undefined` for a rule serving `% options`.
   * `isMatchOrError` is `true` (MATCH), `false` (no match), or an error
   * string (e.g. `cannot evaluate, User Object is missing`).
   */
  appendTargetingRuleConsequence(
    thenValue: string | undefined,
    isMatchOrError: boolean | string,
    newLine: boolean,
  ): this {
    this.increaseIndent();
    (newLine ? this.newLine() : this.append(" ")).append("THEN");
    this.append(thenValue !== undefined ? ` '${thenValue}'` : " % options");
    this.append(" => ").append(
      isMatchOrError === true
        ? "MATCH, applying rule"
        : isMatchOrError === false
          ? "no match"
          : isMatchOrError,
    );
    return this.decreaseIndent();
  }

  /** Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`). */
  appendPrerequisiteFlagCondition(
    prereqKey: string,
    comparator: PrerequisiteFlagComparator,
    comparisonValue: string,
  ): this {
    const op = comparator === PrerequisiteFlagComparator.NotEquals ? "NOT EQUALS" : "EQUALS";
    return this.append(`Flag '${prereqKey}' ${op} '${comparisonValue}'`);
  }

  /** Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`). */
  appendSegmentCondition(segmentName: string, comparator: SegmentComparator): this {
    const op = comparator === SegmentComparator.IsNotIn ? "IS NOT IN SEGMENT" : "IS IN SEGMENT";
    return this.append(`User ${op} '${segmentName}'`);
  }

  /** Append a bare boolean condition result (`true` / `false`). */
  appendConditionResult(result: boolean): this {
    return this.append(`${result}`);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

/**
 * Format a resolved SETTING value for the eval log (ConfigCat parity):
 * boolean → `true`/`false` (lowercase), string → verbatim, number → its
 * decimal string. Mirrors the `'<value>'` token in ConfigCat's
 * `Returning '<value>'.` footer.
 */
export function settingValueToString(value: boolean | string | number): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}
