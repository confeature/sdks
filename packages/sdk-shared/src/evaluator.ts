// SPDX-License-Identifier: MIT

import {
  attributeAsNumber,
  attributeAsSemVer,
  attributeAsStringArray,
  attributeAsText,
  attributeAsUnixTimeSeconds,
  comparisonValueAsNumber,
  comparisonValueAsSemVer,
  comparisonValueAsUnixTimeSeconds,
  evaluateArrayContainsAnyOf,
  evaluateDateTimeRelation,
  evaluateNumberRelation,
  evaluateSemVerIsOneOf,
  evaluateSemVerRelation,
  evaluateSensitiveArrayContainsAnyOf,
  evaluateSensitiveTextEquals,
  evaluateSensitiveTextIsOneOf,
  evaluateSensitiveTextSliceEqualsAnyOf,
  evaluateTextContainsAnyOf,
  evaluateTextEquals,
  evaluateTextIsOneOf,
  evaluateTextSliceEqualsAnyOf,
  userAttributeValueToString,
} from "./comparators.ts";
import {
  type ICondition,
  type IPercentageOption,
  type IPrerequisiteFlagCondition,
  type ISegment,
  type ISegmentCondition,
  type ISetting,
  type ISettingValue,
  type ITargetingRule,
  type IUserCondition,
  SegmentComparator,
  SettingType,
  UserComparator,
} from "./config-json.ts";
import { sha1 } from "./hash.ts";
import { EVAL_LOG_EVENT_ID, EvaluateLogBuilder, settingValueToString } from "./eval-log.ts";
import { LogLevel, type LoggerWrapper } from "./logger.ts";
import { CircularDependencyError, evaluatePrerequisiteFlagCondition } from "./prerequisites.ts";
import type { ProjectConfig } from "./project-config.ts";
import { getUserAttribute, type User } from "./user.ts";

const MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing";
const missingUserAttributeError = (attr: string): string =>
  `cannot evaluate, the User.${attr} attribute is missing`;

/**
 * Conditional that mirrors `configcat-common`'s `SettingTypeOf`. Lets
 * `getValueAsync<T>` infer the return type from the caller's
 * `defaultValue` literal — so passing `false` narrows to `boolean`.
 *
 * The actual mapping in `configcat-common` is more elaborate (it covers
 * `SettingTypeMap`); the conditional here covers the four ConfigCat
 * `SettingType`s — `boolean → boolean`, `string → string`,
 * `int`/`double` → `number` — plus `null` / `undefined` fallbacks for
 * type-system compatibility.
 */
export type SettingTypeOf<T> = T extends boolean
  ? boolean
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends null
        ? null
        : T extends undefined
          ? undefined
          : T;

/**
 * Shape returned from `getValueDetailsAsync`. Mirrors
 * `configcat-common`'s `IEvaluationDetails`. v1 fills the bare minimum;
 * `matchedTargetingRule`, `matchedPercentageOption`, `variationId` and
 * `user` are populated only when meaningful.
 */
export interface IEvaluationDetails<TValue = unknown> {
  key: string;
  value: TValue;
  variationId?: string;
  fetchTime?: Date;
  user?: User;
  isDefaultValue: boolean;
  errorMessage?: string;
  errorException?: unknown;
  matchedTargetingRule?: ITargetingRule | undefined;
  matchedPercentageOption?: IPercentageOption | undefined;
}

/**
 * The JS `typeof` string a `defaultValue` and an extracted setting
 * value must carry, keyed by the `config_v6` `SettingType` discriminator
 * — `0`=Boolean → `"boolean"`, `1`=String → `"string"`, `2`=Int /
 * `3`=Double → `"number"`. The `int` vs `double` distinction is the `t`
 * discriminator and the `v` envelope key, not the JS primitive type
 * (JS has one `number` type).
 */
const EXPECTED_JS_TYPE: Record<SettingType, "boolean" | "string" | "number"> = {
  [SettingType.Boolean]: "boolean",
  [SettingType.String]: "string",
  [SettingType.Int]: "number",
  [SettingType.Double]: "number",
};

/**
 * Read the typed value out of a `v` envelope, selecting the envelope key
 * (`b` / `s` / `i` / `d`) by the setting's `t` discriminator — `0`=Boolean →
 * `v.b`, `1`=String → `v.s`, `2`=Int → `v.i`, `3`=Double → `v.d`. The key is
 * chosen from `t`, never from the runtime shape of the parsed value
 * (research.md §R1).
 *
 * Takes the resolved `ISettingValue` envelope (rule-served, percentage-served,
 * or the statically served `setting.v`) plus the setting's declared type, so
 * the single envelope-key-by-`t` invariant is shared by every value source.
 */
