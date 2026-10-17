// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.internal.AttributeConversions.attributeAsNumber
import io.confeature.kmp.internal.AttributeConversions.attributeAsSemVer
import io.confeature.kmp.internal.AttributeConversions.attributeAsStringArray
import io.confeature.kmp.internal.AttributeConversions.attributeAsText
import io.confeature.kmp.internal.AttributeConversions.attributeAsUnixTimeSeconds
import io.confeature.kmp.internal.Comparators.ARRAY_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.ARRAY_NOT_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.DATETIME_AFTER
import io.confeature.kmp.internal.Comparators.DATETIME_BEFORE
import io.confeature.kmp.internal.Comparators.NUMBER_EQUALS
import io.confeature.kmp.internal.Comparators.NUMBER_GREATER
import io.confeature.kmp.internal.Comparators.NUMBER_GREATER_OR_EQUALS
import io.confeature.kmp.internal.Comparators.NUMBER_LESS
import io.confeature.kmp.internal.Comparators.NUMBER_LESS_OR_EQUALS
import io.confeature.kmp.internal.Comparators.NUMBER_NOT_EQUALS
import io.confeature.kmp.internal.Comparators.SEMVER_GREATER
import io.confeature.kmp.internal.Comparators.SEMVER_GREATER_OR_EQUALS
import io.confeature.kmp.internal.Comparators.SEMVER_IS_NOT_ONE_OF
import io.confeature.kmp.internal.Comparators.SEMVER_IS_ONE_OF
import io.confeature.kmp.internal.Comparators.SEMVER_LESS
import io.confeature.kmp.internal.Comparators.SEMVER_LESS_OR_EQUALS
import io.confeature.kmp.internal.Comparators.SENSITIVE_ARRAY_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_ENDS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_EQUALS
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_IS_ONE_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_NOT_EQUALS
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.SENSITIVE_TEXT_STARTS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_ENDS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_EQUALS
import io.confeature.kmp.internal.Comparators.TEXT_IS_NOT_ONE_OF
import io.confeature.kmp.internal.Comparators.TEXT_IS_ONE_OF
import io.confeature.kmp.internal.Comparators.TEXT_NOT_CONTAINS_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_NOT_ENDS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_NOT_EQUALS
import io.confeature.kmp.internal.Comparators.TEXT_NOT_STARTS_WITH_ANY_OF
import io.confeature.kmp.internal.Comparators.TEXT_STARTS_WITH_ANY_OF

/**
 * Dispatch a user condition's comparator code to its family evaluator. The relational semver,
 * number and datetime families validate the CONFIG comparison value BEFORE the user attribute,
 * as configcat-common does (#509): a malformed operand wins even when the attribute is also
 * malformed. Any unknown code is a validation error.
 */
internal object ComparatorDispatch {
    fun dispatch(op: UserConditionOperands, salt: HashSalt): ConditionOutcome =
        when (op.cmp) {
            TEXT_EQUALS, TEXT_NOT_EQUALS,
            TEXT_IS_ONE_OF, TEXT_IS_NOT_ONE_OF,
            TEXT_STARTS_WITH_ANY_OF, TEXT_NOT_STARTS_WITH_ANY_OF,
            TEXT_ENDS_WITH_ANY_OF, TEXT_NOT_ENDS_WITH_ANY_OF,
            TEXT_CONTAINS_ANY_OF, TEXT_NOT_CONTAINS_ANY_OF,
            -> ConditionOutcome.match(text(op))
            SENSITIVE_TEXT_EQUALS, SENSITIVE_TEXT_NOT_EQUALS,
            SENSITIVE_TEXT_IS_ONE_OF, SENSITIVE_TEXT_IS_NOT_ONE_OF,
            SENSITIVE_TEXT_STARTS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
            SENSITIVE_TEXT_ENDS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
            -> ConditionOutcome.match(sensitiveText(op, salt))
            SEMVER_IS_ONE_OF, SEMVER_IS_NOT_ONE_OF -> semVerIsOneOf(op)
            SEMVER_LESS, SEMVER_LESS_OR_EQUALS, SEMVER_GREATER, SEMVER_GREATER_OR_EQUALS ->
                semVerRelation(op)
            NUMBER_EQUALS, NUMBER_NOT_EQUALS,
            NUMBER_LESS, NUMBER_LESS_OR_EQUALS,
            NUMBER_GREATER, NUMBER_GREATER_OR_EQUALS,
            -> numberRelation(op)
            DATETIME_BEFORE, DATETIME_AFTER -> dateTimeRelation(op)
            ARRAY_CONTAINS_ANY_OF, ARRAY_NOT_CONTAINS_ANY_OF -> arrayContainsAnyOf(op)
            SENSITIVE_ARRAY_CONTAINS_ANY_OF, SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF ->
                sensitiveArrayContainsAnyOf(op, salt)
            else -> ConditionOutcome.attributeError("")
        }

