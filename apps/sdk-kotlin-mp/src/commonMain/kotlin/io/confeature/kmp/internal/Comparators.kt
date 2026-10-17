// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * The 36 ConfigCat `UserComparator` codes and the cleartext comparators, ported field-for-field from
 * `packages/sdk-shared/src/comparators.ts` (the spec-117 reference, verified against
 * `configcat-common`; transliterated from the Android port `io.confeature.android.internal.Comparators`).
 *
 * Six families: text (cleartext, case-sensitive, no trim), sensitive text (SHA-256 salted, in
 * [SensitiveComparators]), semver, number (strict whole-string parse, `,`→`.`), datetime (Unix
 * seconds), array (cleartext + sensitive). Attribute conversion lives in [AttributeConversions]
 * and [ComparisonValues]; the canonical stringification in [AttributeStrings].
 */
internal object Comparators {
    private val NUMERIC_INT = Regex("^-?\\d+$")

    // UserComparator codes (config_v6).
    const val TEXT_IS_ONE_OF = 0
    const val TEXT_IS_NOT_ONE_OF = 1
    const val TEXT_CONTAINS_ANY_OF = 2
    const val TEXT_NOT_CONTAINS_ANY_OF = 3
    const val SEMVER_IS_ONE_OF = 4
    const val SEMVER_IS_NOT_ONE_OF = 5
    const val SEMVER_LESS = 6
    const val SEMVER_LESS_OR_EQUALS = 7
    const val SEMVER_GREATER = 8
    const val SEMVER_GREATER_OR_EQUALS = 9
    const val NUMBER_EQUALS = 10
    const val NUMBER_NOT_EQUALS = 11
    const val NUMBER_LESS = 12
    const val NUMBER_LESS_OR_EQUALS = 13
    const val NUMBER_GREATER = 14
    const val NUMBER_GREATER_OR_EQUALS = 15
    const val SENSITIVE_TEXT_IS_ONE_OF = 16
    const val SENSITIVE_TEXT_IS_NOT_ONE_OF = 17
    const val DATETIME_BEFORE = 18
    const val DATETIME_AFTER = 19
    const val SENSITIVE_TEXT_EQUALS = 20
    const val SENSITIVE_TEXT_NOT_EQUALS = 21
    const val SENSITIVE_TEXT_STARTS_WITH_ANY_OF = 22
    const val SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF = 23
    const val SENSITIVE_TEXT_ENDS_WITH_ANY_OF = 24
    const val SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF = 25
    const val SENSITIVE_ARRAY_CONTAINS_ANY_OF = 26
    const val SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF = 27
    const val TEXT_EQUALS = 28
    const val TEXT_NOT_EQUALS = 29
    const val TEXT_STARTS_WITH_ANY_OF = 30
    const val TEXT_NOT_STARTS_WITH_ANY_OF = 31
    const val TEXT_ENDS_WITH_ANY_OF = 32
    const val TEXT_NOT_ENDS_WITH_ANY_OF = 33
    const val ARRAY_CONTAINS_ANY_OF = 34
    const val ARRAY_NOT_CONTAINS_ANY_OF = 35

    // -------------------------------------------------------------------------
    // Text — cleartext (case-sensitive, no trim)
    // -------------------------------------------------------------------------

    fun evaluateTextEquals(text: String, comparisonValue: String, negate: Boolean): Boolean =
        (text == comparisonValue) != negate

    fun evaluateTextIsOneOf(
        text: String,
        comparisonValues: List<String>,
        negate: Boolean,
    ): Boolean = comparisonValues.contains(text) != negate

    fun evaluateTextContainsAnyOf(
        text: String,
        comparisonValues: List<String>,
        negate: Boolean,
    ): Boolean {
        for (item in comparisonValues) {
            if (text.contains(item)) return !negate
        }
        return negate
    }

    /** Cleartext startsWith/endsWith-any-of. Items longer than the text are skipped. */
    fun evaluateTextSliceEqualsAnyOf(
        text: String,
        comparisonValues: List<String>,
        startsWith: Boolean,
        negate: Boolean,
    ): Boolean {
        for (item in comparisonValues) {
            if (text.length < item.length) continue
            val result = if (startsWith) text.startsWith(item) else text.endsWith(item)
            if (result) return !negate
        }
        return negate
    }

    // -------------------------------------------------------------------------
    // Semver
    // -------------------------------------------------------------------------

    /**
     * Semver IS-ONE-OF / IS-NOT-ONE-OF. Each operand is trimmed first; an operand that is empty
     * AFTER trimming (incl. whitespace-only) is skipped — matching ConfigCat, which trims before
     * the empty check. A non-empty but unparseable operand makes the whole comparator `false`.
     * Iterates ALL operands (no early-out on match).
     */
    fun evaluateSemVerIsOneOf(
        version: Semver,
        comparisonValues: List<String>,
        negate: Boolean,
    ): Boolean {
        var result = false
        for (rawItem in comparisonValues) {
            val item = rawItem.trim()
            if (item.isEmpty()) continue
            val version2 = Semver.parse(item) ?: return false
            if (!result && version.compare(version2) == 0) result = true
        }
        return result != negate
    }

    /** Semver relations. An unparseable operand is a non-match (`false`). */
    fun evaluateSemVerRelation(version: Semver, comparator: Int, comparisonValue: String): Boolean {
        val version2 = Semver.parse(comparisonValue.trim()) ?: return false
        val cmp = version.compare(version2)
        return when (comparator) {
            SEMVER_LESS -> cmp < 0
            SEMVER_LESS_OR_EQUALS -> cmp <= 0
            SEMVER_GREATER -> cmp > 0
            SEMVER_GREATER_OR_EQUALS -> cmp >= 0
            else -> false
        }
    }

    // -------------------------------------------------------------------------
    // Number
    // -------------------------------------------------------------------------

    fun evaluateNumberRelation(num: Double, comparator: Int, comparisonValue: Double): Boolean =
        when (comparator) {
            NUMBER_EQUALS -> num == comparisonValue
            NUMBER_NOT_EQUALS -> num != comparisonValue
            NUMBER_LESS -> num < comparisonValue
            NUMBER_LESS_OR_EQUALS -> num <= comparisonValue
            NUMBER_GREATER -> num > comparisonValue
            NUMBER_GREATER_OR_EQUALS -> num >= comparisonValue
            else -> false
        }

    // -------------------------------------------------------------------------
    // Datetime (Unix seconds)
    // -------------------------------------------------------------------------

    fun evaluateDateTimeRelation(seconds: Double, comparisonValue: Double, before: Boolean): Boolean =
        if (before) seconds < comparisonValue else seconds > comparisonValue

    // -------------------------------------------------------------------------
    // Array (cleartext + sensitive)
    // -------------------------------------------------------------------------

    fun evaluateArrayContainsAnyOf(
        array: List<String>,
        comparisonValues: List<String>,
        negate: Boolean,
    ): Boolean {
        for (item in array) {
            if (comparisonValues.contains(item)) return !negate
        }
        return negate
    }

    /** Detect whether [s] parses as a non-negative integer string. */
    fun isIntegerString(s: String): Boolean = NUMERIC_INT.matches(s)
}