function selectSettingValue(
  value: ISettingValue | undefined,
  type: SettingType,
): boolean | string | number | undefined {
  switch (type) {
    case SettingType.Boolean:
      return value?.b;
    case SettingType.String:
      return value?.s;
    case SettingType.Int:
      return value?.i;
    case SettingType.Double:
      return value?.d;
    default:
      return undefined;
  }
}

/**
 * Per-evaluation context threaded through rule / condition / prerequisite
 * resolution (research.md §R1, data-model §3). Mirrors common-js
 * `EvaluateContext`.
 *
 * `visitedFlags` is the shared cycle-detection stack for prerequisite-flag
 * resolution (research.md §R6); it is populated/popped by the rule engine in
 * a later phase. `configSalt` is the top-level config salt (`config.p.s`)
 * consumed by the sensitive (SHA-256-salted) comparators.
 */
export interface EvaluateContext {
  /** The setting key being evaluated (also the user-condition context salt). */
  readonly key: string;
  /** The setting under evaluation. */
  readonly setting: ISetting;
  /** All settings in the config (for prerequisite-flag re-evaluation). */
  readonly settings: Record<string, ISetting>;
  /** Top-level config segments (`config.s[]`) for segment conditions (US4). */
  readonly segments: readonly ISegment[];
  /** Top-level config salt (`config.p.s`) for sensitive comparators. */
  readonly configSalt: string;
  /** Optional user context. */
  readonly user?: User | undefined;
  /** Cycle-detection stack for prerequisite flags (shared across recursion). */
  readonly visitedFlags: string[];
  /**
   * Mutable evaluation-scoped flags / messages. `errorMessage` carries the
   * first surfaced condition error (missing user / missing attribute /
   * validation) up to the caller (FR-016); `missingUserObjectLogged` dedups
   * the no-user log to once per context (common-js parity).
   */
  state: { errorMessage?: string | undefined; missingUserObjectLogged: boolean };
  /**
   * Evaluation-log trace builder (ADR 0003 / #497), present only when the
   * logger is enabled at INFO. The rule walk appends the "Evaluating targeting
   * rules…" middle to it; `undefined` means tracing is off (zero cost).
   */
  logBuilder?: EvaluateLogBuilder | undefined;
}

/**
 * The user's attributes as the eval-log header renders them — a
 * Confeature-canonical object `{ Identifier, Email?, Country?, …custom }`,
 * `JSON.stringify`-d to `for User '…'` (ADR 0003 addendum, #497). This is the
 * configcat-js form; the vendored go-sdk oracle's `map[string]interface {}{…}`
 * is transformed to it in the corpus so the cross-SDK trace stays byte-identical.
 */
function userAttributesForLog(user: User): Record<string, unknown> {
  const attrs: Record<string, unknown> = { Identifier: user.identifier ?? "" };
  if (user.email !== undefined) attrs.Email = user.email;
  if (user.country !== undefined) attrs.Country = user.country;
  for (const [name, value] of Object.entries(user.custom)) {
    attrs[name] = value;
  }
  return attrs;
}

/**
 * Raw result of {@link RolloutEvaluator.evaluateSetting} — the resolved `v`
 * envelope plus the matched-rule / matched-option identity (data-model §3).
 * It deliberately does NOT select the JS primitive: the existing
 * TYPE_MISMATCH guard + {@link selectSettingValue} run identically on
 * rule-served, percentage-served, and statically served envelopes.
 */
export interface SettingResult {
  /** The resolved value envelope (served fallback, rule value, or % value). */
  value: ISettingValue;
  /** Variation id of the resolved value (rule / option / setting `i`). */
  variationId?: string | undefined;
  /** The matched targeting rule, when a rule decided the value. */
  matchedRule?: ITargetingRule | undefined;
  /** The matched percentage option, when a % option decided the value. */
  matchedOption?: IPercentageOption | undefined;
}

/**
 * Three-valued condition outcome (data-model §3, research.md §R5): `true`
 * (match), `false` (no match), or an `{ error }` (e.g. missing attribute on a
 * typed comparator, bad semver, detected cycle). An error short-circuits the
 * AND group like `false` but is surfaced rather than silently swallowed.
 *
 * Consumed by the comparator/condition engine in a later phase; declared here
 * so the seam types are stable before the rule logic lands.
 */
export type ConditionOutcome = true | false | { error: string };

/**
 * Typed rollout evaluator with fail-closed semantics. Resolves every
 * ConfigCat `SettingType` — a `boolean` setting to a `boolean`, a
 * `string` setting to a `string`, an `int` / `double` setting to a
 * `number` — by selecting the `v` envelope key from the setting's `t`
 * discriminator. Every branch resolves to a value of the caller's
 * chosen default type — no throws escape (research.md §R4).
 */
export class RolloutEvaluator {
  constructor(private readonly logger: LoggerWrapper) {}

