// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import kotlin.math.abs

/**
 * ConfigCat's canonical stringification of user-attribute values (common-js
 * `userAttributeValueToString`): JS `Number.toString` for numbers, JS `JSON.stringify` for string
 * arrays, and the eval-log header's `for User '…'` JSON.
 */
internal object AttributeStrings {
    // ECMAScript Number::toString: the decimal-point position range rendered in fixed notation.
    private const val JS_FIXED_MAX_POINT = 21
    private const val JS_FIXED_MIN_POINT = -5

    /** True iff [value] is a [List] every element of which is a [String]. */
    fun isStringArray(value: Any?): Boolean {
        if (value !is List<*>) return false
        for (e in value) if (e !is String) return false
        return true
    }

    /**
     * Stringify a user-attribute value (common-js `userAttributeValueToString`): String verbatim;
     * bool → "true"/"false"; string array → compact JSON (JS `JSON.stringify`); number → JS
     * canonical string; else `toString`.
     */
    fun userAttributeValueToString(value: Any?): String {
        if (value is String) return value
        if (value is Boolean) return if (value) "true" else "false"
        if (isStringArray(value)) {
            @Suppress("UNCHECKED_CAST")
            return jsonStringifyStringArray(value as List<String>)
        }
        if (value is Number) return numberToCanonicalString(value.toDouble())
        return value.toString()
    }

    /**
     * Serialise a string list exactly as ECMAScript `JSON.stringify` (compact, no spaces) — a
     * hand-rolled encoder so the escaping matches JS for the
     * `stringArrayToStringConversionSpecialChars` corpus case (the hashed comparison value was
     * computed against the JS spelling; `/` is NOT escaped).
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
        val av = abs(value)
        val dp = shortestDigitsAndPoint(av)
        val digits = dp[0]
        val k = digits.length
        val n = dp[1].toInt()

        if (n in k..JS_FIXED_MAX_POINT) {
            return sign + digits + repeat('0', n - k)
        }
        if (n in 1..JS_FIXED_MAX_POINT) {
            return sign + digits.substring(0, n) + "." + digits.substring(n)
        }
        if (n in JS_FIXED_MIN_POINT..0) {
            return sign + "0." + repeat('0', -n) + digits
        }
        val e = n - 1
        val expSign = if (e >= 0) "+" else "-"
        val mant = if (k == 1) digits.substring(0, 1) else digits[0] + "." + digits.substring(1)
        return sign + mant + "e" + expSign + abs(e)
    }

    /**
     * Decompose the shortest round-tripping repr of a positive double into `[digits, point]` —
     * `point` is the count of significant digits before the decimal point in normalized form (the
     * ECMAScript `n`). The JVM `Double.toString` (the authoritative parity target) produces a
     * shortest round-tripping mantissa, so its digits + exponent reconstruct the JS form.
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
        return arr.concatToString()
    }

    /**
     * Render the user's attributes as the eval-log header shows them — a Confeature-canonical object
     * `{Identifier, Email?, Country?, …custom}` JSON-serialized to the `for User '…'` token (ADR
     * 0003 addendum). This is the configcat-js form; insertion order is fixed (Identifier, Email,
     * Country, then custom in encounter order), and the serialization is compact with JS-JSON string
     * escaping (`JSON.stringify`).
     */
    fun userAttributesForLogJson(user: Evaluator.UserView): String {
        val sb = StringBuilder()
        sb.append('{')
        sb.append("\"Identifier\":")
        jsonEscapeString(user.identifier() ?: "", sb)

        val email = user.attribute("Email")
        if (email is String && email.isNotEmpty()) {
            sb.append(",\"Email\":")
            jsonEscapeString(email, sb)
        }
        val country = user.attribute("Country")
        if (country is String && country.isNotEmpty()) {
            sb.append(",\"Country\":")
            jsonEscapeString(country, sb)
        }
        for (name in user.customKeys()) {
            sb.append(',')
            jsonEscapeString(name, sb)
            sb.append(':')
            jsonEscapeString(userAttributeValueToString(user.attribute(name)), sb)
        }
        sb.append('}')
        return sb.toString()
    }
}
