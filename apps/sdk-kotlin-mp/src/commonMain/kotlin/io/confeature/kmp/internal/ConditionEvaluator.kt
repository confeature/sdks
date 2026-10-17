// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.internal.ConfigValues.asList
import io.confeature.kmp.internal.ConfigValues.asMap
import io.confeature.kmp.internal.ConfigValues.nullSafeEquals
import io.confeature.kmp.internal.ConfigValues.readDouble
import io.confeature.kmp.internal.ConfigValues.readInt
import io.confeature.kmp.internal.ConfigValues.readString
import io.confeature.kmp.internal.ConfigValues.readStringList
import io.confeature.kmp.internal.ConfigValues.selectSettingValue

/**
 * The three condition kinds of a targeting rule — user condition, prerequisite flag, segment —
 * ported from evaluator.ts / prerequisites.ts / segments.ts. A malformed reference throws to the
 * evaluator's fail-closed frame; a prerequisite cycle throws [CircularDependencyException].
 */
internal object ConditionEvaluator {
    // PrerequisiteFlagComparator / SegmentComparator codes (the negated ones live on Evaluator).
    private const val PREREQ_EQUALS = 0
    private const val SEGMENT_IS_IN = 0

    private const val INVALID_OPERATOR = "Comparison operator is missing or invalid."
    private const val INVALID_SEGMENT = "Segment reference is invalid."

    /** Dispatch one user condition to its comparator. */
    fun evaluateUserCondition(
        condition: Map<String, Any?>?,
        contextSalt: String,
        ctx: EvalContext,
    ): ConditionOutcome {
        val lb = ctx.logBuilder
        if (lb != null) traceUserCondition(lb, condition)

        if (condition == null) return ConditionOutcome.attributeError("")
        val user = ctx.user
        if (user == null) {
            ctx.surfaceMissingUser()
            return ConditionOutcome.attributeError(MISSING_USER_OBJECT_ERROR)
        }

        val attrName = readString(condition["a"])
        val attrValue = if (attrName == null) null else user.attribute(attrName)
        if (attrName == null || attrValue == null || "" == attrValue) {
            val msg = missingUserAttributeError(attrName ?: "")
            ctx.recordError(msg)
            // ConfigCat logs a WARN (event 3003) per targeting rule whose attribute is missing — not
            // deduped per evaluation.
            ctx.log.userObjectAttributeIsMissing(ctx.key, attrName ?: "")
            return ConditionOutcome.attributeError(msg)
        }

        val cmp = readInt(condition["c"]) ?: return ConditionOutcome.attributeError("")
        val operands =
            UserConditionOperands(
                cmp,
                attrName,
                attrValue,
                readStringList(condition["l"]),
                readString(condition["s"]) ?: "",
                readDouble(condition["d"]),
            )
        val outcome = ComparatorDispatch.dispatch(operands, HashSalt(ctx.configSalt, contextSalt))
        surfaceComparatorError(outcome, ctx)
        return outcome
    }

    /** Trace the user condition as configured (a missing condition traces as all-absent). */
    private fun traceUserCondition(lb: EvalLog.EvaluateLogBuilder, condition: Map<String, Any?>?) {
        if (condition == null) {
            lb.appendUserCondition(null, -1, null, null, null)
        } else {
            lb.appendUserCondition(
                readString(condition["a"]),
                readInt(condition["c"]) ?: -1,
                readString(condition["s"]),
                readDouble(condition["d"]),
                readStringList(condition["l"]),
            )
        }
    }

    /** Surface the WARN 3004 lines for typed-attribute / comparison-value failures. */
    private fun surfaceComparatorError(outcome: ConditionOutcome, ctx: EvalContext) {
        if (!outcome.isError()) return
        if (outcome.comparisonValueError) {
            ctx.recordError(outcome.error)
            ctx.log.comparisonValueIsInvalid(ctx.key, outcome.error ?: "")
        } else if (outcome.attribute != null && outcome.reason != null) {
            ctx.recordError(outcome.error)
            ctx.log.userObjectAttributeIsInvalid(ctx.key, outcome.attribute, outcome.reason)
        }
    }