  /**
   * Evaluate one setting against the supplied default. Returns the
   * caller's default for any reason that prevents a clean typed
   * resolution (missing key, type mismatch, malformed value, etc.).
   * The `defaultValue` must be type-compatible with the setting's
   * declared `SettingType`; a `null` default bypasses the type check.
   *
   * @param user accepted for API parity but ignored in v1 (no targeting).
   */
  evaluate<T>(
    config: ProjectConfig,
    key: string,
    defaultValue: T,
    user?: User,
  ): IEvaluationDetails<SettingTypeOf<T>> {
    const fetchTime = config.fetchTime > 0 ? new Date(config.fetchTime) : undefined;
    try {
      const settings = config.settings;
      const setting = settings[key];

      if (!setting) {
        this.logger.keyNotFound(key);
        return this.details(key, defaultValue, fetchTime, user, "Setting not found.");
      }

      const expectedType = EXPECTED_JS_TYPE[setting.t];
      if (expectedType === undefined) {
        this.logger.typeMismatch(key, "known SettingType", String(setting.t));
        return this.details(key, defaultValue, fetchTime, user, "Unknown setting type.");
      }

      // A `null` default bypasses the type check (mirrors `override-eval.ts`
      // Branch 6 + `configcat-js`); otherwise the default's JS primitive
      // type must match the setting's declared `SettingType`.
      if (defaultValue !== null && typeof defaultValue !== expectedType) {
        this.logger.typeMismatch(key, `${expectedType} default`, typeof defaultValue);
        return this.details(
          key,
          defaultValue,
          fetchTime,
          user,
          "Default value type does not match the setting type.",
        );
      }

      // Evaluation core (the seam, research.md §R1): resolve the setting to a
      // `v` envelope + matched-rule/option identity. In THIS phase the body
      // returns the statically served envelope (the no-rules path), so the
      // behavior is identical to before the seam existed. Later phases walk
      // `setting.r[]` / `setting.p` here. It is called BETWEEN the type guards
      // above and the envelope-value selection below, inside the same
      // fail-closed `try/catch`.
      // Evaluation-log trace (ADR 0003). Built lazily — only when the logger
      // would emit at INFO — and threaded through evaluateSetting via
      // ctx.logBuilder so the rule walk appends the "Evaluating targeting
      // rules…" middle. The header is appended here; the `Returning '<value>'.`
      // footer below; the whole multi-line trace is surfaced under event id 5000.
      let logBuilder: EvaluateLogBuilder | undefined;
      if (this.logger.isEnabled(LogLevel.Info)) {
        logBuilder = new EvaluateLogBuilder();
        logBuilder.append(`Evaluating '${key}'`);
        if (user) {
          logBuilder.append(` for User '${JSON.stringify(userAttributesForLog(user))}'`);
        }
      }

      const ctx: EvaluateContext = {
        key,
        setting,
        settings,
        segments: config.configJson?.s ?? [],
        configSalt: config.configJson?.p?.s ?? "",
        user,
        visitedFlags: [],
        state: { missingUserObjectLogged: false },
        logBuilder,
      };
      const result = this.evaluateSetting(ctx);

      // `v` envelope key chosen by `setting.t` — a present zero-value
      // (`""`, `0`, `false`) is a real value; only an absent / wrong-typed
      // slot is "missing". Runs identically on rule-served, percentage-served,
      // and statically served envelopes (research.md §R1).
      const value = selectSettingValue(result.value, setting.t);
      if (typeof value !== expectedType) {
        this.logger.typeMismatch(key, `${expectedType} setting value`, typeof value);
        return this.details(key, defaultValue, fetchTime, user, "Setting value is not present.");
      }

      if (logBuilder) {
        const served = value as boolean | string | number;
        logBuilder.newLine(`Returning '${settingValueToString(served)}'.`);
        this.logger.info(EVAL_LOG_EVENT_ID, logBuilder.toString());
      }

      // Happy path. `errorMessage` is set when a condition surfaced an error
      // (no-user / missing-attribute / validation) but evaluation still
      // resolved to a served value (FR-016) — the value is correct, the
      // message is informational.
      return {
        key,
        value: value as SettingTypeOf<T>,
        variationId: result.variationId ?? setting.i,
        fetchTime,
        user,
        isDefaultValue: false,
        errorMessage: ctx.state.errorMessage,
        matchedTargetingRule: result.matchedRule,
        matchedPercentageOption: result.matchedOption,
      };
    } catch (err) {
      // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002
      // (naming the setting + the chain), not the generic evaluation-error path.
      if (err instanceof CircularDependencyError) {
        this.logger.circularDependency(key, err.cycle);
        return this.details(key, defaultValue, fetchTime, user, err.message, err);
      }
      this.logger.evalError(key, err);
      return this.details(key, defaultValue, fetchTime, user, "Unexpected evaluation error.", err);
    }
  }

