// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import java.nio.charset.StandardCharsets
import org.json.JSONArray

/**
 * The 36 ConfigCat `UserComparator` operations, ported field-for-field from
 * `packages/sdk-shared/src/comparators.ts` (the spec-117 reference, verified against
 * `configcat-common`; transliterated from the Java port `io.confeature.client.internal.Comparators`).
 *
 * Six families: text (cleartext, case-sensitive, no trim), sensitive text (SHA-256 salted), semver,
 * number (strict whole-string parse, `,`→`.`), datetime (Unix seconds), array (cleartext +
 * sensitive). Attribute-conversion entrypoints accept `Any?` so both the conformance harness and
 * the public typed `User.custom` (`Map<String, Any>`, spec 151 / #468) can feed native
 * number/array/date attrs un-stringified; a `String` attribute flows through verbatim.
 */
internal object Comparators {
    private val NUMERIC_INT = Regex("^-?\\d+$")
    private val LEADING_ZERO_REJECT = Regex("^\\s*$|^\\s*0[^\\d.eE]")
    private val FLOAT_RE = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$")

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
    // Attribute conversion helpers
    // -------------------------------------------------------------------------

    /** True iff [value] is a [List] every element of which is a [String]. */
    fun isStringArray(value: Any?): Boolean {
        if (value !is List<*>) return false
        for (e in value) if (e !is String) return false
        return true
    }

    /**
     * Stringify a user-attribute value (common-js `userAttributeValueToString`): String verbatim;
     * bool → "true"/"false"; string array → compact JSON (JS `JSON.stringify`);
     * [java.util.Date] / [java.time.Instant] → Unix epoch **seconds** (`getTime() / 1000.0`,
     * matching ConfigCat's `Date` handling); number → JS canonical string; else `toString`.
     */
    fun userAttributeValueToString(value: Any?): String {
        if (value is String) return value
        if (value is Boolean) return if (value) "true" else "false"
        if (isStringArray(value)) {
            @Suppress("UNCHECKED_CAST")
            return jsonStringifyStringArray(value as List<String>)
        }
        val epochSeconds = dateToUnixSeconds(value)
        if (epochSeconds != null) return numberToCanonicalString(epochSeconds)
        if (value is Number) return numberToCanonicalString(value.toDouble())
        return value.toString()
    }

    /**
     * Convert a [java.util.Date] / [java.time.Instant] to Unix epoch **seconds** (`getTime() /
     * 1000.0`), exactly as ConfigCat does before comparison / stringification. Returns null when
     * [value] is not a supported date type.
     */
    fun dateToUnixSeconds(value: Any?): Double? =
        when (value) {
            is java.util.Date -> value.time / 1000.0
            is java.time.Instant -> value.toEpochMilli() / 1000.0
            else -> null
        }

    /**
     * Serialise a string list exactly as ECMAScript `JSON.stringify` (compact, no spaces). org.json
     * is NOT used here because it escapes `/` as `\/`, which would diverge from JS for the
     * `stringArrayToStringConversionSpecialChars` corpus case (the hashed comparison value was
     * computed against the JS spelling).
     */
    private fun jsonStringifyStringArray(value: List<String>): String {
        val sb = StringBuilder("[")
        for (i in value.indices) {
            if (i > 0) sb.append(',')
            jsonEscapeString(value[i], sb)
        }
        sb.append(']')
        return sb.toString()
    }

