// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.internal.AttributeStrings.isStringArray
import io.confeature.kmp.internal.AttributeStrings.numberToCanonicalString
import io.confeature.kmp.internal.AttributeStrings.userAttributeValueToString

/**
 * Result of an attribute conversion: the typed value, or a validation error string.
 *
 * [attribute] + [reason] carry the offending attribute name and the parenthesised reason when
 * this is a typed-attribute conversion failure (drives the WARN 3004 `userObjectAttributeIsInvalid`
 * trace line, #501); `null` for the comparison-value-invalid (#509) outcomes, which take the
 * distinct `comparisonValueIsInvalid` WARN.
 */
internal class Convert<T> private constructor(
    val ok: Boolean,
    val value: T?,
    val error: String?,
    val attribute: String?,
    val reason: String?,
) {
    companion object {
        fun <T> ok(value: T): Convert<T> = Convert(true, value, null, null, null)

        fun <T> err(error: String): Convert<T> = Convert(false, null, error, null, null)

        fun <T> errAttr(error: String, attribute: String, reason: String): Convert<T> =
            Convert(false, null, error, attribute, reason)
    }
}

/** User attribute → typed comparator operand, or a validation error (FR-010). */
internal object AttributeConversions {
    private val LEADING_ZERO_REJECT = Regex("^\\s*$|^\\s*0[^\\d.eE]")
    private val FLOAT_RE = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$")

    /**
     * Strict whole-string float parse (common-js `parseFloatStrict`). Rejects empty / all-whitespace
     * and a leading `0` followed by a non-digit/non-`.`/non-`e` (octal / hex). Returns NaN on
     * rejection.
     */
    fun parseFloatStrict(value: String): Double {
        if (value.isEmpty() || LEADING_ZERO_REJECT.containsMatchIn(value)) return Double.NaN
        val stripped = value.trim()
        if (stripped == "Infinity" || stripped == "+Infinity") return Double.POSITIVE_INFINITY
        if (stripped == "-Infinity") return Double.NEGATIVE_INFINITY
        if (stripped == "NaN") return Double.NaN
        if (!FLOAT_RE.matches(stripped)) return Double.NaN
        return stripped.toDouble()
    }

    private fun invalidAttr(attr: String, reason: String): String =
        "cannot evaluate, the User.$attr attribute is invalid ($reason)"

    /** Attribute → text (String verbatim; else stringified — never errors). */
    fun attributeAsText(value: Any?): String =
        if (value is String) value else userAttributeValueToString(value)

    /** Attribute → semver, or a validation error. */
    fun attributeAsSemVer(attr: String, value: Any?): Convert<Semver> {
        if (value is String) {
            val version = Semver.parse(value.trim())
            if (version != null) return Convert.ok(version)
        }
        val reason = "'" + userAttributeValueToString(value) + "' is not a valid semantic version"
        return Convert.errAttr(invalidAttr(attr, reason), attr, reason)
    }

    /** Attribute → number, or a validation error. */
    fun attributeAsNumber(attr: String, value: Any?): Convert<Double> {
        if (value is Number && value !is Boolean) return Convert.ok(value.toDouble())
        if (value is String) {
            val num = parseFloatStrict(value.replace(",", "."))
            if (!num.isNaN() || value.trim() == "NaN") return Convert.ok(num)
        }
        val reason = "'" + userAttributeValueToString(value) + "' is not a valid decimal number"
        return Convert.errAttr(invalidAttr(attr, reason), attr, reason)
    }

    /**
     * Attribute → Unix seconds, or a validation error. A numeric attribute is already seconds; a
     * string is parsed strictly. (The corpus feeds epoch numbers / strings.)
     */
    fun attributeAsUnixTimeSeconds(attr: String, value: Any?): Convert<Double> {
        if (value is Number && value !is Boolean) return Convert.ok(value.toDouble())
        if (value is String) {
            val num = parseFloatStrict(value.replace(",", "."))
            if (!num.isNaN() || value.trim() == "NaN") return Convert.ok(num)
        }
        val reason =
            "'" + userAttributeValueToString(value) +
                "' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
        return Convert.errAttr(invalidAttr(attr, reason), attr, reason)
    }

    /** Attribute → string array, or a validation error. A string attribute is JSON-parsed. */
    fun attributeAsStringArray(attr: String, value: Any?): Convert<List<String>> {
        var arr: Any? = value
        if (arr is String) {
            arr = parseJsonStringArray(arr) ?: arr
        }
        if (isStringArray(arr)) {
            @Suppress("UNCHECKED_CAST")
            return Convert.ok(arr as List<String>)
        }
        val reason = "'" + userAttributeValueToString(value) + "' is not a valid string array"
        return Convert.errAttr(invalidAttr(attr, reason), attr, reason)
    }

    /**
     * Parse a JSON string-array literal to `List<String>`, or null when not a string array.
     * Uses kotlinx-serialization (multiplatform) rather than org.json (JVM-only).
     */
    private fun parseJsonStringArray(s: String): List<String>? {
        return try {
            val el = kotlinx.serialization.json.Json.parseToJsonElement(s)
            if (el !is kotlinx.serialization.json.JsonArray) return null
            val out = ArrayList<String>(el.size)
            for (e in el) {
                if (e !is kotlinx.serialization.json.JsonPrimitive || !e.isString) return null
                out.add(e.content)
            }
            out
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * Comparison value (config operand) → typed value, with the same three-valued error outcome
 * (validation-order parity, #509). configcat-common validates the CONFIG comparison value BEFORE
 * the user attribute for the semver relations, number relations, and datetime comparators; a
 * malformed operand surfaces a distinct "comparison value '<v>' is invalid (<reason>)" error,
 * which wins even when the user attribute is ALSO malformed.
 */
internal object ComparisonValues {
    private fun invalidComparisonValue(value: String, reason: String): String =
        "comparison value '$value' is invalid ($reason)"

    /** Comparison value → semver (config operand for the semver relations). */
    fun comparisonValueAsSemVer(value: String?): Convert<Semver> {
        val v = value ?: ""
        val version = Semver.parse(v.trim())
        if (version != null) return Convert.ok(version)
        return Convert.err(invalidComparisonValue(v, "'$v' is not a valid semantic version"))
    }

    /** Comparison value → number (config operand for the number relations). */
    fun comparisonValueAsNumber(value: Double?): Convert<Double> {
        if (value != null && !value.isNaN()) return Convert.ok(value)
        val v = jsStringOf(value)
        return Convert.err(invalidComparisonValue(v, "'$v' is not a valid decimal number"))
    }

    /** Comparison value → Unix seconds (config operand for the datetime comparators). */
    fun comparisonValueAsUnixTimeSeconds(value: Double?): Convert<Double> {
        if (value != null && !value.isNaN()) return Convert.ok(value)
        val v = jsStringOf(value)
        return Convert.err(
            invalidComparisonValue(
                v,
                "'$v' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)",
            ),
        )
    }

    /** JS `String(value)` for a `number | undefined` operand. */
    private fun jsStringOf(value: Double?): String =
        if (value == null) "undefined" else numberToCanonicalString(value)
}