    /** Cleartext text comparators (case-sensitive, no trim). Only text codes reach here. */
    private fun text(op: UserConditionOperands): Boolean {
        val text = attributeAsText(op.attrValue)
        return when (op.cmp) {
            TEXT_EQUALS, TEXT_NOT_EQUALS ->
                Comparators.evaluateTextEquals(text, op.comparisonText, op.cmp == TEXT_NOT_EQUALS)
            TEXT_IS_ONE_OF, TEXT_IS_NOT_ONE_OF ->
                Comparators.evaluateTextIsOneOf(text, op.list, op.cmp == TEXT_IS_NOT_ONE_OF)
            TEXT_STARTS_WITH_ANY_OF, TEXT_NOT_STARTS_WITH_ANY_OF ->
                Comparators.evaluateTextSliceEqualsAnyOf(
                    text,
                    op.list,
                    true,
                    op.cmp == TEXT_NOT_STARTS_WITH_ANY_OF,
                )
            TEXT_ENDS_WITH_ANY_OF, TEXT_NOT_ENDS_WITH_ANY_OF ->
                Comparators.evaluateTextSliceEqualsAnyOf(
                    text,
                    op.list,
                    false,
                    op.cmp == TEXT_NOT_ENDS_WITH_ANY_OF,
                )
            // TEXT_CONTAINS_ANY_OF, TEXT_NOT_CONTAINS_ANY_OF
            else ->
                Comparators.evaluateTextContainsAnyOf(text, op.list, op.cmp == TEXT_NOT_CONTAINS_ANY_OF)
        }
    }

    /** Sensitive (SHA-256 salted) text comparators. Only sensitive-text codes reach here. */
    private fun sensitiveText(op: UserConditionOperands, salt: HashSalt): Boolean {
        val text = attributeAsText(op.attrValue)
        return when (op.cmp) {
            SENSITIVE_TEXT_EQUALS, SENSITIVE_TEXT_NOT_EQUALS ->
                SensitiveComparators.evaluateSensitiveTextEquals(
                    text,
                    op.comparisonText,
                    salt,
                    op.cmp == SENSITIVE_TEXT_NOT_EQUALS,
                )
            SENSITIVE_TEXT_IS_ONE_OF, SENSITIVE_TEXT_IS_NOT_ONE_OF ->
                SensitiveComparators.evaluateSensitiveTextIsOneOf(
                    text,
                    op.list,
                    salt,
                    op.cmp == SENSITIVE_TEXT_IS_NOT_ONE_OF,
                )
            SENSITIVE_TEXT_STARTS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF ->
                SensitiveComparators.evaluateSensitiveTextSliceEqualsAnyOf(
                    text,
                    op.list,
                    salt,
                    true,
                    op.cmp == SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
                )
            // SENSITIVE_TEXT_ENDS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF
            else ->
                SensitiveComparators.evaluateSensitiveTextSliceEqualsAnyOf(
                    text,
                    op.list,
                    salt,
                    false,
                    op.cmp == SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
                )
        }
    }

    private fun semVerIsOneOf(op: UserConditionOperands): ConditionOutcome {
        val r = attributeAsSemVer(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            Comparators.evaluateSemVerIsOneOf(r.value!!, op.list, op.cmp == SEMVER_IS_NOT_ONE_OF),
        )
    }

    private fun semVerRelation(op: UserConditionOperands): ConditionOutcome {
        val cv = ComparisonValues.comparisonValueAsSemVer(op.comparisonText)
        if (!cv.ok) return ConditionOutcome.comparisonValueError(cv.error!!)
        val r = attributeAsSemVer(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            Comparators.evaluateSemVerRelation(r.value!!, op.cmp, op.comparisonText),
        )
    }

    private fun numberRelation(op: UserConditionOperands): ConditionOutcome {
        val cv = ComparisonValues.comparisonValueAsNumber(op.comparisonNumber)
        if (!cv.ok) return ConditionOutcome.comparisonValueError(cv.error!!)
        val r = attributeAsNumber(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            Comparators.evaluateNumberRelation(r.value!!, op.cmp, op.comparisonNumberOrZero),
        )
    }

    private fun dateTimeRelation(op: UserConditionOperands): ConditionOutcome {
        val cv = ComparisonValues.comparisonValueAsUnixTimeSeconds(op.comparisonNumber)
        if (!cv.ok) return ConditionOutcome.comparisonValueError(cv.error!!)
        val r = attributeAsUnixTimeSeconds(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            Comparators.evaluateDateTimeRelation(
                r.value!!,
                op.comparisonNumberOrZero,
                op.cmp == DATETIME_BEFORE,
            ),
        )
    }

    private fun arrayContainsAnyOf(op: UserConditionOperands): ConditionOutcome {
        val r = attributeAsStringArray(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            Comparators.evaluateArrayContainsAnyOf(r.value!!, op.list, op.cmp == ARRAY_NOT_CONTAINS_ANY_OF),
        )
    }

    private fun sensitiveArrayContainsAnyOf(op: UserConditionOperands, salt: HashSalt): ConditionOutcome {
        val r = attributeAsStringArray(op.attrName, op.attrValue)
        if (!r.ok) return invalidAttributeOutcome(r)
        return ConditionOutcome.match(
            SensitiveComparators.evaluateSensitiveArrayContainsAnyOf(
                r.value!!,
                op.list,
                salt,
                op.cmp == SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
            ),
        )
    }

    /** Map a failed typed-attribute conversion to its WARN-3004-bearing [ConditionOutcome]. */
    private fun invalidAttributeOutcome(r: Convert<*>): ConditionOutcome =
        ConditionOutcome.invalidAttribute(r.error ?: "", r.attribute, r.reason)
}
