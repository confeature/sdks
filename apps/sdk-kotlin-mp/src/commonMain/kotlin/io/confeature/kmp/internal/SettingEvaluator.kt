// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.internal.ConfigValues.asList
import io.confeature.kmp.internal.ConfigValues.asMap
import io.confeature.kmp.internal.ConfigValues.readInt
import io.confeature.kmp.internal.ConfigValues.readString
import io.confeature.kmp.internal.ConfigValues.selectSettingValue

/**
 * The setting walk (evaluator.ts `evaluateSetting`): targeting rules (first match wins), then the
 * setting-level percentage options, then the served fallback. Conditions are resolved by
 * [ConditionEvaluator]; the trace lines are byte-identical to ConfigCat's (ADR 0003).
 */
internal object SettingEvaluator {
    private const val RULE_IGNORED =
        "The current targeting rule is ignored and the evaluation continues with the next rule."

    /**
     * Resolve a setting to its `v` envelope + matched-rule/option identity: targeting-rule walk
     * (first-match-wins), then setting-level percentage options, then the served fallback.
     */
    fun evaluateSetting(ctx: EvalContext): SettingResult {
        val rules = asList(ctx.setting["r"])
        if (rules != null && rules.isNotEmpty()) {
            val ruleResult = evaluateTargetingRules(rules, ctx)
            if (ruleResult != null) return ruleResult
        }

        val options = asList(ctx.setting["p"])
        if (options != null && options.isNotEmpty()) {
            val optionResult = evaluatePercentageOptions(options, false, ctx)
            if (optionResult != null) return optionResult
        }

        return SettingResult(asMap(ctx.setting["v"]), readString(ctx.setting["i"]))
    }

    /** Walk `setting.r[]` in document order; first rule whose AND-conditions all match wins. */
    private fun evaluateTargetingRules(rules: List<Any?>, ctx: EvalContext): SettingResult? {
        ctx.logBuilder?.newLine("Evaluating targeting rules and applying the first match if any:")
        for (ruleAny in rules) {
            val rule = asMap(ruleAny) ?: continue
            val ruleResult = evaluateTargetingRule(rule, ctx)
            if (ruleResult != null) return ruleResult
        }
        return null
    }

    /** One targeting rule: its served value, its % options, or null to continue with the next. */
    private fun evaluateTargetingRule(rule: Map<String, Any?>, ctx: EvalContext): SettingResult? {
        val lb = ctx.logBuilder
        val conditions = asList(rule["c"]) ?: emptyList()
        val outcome = evaluateConditions(conditions, ctx.key, ctx, rule)
        if (!outcome.isMatch()) {
            // A rule whose conditions ERRORED (missing user/attr/validation) is ignored and
            // evaluation continues — ConfigCat emits this trace line. A rule that merely did NOT
            // match (false) just continues, with no such line.
            if (outcome.isError() && lb != null) {
                lb.increaseIndent().newLine(RULE_IGNORED).decreaseIndent()
            }
            return null
        }

        val served = asMap(rule["s"])
        if (served != null) {
            val r = SettingResult(asMap(served["v"]), readString(served["i"]))
            r.matchedRule = true
            return r
        }
        // A rule serving % options: the block is traced one level deeper (under the rule). If the
        // options can't resolve (no user / missing keying attr) the rule is ignored and
        // evaluation continues.
        val options = asList(rule["p"]) ?: emptyList()
        lb?.increaseIndent()
        val optionResult = evaluatePercentageOptions(options, true, ctx)
        if (optionResult != null) {
            lb?.decreaseIndent()
            return optionResult
        }
        lb?.newLine(RULE_IGNORED)?.decreaseIndent()
        return null
    }

    /**
     * Resolve a percentage-option list to its bucket: `sha1(key + attrValue)[0,7] % 100`, keyed by
     * the setting's `a` attribute (default Identifier). Returns null (skip) when there is no user or
     * the keying attribute is missing.
     */
    private fun evaluatePercentageOptions(
        options: List<Any?>,
        fromRule: Boolean,
        ctx: EvalContext,
    ): SettingResult? {
        val lb = ctx.logBuilder
        val user = ctx.user
        if (user == null) {
            ctx.surfaceMissingUser()
            lb?.newLine("Skipping % options because the User Object is missing.")
            return null
        }

        val explicitAttrName = ctx.setting["a"] as? String
        val attrName = explicitAttrName ?: "Identifier"
        val attrValue: Any? =
            if (explicitAttrName == null) user.identifier() ?: "" else user.attribute(explicitAttrName)
        if (attrValue == null) {
            ctx.recordError(missingUserAttributeError(attrName))
            ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName)
            lb?.newLine("Skipping % options because the User.$attrName attribute is missing.")
            return null
        }

        val hashValue =
            Hashing.percentageBucket(ctx.key, AttributeStrings.userAttributeValueToString(attrValue))