    /**
     * Resolve a prerequisite-flag condition (child context, fresh missing-user state). Returns a
     * plain boolean (`true`/`false`); a cycle / malformed reference throws to the fail-closed frame.
     */
    fun evaluatePrerequisiteCondition(condition: Map<String, Any?>?, ctx: EvalContext): Boolean {
        val c = condition.orMalformed("Prerequisite condition is missing or invalid.")
        val prereqKey = readString(c["f"]).orMalformed("Prerequisite flag key is missing or invalid.")
        val prereqSetting =
            asMap(ctx.settings[prereqKey]).orMalformed("Prerequisite flag is missing or invalid.")
        val declaredType = readInt(prereqSetting["t"]).orMalformed("Prerequisite flag is missing or invalid.")

        val comparisonValue = selectSettingValue(asMap(c["v"]), declaredType)

        val lb = ctx.logBuilder
        val cmp = readInt(c["c"]).orMalformed(INVALID_OPERATOR)
        lb?.appendPrerequisiteFlagCondition(
            prereqKey,
            cmp,
            if (comparisonValue != null) EvalLog.settingValueToLogString(comparisonValue) else "",
        )

        enterPrerequisite(ctx, prereqKey)

        // The prerequisite evaluates in its OWN context (fresh missingUserLogged) so a prereq
        // referenced by N rules logs WARN 3001 N times, not once (common-js parity).
        val childCtx = ctx.withChild(prereqKey, prereqSetting)

        // The trace re-enters the full evaluation nested in `( … )` (go-sdk oracle structure): the
        // child appends its own "Evaluating '<key>' …" header + "Returning …".
        if (lb != null) {
            lb.newLine("(").increaseIndent().newLine("Evaluating '$prereqKey'")
            if (ctx.user != null) {
                lb.append(" for User '" + AttributeStrings.userAttributesForLogJson(ctx.user) + "'")
            }
        }

        val resolvedEnvelope = SettingEvaluator.evaluateSetting(childCtx)
        val resolvedValue = selectSettingValue(resolvedEnvelope.value, declaredType)

        if (lb != null) {
            lb.newLine("Returning '" + EvalLog.settingValueToLogString(resolvedValue) + "'.")
                .decreaseIndent()
                .newLine(")")
        }

        ctx.recordError(childCtx.evalError)
        // Restore the stack for sibling prerequisites.
        ctx.visitedFlags.removeAt(ctx.visitedFlags.size - 1)

        val equal = nullSafeEquals(resolvedValue, comparisonValue)
        return when (cmp) {
            PREREQ_EQUALS -> equal
            Evaluator.PREREQ_NOT_EQUALS -> !equal
            else -> throw MalformedConfigException(INVALID_OPERATOR)
        }
    }

    /** Cycle detection: push the current key, and detect a revisit before recursing. */
    private fun enterPrerequisite(ctx: EvalContext, prereqKey: String) {
        ctx.visitedFlags.add(ctx.key)
        if (ctx.visitedFlags.contains(prereqKey)) {
            ctx.visitedFlags.add(prereqKey)
            val cycle = ctx.visitedFlags.joinToString(" -> ")
            throw CircularDependencyException(
                "Circular dependency detected between the following depending flags: $cycle.",
                cycle,
            )
        }
    }

    /** Resolve a segment condition (sensitive context salt = segment NAME). */
    fun evaluateSegmentCondition(condition: Map<String, Any?>?, ctx: EvalContext): ConditionOutcome {
        val c = condition.orMalformed(INVALID_SEGMENT)
        val lb = ctx.logBuilder
        val index = readInt(c["s"])
        val segment = if (index != null && index in ctx.segments.indices) asMap(ctx.segments[index]) else null
        val segmentName = if (segment == null) null else readString(segment["n"])
        val segCmp = readInt(c["c"])
        lb?.appendSegmentCondition(segmentName ?: "", segCmp ?: SEGMENT_IS_IN)

        if (ctx.user == null) {
            ctx.surfaceMissingUser()
            return ConditionOutcome.attributeError(MISSING_USER_OBJECT_ERROR)
        }
        val resolvedSegment = segment.orMalformed(INVALID_SEGMENT)
        if (segmentName.isNullOrEmpty()) {
            throw MalformedConfigException("Segment name is missing.")
        }

        lb?.newLine("(")?.increaseIndent()?.newLine("Evaluating segment '$segmentName':")

        // The segment's AND-grouped bare user conditions, traced via the shared evaluateConditions
        // path (segment name = the sensitive-comparator salt).
        val wrapped = (asList(resolvedSegment["r"]) ?: emptyList()).map { linkedMapOf<String, Any?>("u" to it) }
        val inSegment = SettingEvaluator.evaluateConditions(wrapped, segmentName, ctx, null)

        // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
        val result =
            if (!inSegment.isError() && segCmp == Evaluator.SEGMENT_IS_NOT_IN) {
                ConditionOutcome.match(!inSegment.isMatch())
            } else {
                inSegment
            }

        if (lb != null) traceSegmentResult(lb, segmentName, segCmp ?: SEGMENT_IS_IN, inSegment, result)
        return result
    }

    /** Trace the segment's membership and the condition's resulting value. */
    private fun traceSegmentResult(
        lb: EvalLog.EvaluateLogBuilder,
        segmentName: String,
        segCmp: Int,
        inSegment: ConditionOutcome,
        result: ConditionOutcome,
    ) {
        lb.newLine("Segment evaluation result: ")
        if (!inSegment.isError()) {
            lb.append(if (inSegment.isMatch()) "User IS IN SEGMENT" else "User IS NOT IN SEGMENT")
        } else {
            lb.append(inSegment.error ?: "")
        }
        lb.append(".")
        lb.newLine("Condition (").appendSegmentCondition(segmentName, segCmp).append(")")
        if (!result.isError()) {
            lb.append(" evaluates to ").appendConditionResult(result.isMatch())
        } else {
            lb.append(" failed to evaluate")
        }
        lb.append(".").decreaseIndent().newLine(")")
    }
}