  /**
   * Resolve a setting to its `v` envelope + matched-rule/option identity
   * (research.md §R1, data-model §3). This is the structural seam where the
   * full ConfigCat decision engine — targeting-rule walk (`setting.r[]`,
   * first-match-wins), AND-grouped conditions, all 36 comparators, segments,
   * prerequisite flags, and percentage bucketing — will live (later phases:
   * US1–US5).
   *
   * In THIS phase the body is the **no-rules path only**: it returns the
   * statically served `setting.v` envelope and the setting's variation id,
   * with no matched rule/option. For a rule-less config this is byte-identical
   * to the pre-seam behavior, so the existing parity corpus + the
   * TYPE_MISMATCH/fail-closed contract are preserved exactly (SC-006). The
   * `EvaluateContext` (salt, settings, `visitedFlags`) is already threaded so
   * the rule engine can be added without changing this signature or the
   * caller.
   *
   * Called from {@link evaluate} inside its fail-closed `try/catch`; it does
   * not catch internally so a future cycle-detection throw propagates to that
   * outer frame (research.md §R6).
   */
  private evaluateSetting(ctx: EvaluateContext): SettingResult {
    const { setting } = ctx;

    // 1. Targeting rules — first-match-wins (US1).
    const rules = setting.r ?? [];
    if (rules.length > 0) {
      const ruleResult = this.evaluateTargetingRules(rules, ctx);
      if (ruleResult) return ruleResult;
    }

    // 2. Setting-level percentage options (US3).
    const options = setting.p ?? [];
    if (options.length > 0) {
      const optionResult = this.evaluatePercentageOptions(options, undefined, ctx);
      if (optionResult) return optionResult;
    }

    // 3. Served fallback `setting.v`.
    return { value: setting.v, variationId: setting.i };
  }

  /**
   * Walk `setting.r[]` in document order, returning the first rule whose
   * AND-grouped conditions all match (US1). A rule serving a fixed value
   * (`rule.s`) returns immediately; a rule serving percentage options
   * (`rule.p`) buckets — if bucketing is skippable (no user / missing attr)
   * the rule is ignored and evaluation continues, matching common-js
   * `evaluateTargetingRules`. Returns `undefined` when no rule decides.
   */
  private evaluateTargetingRules(
    rules: readonly ITargetingRule[],
    ctx: EvaluateContext,
  ): SettingResult | undefined {
    ctx.logBuilder?.newLine("Evaluating targeting rules and applying the first match if any:");
    for (const rule of rules) {
      const outcome = this.evaluateConditions(rule.c ?? [], ctx.key, ctx, rule);
      if (outcome !== true) {
        // A rule whose conditions ERRORED (missing user/attr) is ignored and
        // evaluation continues — ConfigCat emits this trace line. A rule that
        // merely did NOT match (false) just continues, with no such line.
        if (typeof outcome === "object") {
          ctx.logBuilder
            ?.increaseIndent()
            .newLine(
              "The current targeting rule is ignored and the evaluation continues with the next rule.",
            )
            .decreaseIndent();
        }
        continue;
      }

      // A rule serves either a fixed value (`s`) or percentage options (`p`).
      if (rule.s) {
        return { value: rule.s.v, variationId: rule.s.i, matchedRule: rule };
      }
      // A rule serving % options: the block is traced one level deeper (under
      // the rule). If the options can't resolve (no user / missing keying attr)
      // the rule is ignored and evaluation continues — same as configcat-common.
      const options = rule.p ?? [];
      ctx.logBuilder?.increaseIndent();
      const optionResult = this.evaluatePercentageOptions(options, rule, ctx);
      if (optionResult) {
        ctx.logBuilder?.decreaseIndent();
        return optionResult;
      }
      ctx.logBuilder
        ?.newLine(
          "The current targeting rule is ignored and the evaluation continues with the next rule.",
        )
        .decreaseIndent();
    }
    return undefined;
  }