    /** Append [s] JSON-escaped (ECMAScript `JSON.stringify` of a string) into [sb]. */
    private fun jsonEscapeString(s: String, sb: StringBuilder) {
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else ->
                    if (ch < ' ') {
                        sb.append("\\u")
                        sb.append(ch.code.toString(16).padStart(4, '0'))
                    } else {
                        sb.append(ch)
                    }
            }
        }
        sb.append('"')
    }

    /**
     * Stringify a number as ConfigCat's canonical string (JS `Number.toString`). NaN / ±Infinity
     * print as "NaN" / "Infinity" / "-Infinity"; otherwise the SHORTEST round-tripping digit
     * sequence, fixed-point unless the magnitude warrants exponential. The corpus
     * `numberToStringConversion*` cases hinge on this — e.g. `-1.23456789e+96` must NOT expand to
     * its full integer form.
     */
    fun numberToCanonicalString(value: Double): String {
        if (value.isNaN()) return "NaN"
        if (value.isInfinite()) return if (value > 0) "Infinity" else "-Infinity"
        if (value == 0.0) return "0"
        return jsNumberToString(value)
    }

    /** Render a finite non-zero double exactly as ECMAScript `Number.toString`. */
    private fun jsNumberToString(value: Double): String {
        val sign = if (value < 0) "-" else ""
        val av = Math.abs(value)
        val dp = shortestDigitsAndPoint(av)
        val digits = dp[0]
        val k = digits.length
        val n = dp[1].toInt()

        if (n in k..21) {
            return sign + digits + repeat('0', n - k)
        }
        if (n in 1..21) {
            return sign + digits.substring(0, n) + "." + digits.substring(n)
        }
        if (n in -5..0) {
            return sign + "0." + repeat('0', -n) + digits
        }
        val e = n - 1
        val expSign = if (e >= 0) "+" else "-"
        val mant = if (k == 1) digits.substring(0, 1) else digits[0] + "." + digits.substring(1)
        return sign + mant + "e" + expSign + Math.abs(e)
    }

    /**
     * Decompose the shortest round-tripping repr of a positive double into `[digits, point]` —
     * `point` is the count of significant digits before the decimal point in normalized form (the
     * ECMAScript `n`). Java's `Double.toString` produces a shortest round-tripping mantissa, so its
     * digits + exponent reconstruct the JS form.
     */
    private fun shortestDigitsAndPoint(av: Double): Array<String> {
        val shortest = av.toString().lowercase()
        val mant: String
        val expVal: Int
        val eIdx = shortest.indexOf('e')
        if (eIdx >= 0) {
            mant = shortest.substring(0, eIdx)
            expVal = shortest.substring(eIdx + 1).toInt()
        } else {
            mant = shortest
            expVal = 0
        }
        val intPart: String
        val fracPart: String
        val dot = mant.indexOf('.')
        if (dot >= 0) {
            intPart = mant.substring(0, dot)
            fracPart = mant.substring(dot + 1)
        } else {
            intPart = mant
            fracPart = ""
        }
        var raw = intPart + fracPart
        var point = intPart.length + expVal

        var lead = 0
        val rawLen = raw.length
        while (lead < rawLen - 1 && raw[lead] == '0') {
            lead++
            point--
        }
        raw = raw.substring(lead)
        var end = raw.length
        while (end > 1 && raw[end - 1] == '0') {
            end--
        }
        raw = raw.substring(0, end)
        if (raw.isEmpty()) raw = "0"
        return arrayOf(raw, point.toString())
    }

    private fun repeat(c: Char, count: Int): String {
        if (count <= 0) return ""
        val arr = CharArray(count) { c }
        return String(arr)
    }

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
    // Text — sensitive (SHA-256 salted)
    // -------------------------------------------------------------------------

    fun evaluateSensitiveTextEquals(
        text: String,
        comparisonValue: String,
        configSalt: String,
        contextSalt: String,
        negate: Boolean,
    ): Boolean {
        val hash = Hashing.hashComparisonValue(text, configSalt, contextSalt)
        return (hash == comparisonValue) != negate
    }

    fun evaluateSensitiveTextIsOneOf(
        text: String,
        comparisonValues: List<String>,
        configSalt: String,
        contextSalt: String,
        negate: Boolean,
    ): Boolean {
        val hash = Hashing.hashComparisonValue(text, configSalt, contextSalt)
        return comparisonValues.contains(hash) != negate
    }

    /**
     * Sensitive startsWith/endsWith-any-of. Each operand is `"<byteLen>_<hash>"`; the SDK hashes the
     * matching-length BYTE prefix/suffix of the attribute and compares to `<hash>`.
     */
    fun evaluateSensitiveTextSliceEqualsAnyOf(
        text: String,
        comparisonValues: List<String>,
        configSalt: String,
        contextSalt: String,
        startsWith: Boolean,
        negate: Boolean,
    ): Boolean {
        val textUtf8 = text.toByteArray(StandardCharsets.UTF_8)
        for (item in comparisonValues) {
            val index = item.indexOf('_')
            if (index < 0) continue
            val sliceLength = item.substring(0, index).toIntOrNull() ?: continue
            if (textUtf8.size < sliceLength) continue
            val sliceUtf8 = ByteArray(sliceLength)
            if (startsWith) {
                System.arraycopy(textUtf8, 0, sliceUtf8, 0, sliceLength)
            } else {
                System.arraycopy(textUtf8, textUtf8.size - sliceLength, sliceUtf8, 0, sliceLength)
            }
            val hash = Hashing.hashComparisonValueSlice(sliceUtf8, configSalt, contextSalt)
            if (hash == item.substring(index + 1)) return !negate
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

    fun evaluateSensitiveArrayContainsAnyOf(
        array: List<String>,
        comparisonValues: List<String>,
        configSalt: String,
        contextSalt: String,
        negate: Boolean,
    ): Boolean {
        for (item in array) {
            val hash = Hashing.hashComparisonValue(item, configSalt, contextSalt)
            if (comparisonValues.contains(hash)) return !negate
        }
        return negate
    }

    // -------------------------------------------------------------------------
    // Attribute → typed value, with a validation-error outcome (FR-010)
    // -------------------------------------------------------------------------

    /**
     * Result of an attribute conversion: the typed value, or a validation error string.
     *
     * [attribute] + [reason] carry the offending attribute name and the parenthesised reason when
     * this is a typed-attribute conversion failure (drives the WARN 3004 `userObjectAttributeIsInvalid`
     * trace line, #501); `null` for the comparison-value-invalid (#509) outcomes, which take the
     * distinct `comparisonValueIsInvalid` WARN.
     */
    class Convert<T> private constructor(
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
        val epochSeconds = dateToUnixSeconds(value)
        if (epochSeconds != null) return Convert.ok(epochSeconds)
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

    // -------------------------------------------------------------------------
    // Comparison value (config operand) → typed value, same three-valued error
    // outcome (validation-order parity, #509). configcat-common validates the
    // CONFIG comparison value BEFORE the user attribute for the semver relations,
    // number relations, and datetime comparators; a malformed operand surfaces a
    // distinct "comparison value '<v>' is invalid (<reason>)" error, which wins
    // even when the user attribute is ALSO malformed.
    // -------------------------------------------------------------------------

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

    /** Parse a JSON string-array literal to `List<String>`, or null when not a string array. */
    private fun parseJsonStringArray(s: String): List<String>? {
        return try {
            val ja = JSONArray(s)
            val out = ArrayList<String>(ja.length())
            for (i in 0 until ja.length()) {
                val e = ja.opt(i)
                if (e !is String) return null
                out.add(e)
            }
            out
        } catch (_: org.json.JSONException) {
            null
        }
    }

    /** Detect whether [s] parses as a non-negative integer string. */
    fun isIntegerString(s: String): Boolean = NUMERIC_INT.matches(s)
}