        if (lb != null) {
            lb.newLine("Evaluating % options based on the User.$attrName attribute:")
            lb.newLine(
                "- Computing hash in the [0..99] range from User." +
                    attrName +
                    " => " +
                    hashValue +
                    " (this value is sticky and consistent across all SDKs)",
            )
        }
        return selectPercentageOption(options, hashValue, fromRule, ctx)
    }

    /** The first option whose cumulative width exceeds [hashValue]; widths summing < 100 are malformed. */
    private fun selectPercentageOption(
        options: List<Any?>,
        hashValue: Int,
        fromRule: Boolean,
        ctx: EvalContext,
    ): SettingResult {
        var bucket = 0
        for (i in options.indices) {
            val option = asMap(options[i])
            val width = if (option == null) null else readInt(option["p"])
            if (option != null && width != null) {
                bucket += width
                if (hashValue < bucket) {
                    val optionValue = asMap(option["v"])
                    ctx.logBuilder?.newLine(
                        "- Hash value " +
                            hashValue +
                            " selects % option " +
                            (i + 1) +
                            " (" +
                            width +
                            "%), '" +
                            EvalLog.settingValueToLogString(
                                selectSettingValue(optionValue, settingTypeOf(ctx)),
                            ) +
                            "'.",
                    )
                    val r = SettingResult(optionValue, readString(option["i"]))
                    r.matchedRule = fromRule
                    r.matchedOption = true
                    return r
                }
            }
        }
        // Sum of widths < 100 — a malformed config. Throw to the fail-closed frame.
        throw MalformedConfigException("Sum of percentage option percentages is less than 100.")
    }

    /**
     * AND-grouped condition list, short-circuiting on the first non-match / error. When [rule] is
     * non-null its THEN consequence is traced (a bare segment passes `null`). Mirrors evaluator.ts
     * `evaluateConditions`.
     */
    fun evaluateConditions(
        conditions: List<Any?>,
        contextSalt: String,
        ctx: EvalContext,
        rule: Map<String, Any?>?,
    ): ConditionOutcome {
        val lb = ctx.logBuilder
        var result: ConditionOutcome = ConditionOutcome.MATCH
        lb?.newLine("- ")
        for (i in conditions.indices) {
            val condition = asMap(conditions[i])
            if (lb != null) {
                if (i == 0) {
                    lb.append("IF ").increaseIndent()
                } else {
                    lb.increaseIndent().newLine("AND ")
                }
            }

            result = evaluateCondition(condition, contextSalt, ctx)

            if (lb != null) {
                // The go-sdk oracle always shows the per-condition consequence (even for a
                // single-condition rule, where configcat-js omits it) — match go.
                lb.appendConditionConsequence(result.isMatch())
                lb.decreaseIndent()
            }

            if (!result.isMatch()) break
        }

        // When evaluating a targeting rule (not a bare segment), append its THEN consequence. The go
        // oracle always newlines THEN when the rule has conditions.
        if (rule != null && lb != null) {
            traceRuleConsequence(lb, rule, result, conditions.isNotEmpty(), ctx)
        }
        return result
    }

    /** Dispatch one condition by its kind: user (`u`), prerequisite flag (`p`) or segment (`s`). */
    private fun evaluateCondition(
        condition: Map<String, Any?>?,
        contextSalt: String,
        ctx: EvalContext,
    ): ConditionOutcome =
        when {
            condition == null -> ConditionOutcome.attributeError("")
            condition["u"] != null ->
                ConditionEvaluator.evaluateUserCondition(asMap(condition["u"]), contextSalt, ctx)
            condition["p"] != null ->
                ConditionOutcome.match(
                    ConditionEvaluator.evaluatePrerequisiteCondition(asMap(condition["p"]), ctx),
                )
            condition["s"] != null ->
                ConditionEvaluator.evaluateSegmentCondition(asMap(condition["s"]), ctx)
            else -> ConditionOutcome.attributeError("")
        }

    /** Trace a targeting rule's THEN consequence: its served value, or why it did not serve. */
    private fun traceRuleConsequence(
        lb: EvalLog.EvaluateLogBuilder,
        rule: Map<String, Any?>,
        result: ConditionOutcome,
        hasConditions: Boolean,
        ctx: EvalContext,
    ) {
        val served = asMap(rule["s"])
        val thenValue =
            if (served != null) {
                EvalLog.settingValueToLogString(
                    selectSettingValue(asMap(served["v"]), settingTypeOf(ctx)),
                )
            } else {
                null
            }
        val matchKind =
            when {
                result.isMatch() -> EvalLog.MatchOrError.match()
                result.isError() -> EvalLog.MatchOrError.err(result.error ?: "")
                else -> EvalLog.MatchOrError.noMatch()
            }
        lb.appendTargetingRuleConsequence(thenValue, matchKind, hasConditions)
    }

    /** The setting type of the current eval context (drives the value-slot selection for the trace). */
    private fun settingTypeOf(ctx: EvalContext): Int =
        readInt(ctx.setting["t"]) ?: SettingType.BOOL
}