  /**
   * Resolve a percentage-option list to its bucket (US3, research.md §R2):
   * `parseInt(sha1(key + attrValue).substring(0,7), 16) % 100`, keyed by the
   * setting's `a` attribute (default `Identifier`); accumulate option `p`
   * widths to find the bucket. Returns `undefined` (skip) when there is no
   * user or the keying attribute is missing — never throws on a skippable
   * condition. Mirrors common-js `evaluatePercentageOptions`.
   */
  private evaluatePercentageOptions(
    options: readonly IPercentageOption[],
    matchedRule: ITargetingRule | undefined,
    ctx: EvaluateContext,
  ): SettingResult | undefined {
    const lb = ctx.logBuilder;
    if (!ctx.user) {
      this.surfaceMissingUser(ctx);
      lb?.newLine("Skipping % options because the User Object is missing.");
      return undefined;
    }

    let attrName = ctx.setting.a;
    let attrValue: string | number | boolean | readonly string[] | Date | undefined;
    if (attrName == null) {
      attrName = "Identifier";
      attrValue = ctx.user.identifier ?? "";
    } else {
      attrValue = getUserAttribute(ctx.user, attrName);
    }
    if (attrValue == null) {
      ctx.state.errorMessage ??= missingUserAttributeError(attrName);
      this.logger.userObjectAttributeIsMissingForPercentage(ctx.key, attrName);
      lb?.newLine(`Skipping % options because the User.${attrName} attribute is missing.`);
      return undefined;
    }

    const sha1Hash = sha1(ctx.key + userAttributeValueToString(attrValue));
    const hashValue = parseInt(sha1Hash.substring(0, 7), 16) % 100;

    lb?.newLine(`Evaluating % options based on the User.${attrName} attribute:`);
    lb?.newLine(
      `- Computing hash in the [0..99] range from User.${attrName} => ${hashValue} (this value is sticky and consistent across all SDKs)`,
    );

    let bucket = 0;
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      bucket += option.p;
      if (hashValue >= bucket) continue;
      lb?.newLine(
        `- Hash value ${hashValue} selects % option ${i + 1} (${option.p}%), ` +
          `'${settingValueToString(selectSettingValue(option.v, ctx.setting.t)!)}'.`,
      );
      return {
        value: option.v,
        variationId: option.i,
        matchedRule,
        matchedOption: option,
      };
    }
    // Sum of widths < 100 — a malformed config. Throw so the outer
    // fail-closed frame returns the default (common-js throws here too).
    throw new Error("Sum of percentage option percentages is less than 100.");
  }

  /**
   * Evaluate a rule's (or segment's) AND-grouped condition list, short-
   * circuiting on the first non-match / error (research.md §R5). `true` =
   * every condition matched; `false` = a condition did not match; `{error}`
   * = a condition errored (missing user / attr / validation). Mirrors
   * common-js `evaluateConditions`. Dispatches user, prerequisite-flag (US4),
   * and segment (US4) conditions; a prereq cycle or malformed reference throws
   * to the outer fail-closed frame (research.md §R6).
   */
  private evaluateConditions(
    conditions: readonly ICondition[],
    contextSalt: string,
    ctx: EvaluateContext,
    rule?: ITargetingRule,
  ): ConditionOutcome {
    const lb = ctx.logBuilder;
    let result: ConditionOutcome = true;
    lb?.newLine("- ");
    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i]!;
      if (lb) {
        if (i === 0) {
          lb.append("IF ").increaseIndent();
        } else {
          lb.increaseIndent().newLine("AND ");
        }
      }
      if (condition.u) {
        result = this.evaluateUserCondition(condition.u, contextSalt, ctx);
      } else if (condition.p) {
        result = this.evaluatePrerequisiteCondition(condition.p, ctx);
      } else if (condition.s) {
        result = this.evaluateSegmentCondition(condition.s, ctx);
      } else {
        result = { error: "empty condition" };
      }
      if (lb) {
        // The go-sdk oracle always shows the per-condition consequence (even for
        // a single-condition rule, where configcat-js omits it) — match go.
        lb.appendConditionConsequence(result === true);
        lb.decreaseIndent();
      }
      if (result !== true) break;
    }
    // When evaluating a targeting rule (not a bare segment), append its THEN
    // consequence. The go oracle always newlines THEN when the rule has
    // conditions (`newLineBeforeThen = conditions.length > 0`).
    if (rule && lb) {
      const thenValue =
        rule.s !== undefined
          ? settingValueToString(selectSettingValue(rule.s.v, ctx.setting.t)!)
          : undefined;
      const isMatchOrError = result === true ? true : result === false ? false : result.error;
      lb.appendTargetingRuleConsequence(thenValue, isMatchOrError, conditions.length > 0);
    }
    return result;
  }

  /**
   * Dispatch one user condition to its comparator (US2). Returns `{error}` on
   * no-user / missing-attribute / typed-attribute validation failure (which
   * short-circuits the AND group like `false` but is surfaced — FR-010/FR-016).
   * Mirrors common-js `evaluateUserCondition`.
   */
  private evaluateUserCondition(
    condition: IUserCondition,
    contextSalt: string,
    ctx: EvaluateContext,
  ): ConditionOutcome {
    ctx.logBuilder?.appendUserCondition(condition);
    if (!ctx.user) {
      this.surfaceMissingUser(ctx);
      return { error: MISSING_USER_OBJECT_ERROR };
    }

    const attrName = condition.a;
    const attrValue = getUserAttribute(ctx.user, attrName);
    if (attrValue == null || attrValue === "") {
      const msg = missingUserAttributeError(attrName);
      ctx.state.errorMessage ??= msg;
      // ConfigCat logs a WARN (event 3003) per targeting rule whose attribute
      // is missing — not deduped per evaluation (AND short-circuit means one
      // per rule). The rule is then ignored (see evaluateTargetingRules).
      this.logger.userObjectAttributeIsMissing(ctx.key, attrName);
      return { error: msg };
    }

    const { configSalt } = ctx;
    const cmp = condition.c;
    const list = condition.l ?? [];
    const sv = condition.s ?? "";
    const dv = condition.d ?? 0;

    switch (cmp) {
      case UserComparator.TextEquals:
      case UserComparator.TextNotEquals:
        return evaluateTextEquals(
          attributeAsText(attrValue),
          sv,
          cmp === UserComparator.TextNotEquals,
        );
      case UserComparator.SensitiveTextEquals:
      case UserComparator.SensitiveTextNotEquals:
        return evaluateSensitiveTextEquals(
          attributeAsText(attrValue),
          sv,
          configSalt,
          contextSalt,
          cmp === UserComparator.SensitiveTextNotEquals,
        );
      case UserComparator.TextIsOneOf:
      case UserComparator.TextIsNotOneOf:
        return evaluateTextIsOneOf(
          attributeAsText(attrValue),
          list,
          cmp === UserComparator.TextIsNotOneOf,
        );
      case UserComparator.SensitiveTextIsOneOf:
      case UserComparator.SensitiveTextIsNotOneOf:
        return evaluateSensitiveTextIsOneOf(
          attributeAsText(attrValue),
          list,
          configSalt,
          contextSalt,
          cmp === UserComparator.SensitiveTextIsNotOneOf,
        );
      case UserComparator.TextStartsWithAnyOf:
      case UserComparator.TextNotStartsWithAnyOf:
        return evaluateTextSliceEqualsAnyOf(
          attributeAsText(attrValue),
          list,
          true,
          cmp === UserComparator.TextNotStartsWithAnyOf,
        );
      case UserComparator.SensitiveTextStartsWithAnyOf:
      case UserComparator.SensitiveTextNotStartsWithAnyOf:
        return evaluateSensitiveTextSliceEqualsAnyOf(
          attributeAsText(attrValue),
          list,
          configSalt,
          contextSalt,
          true,
          cmp === UserComparator.SensitiveTextNotStartsWithAnyOf,
        );
      case UserComparator.TextEndsWithAnyOf:
      case UserComparator.TextNotEndsWithAnyOf:
        return evaluateTextSliceEqualsAnyOf(
          attributeAsText(attrValue),
          list,
          false,
          cmp === UserComparator.TextNotEndsWithAnyOf,
        );
      case UserComparator.SensitiveTextEndsWithAnyOf:
      case UserComparator.SensitiveTextNotEndsWithAnyOf:
        return evaluateSensitiveTextSliceEqualsAnyOf(
          attributeAsText(attrValue),
          list,
          configSalt,
          contextSalt,
          false,
          cmp === UserComparator.SensitiveTextNotEndsWithAnyOf,
        );
      case UserComparator.TextContainsAnyOf:
      case UserComparator.TextNotContainsAnyOf:
        return evaluateTextContainsAnyOf(
          attributeAsText(attrValue),
          list,
          cmp === UserComparator.TextNotContainsAnyOf,
        );
      case UserComparator.SemVerIsOneOf:
      case UserComparator.SemVerIsNotOneOf: {
        const r = attributeAsSemVer(attrName, attrValue);
        return r.ok
          ? evaluateSemVerIsOneOf(r.value, list, cmp === UserComparator.SemVerIsNotOneOf)
          : this.invalidAttribute(ctx, r.error);
      }
      case UserComparator.SemVerLess:
      case UserComparator.SemVerLessOrEquals:
      case UserComparator.SemVerGreater:
      case UserComparator.SemVerGreaterOrEquals: {
        // configcat-common validates the CONFIG comparison value BEFORE the
        // user attribute (#509): a malformed operand wins even when the
        // attribute is also malformed.
        const cv = comparisonValueAsSemVer(sv);
        if (!cv.ok) return this.invalidComparisonValue(ctx, cv.error);
        const r = attributeAsSemVer(attrName, attrValue);
        return r.ok
          ? evaluateSemVerRelation(r.value, cmp, sv)
          : this.invalidAttribute(ctx, r.error);
      }
      case UserComparator.NumberEquals:
      case UserComparator.NumberNotEquals:
      case UserComparator.NumberLess:
      case UserComparator.NumberLessOrEquals:
      case UserComparator.NumberGreater:
      case UserComparator.NumberGreaterOrEquals: {
        const cv = comparisonValueAsNumber(condition.d);
        if (!cv.ok) return this.invalidComparisonValue(ctx, cv.error);
        const r = attributeAsNumber(attrName, attrValue);
        return r.ok
          ? evaluateNumberRelation(r.value, cmp, dv)
          : this.invalidAttribute(ctx, r.error);
      }
      case UserComparator.DateTimeBefore:
      case UserComparator.DateTimeAfter: {
        const cv = comparisonValueAsUnixTimeSeconds(condition.d);
        if (!cv.ok) return this.invalidComparisonValue(ctx, cv.error);
        const r = attributeAsUnixTimeSeconds(attrName, attrValue);
        return r.ok
          ? evaluateDateTimeRelation(r.value, dv, cmp === UserComparator.DateTimeBefore)
          : this.invalidAttribute(ctx, r.error);
      }
      case UserComparator.ArrayContainsAnyOf:
      case UserComparator.ArrayNotContainsAnyOf: {
        const r = attributeAsStringArray(attrName, attrValue);
        return r.ok
          ? evaluateArrayContainsAnyOf(r.value, list, cmp === UserComparator.ArrayNotContainsAnyOf)
          : this.invalidAttribute(ctx, r.error);
      }
      case UserComparator.SensitiveArrayContainsAnyOf:
      case UserComparator.SensitiveArrayNotContainsAnyOf: {
        const r = attributeAsStringArray(attrName, attrValue);
        return r.ok
          ? evaluateSensitiveArrayContainsAnyOf(
              r.value,
              list,
              configSalt,
              contextSalt,
              cmp === UserComparator.SensitiveArrayNotContainsAnyOf,
            )
          : this.invalidAttribute(ctx, r.error);
      }
      default:
        return { error: `unknown comparator ${String(cmp)}` };
    }
  }

  /**
   * Surface a typed-attribute conversion failure (bad semver / number /
   * datetime / array) — record the error for FR-016 AND emit the WARN 3004 that
   * ConfigCat logs per such rule (the rule is then ignored). `error` is the
   * `cannot evaluate, the User.<attr> attribute is invalid (<reason>)` message;
   * we split out the attribute + reason for the WARN.
   */
  private invalidAttribute(ctx: EvaluateContext, error: string): ConditionOutcome {
    ctx.state.errorMessage ??= error;
    const m = /^cannot evaluate, the User\.(.+?) attribute is invalid \((.+)\)$/u.exec(error);
    if (m) {
      this.logger.userObjectAttributeIsInvalid(ctx.key, m[1]!, m[2]!);
    }
    return { error };
  }

  /**
   * Surface a malformed CONFIG comparison value (#509). configcat-common
   * validates the operand before the user attribute for the semver / number /
   * datetime comparators; a malformed operand is reported with a distinct WARN
   * 3004 (NO "please check the User.<attr>…" suffix, unlike the
   * user-attribute path) and the rule is ignored. `error` is the
   * `comparison value '<v>' is invalid (<reason>)` message; we split out the
   * value + reason for the WARN.
   */
  private invalidComparisonValue(ctx: EvaluateContext, error: string): ConditionOutcome {
    ctx.state.errorMessage ??= error;
    this.logger.comparisonValueIsInvalid(ctx.key, error);
    return { error };
  }

  /**
   * Resolve a prerequisite-flag condition (US4, research.md §R6). Re-evaluates
   * the prerequisite flag `f` in a CHILD context (same config / user, shared
   * `visitedFlags`), comparing its resolved value to `v` by the prereq flag's
   * declared type. A detected cycle or a missing prereq flag throws to the
   * outer fail-closed frame (FR-007, SC-004). Delegates to
   * {@link evaluatePrerequisiteFlagCondition} (prerequisites.ts).
   */
  private evaluatePrerequisiteCondition(
    condition: IPrerequisiteFlagCondition,
    ctx: EvaluateContext,
  ): ConditionOutcome {
    const lb = ctx.logBuilder;
    if (lb) {
      const prereqType = ctx.settings[condition.f]?.t;
      const cmpVal =
        prereqType !== undefined ? selectSettingValue(condition.v, prereqType) : undefined;
      lb.appendPrerequisiteFlagCondition(
        condition.f,
        condition.c,
        cmpVal !== undefined ? settingValueToString(cmpVal) : "",
      );
    }
    return evaluatePrerequisiteFlagCondition(
      condition,
      ctx.key,
      ctx.visitedFlags,
      (key) => ctx.settings[key]?.t,
      (key) => {
        // Re-evaluate the prerequisite flag in a child context sharing the
        // same settings / segments / salt / user and the SAME visitedFlags
        // stack (so a cycle across levels is detected). The trace re-enters the
        // full evaluation nested in `( … )` (go-sdk oracle structure), so the
        // child appends its own "Evaluating '<key>' …" header + "Returning …".
        const prereqSetting = ctx.settings[key];
        if (!prereqSetting) throw new Error("Prerequisite flag is missing or invalid.");
        const childCtx: EvaluateContext = {
          key,
          setting: prereqSetting,
          settings: ctx.settings,
          segments: ctx.segments,
          configSalt: ctx.configSalt,
          user: ctx.user,
          visitedFlags: ctx.visitedFlags,
          // A prerequisite flag evaluates in its OWN context (configcat
          // `forPrerequisiteFlag`): the "User Object is missing" WARN dedups
          // per flag, so a prereq referenced by N rules logs it N times.
          state: { missingUserObjectLogged: false },
          logBuilder: lb,
        };
        if (lb) {
          lb.newLine("(").increaseIndent().newLine(`Evaluating '${key}'`);
          if (ctx.user) {
            lb.append(` for User '${JSON.stringify(userAttributesForLog(ctx.user))}'`);
          }
        }
        const childResult = this.evaluateSetting(childCtx);
        if (lb) {
          const childValue = selectSettingValue(childResult.value, prereqSetting.t);
          lb.newLine(
            `Returning '${settingValueToString(childValue as boolean | string | number)}'.`,
          )
            .decreaseIndent()
            .newLine(")");
        }
        return childResult.value;
      },
      selectSettingValue,
    )
      ? true
      : false;
  }

  /**
   * Resolve a segment condition (US4). Delegates to
   * {@link evaluateSegmentCondition} (segments.ts), supplying the config
   * segment list, the missing-user surfacer (segment name as context salt),
   * and a per-user-condition evaluator bound to this context.
   */
  private evaluateSegmentCondition(
    condition: ISegmentCondition,
    ctx: EvaluateContext,
  ): ConditionOutcome {
    const lb = ctx.logBuilder;
    const segment = ctx.segments[condition.s];
    const segmentName = segment?.n ?? "";
    lb?.appendSegmentCondition(segmentName, condition.c);

    if (!ctx.user) {
      this.surfaceMissingUser(ctx);
      return { error: MISSING_USER_OBJECT_ERROR };
    }
    if (!segment) throw new Error("Segment reference is invalid.");

    lb?.newLine("(").increaseIndent().newLine(`Evaluating segment '${segmentName}':`);

    // The segment's AND-grouped user conditions, traced via the shared
    // evaluateConditions path (segment name = the sensitive-comparator salt).
    const inSegment = this.evaluateConditions(
      segment.r.map((uc) => ({ u: uc })),
      segmentName,
      ctx,
    );
    // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
    let result: ConditionOutcome = inSegment;
    if (typeof result === "boolean" && condition.c === SegmentComparator.IsNotIn) {
      result = !result;
    }

    if (lb) {
      lb.newLine("Segment evaluation result: ");
      if (typeof inSegment === "boolean") {
        lb.append(`User ${inSegment ? "IS IN SEGMENT" : "IS NOT IN SEGMENT"}`);
      } else {
        lb.append(inSegment.error);
      }
      lb.append(".");
      lb.newLine("Condition (").appendSegmentCondition(segmentName, condition.c).append(")");
      if (typeof result === "boolean") {
        lb.append(" evaluates to ").appendConditionResult(result);
      } else {
        lb.append(" failed to evaluate");
      }
      lb.append(".").decreaseIndent().newLine(")");
    }

    return result;
  }

  /** Surface the "User Object is missing" outcome once per context (FR-016). */
  private surfaceMissingUser(ctx: EvaluateContext): void {
    ctx.state.errorMessage ??= MISSING_USER_OBJECT_ERROR;
    if (!ctx.state.missingUserObjectLogged) {
      this.logger.userObjectIsMissing(ctx.key);
      ctx.state.missingUserObjectLogged = true;
    }
  }

  /**
   * Convenience for tests + the hot path in `getValueAsync` — returns
   * just the resolved typed value (no details envelope). Same
   * fail-closed guarantees as {@link evaluate}.
   */
  evaluateValue<T>(config: ProjectConfig, key: string, defaultValue: T, user?: User): T {
    return this.evaluate(config, key, defaultValue, user).value as T;
  }

  /**
   * Snapshot variant — evaluator used from `IConfigCatClientSnapshot.getValue`.
   * Identical semantics; kept as a named entry for parity with
   * `configcat-common`'s `evaluateSnapshot`.
   */
  evaluateSnapshot<T>(
    config: ProjectConfig,
    key: string,
    defaultValue: T,
    user?: User,
  ): SettingTypeOf<T> {
    return this.evaluate(config, key, defaultValue, user).value;
  }

  private details<T>(
    key: string,
    defaultValue: T,
    fetchTime: Date | undefined,
    user: User | undefined,
    errorMessage: string,
    errorException?: unknown,
  ): IEvaluationDetails<SettingTypeOf<T>> {
    return {
      key,
      value: defaultValue as SettingTypeOf<T>,
      fetchTime,
      user,
      isDefaultValue: true,
      errorMessage,
      errorException,
    };
  }

  /** Helper to read the current setting record off a config. */
  static settingsOf(config: ProjectConfig): Record<string, ISetting> {
    return config.settings;
  }
}
