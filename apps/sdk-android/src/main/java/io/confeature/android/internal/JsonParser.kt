// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Thin adapter over Android's bundled `org.json` parser that returns plain Kotlin maps / lists
 * with JSON-decoded scalar types ([Boolean], [String], [Int], [Long], [Double], `null`).
 *
 * Why not Jackson / kotlinx-serialization? Android ships `org.json` as part of the platform
 * runtime; using it keeps the SDK's binary dependency footprint minimal (FR-003) and avoids
 * a 1MB+ Jackson addition for what amounts to a flat 3-field envelope.
 *
 * Numeric coercion mirrors the Java SDK's Jackson behaviour: integers fit into [Int] when
 * possible, otherwise [Long]; floats arrive as [Double]. [Evaluator.readInt] is permissive across
 * the three so the parity corpus crosses the API boundary unchanged.
 */
internal object JsonParser {
    /**
     * Parses [raw] as a JSON object. Throws [IllegalArgumentException] when [raw] is not a JSON
     * object (e.g. an array at the top level or a syntax error).
     */
    @JvmStatic
    fun parseObject(raw: String): Map<String, Any?> {
        return try {
            convertObject(JSONObject(raw))
        } catch (ex: JSONException) {
            throw IllegalArgumentException("malformed JSON: ${ex.message}", ex)
        }
    }

    /**
     * Serialises [value] as a JSON object string. Mirrors the round-trip path used to persist the
     * cache envelope. Throws [IllegalArgumentException] on malformed input.
     */
    @JvmStatic
    fun stringifyObject(value: Map<String, Any?>): String {
        return try {
            toJsonObject(value).toString()
        } catch (ex: JSONException) {
            throw IllegalArgumentException("failed to serialise JSON: ${ex.message}", ex)
        }
    }

    private fun convertObject(o: JSONObject): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(o.length())
        val keys = o.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out[k] = convertValue(o.opt(k))
        }
        return out
    }

    private fun convertArray(a: JSONArray): List<Any?> {
        val out = ArrayList<Any?>(a.length())
        for (i in 0 until a.length()) {
            out.add(convertValue(a.opt(i)))
        }
        return out
    }

    private fun convertValue(v: Any?): Any? =
        when (v) {
            null, JSONObject.NULL -> null
            is JSONObject -> convertObject(v)
            is JSONArray -> convertArray(v)
            is Number -> coerceNumber(v)
            else -> v // String / Boolean
        }

    private fun coerceNumber(n: Number): Any =
        when (n) {
            is Int -> n
            is Long -> if (n in Int.MIN_VALUE..Int.MAX_VALUE) n.toInt() else n
            is Double -> {
                // Integer-valued doubles arrive when the JSON source has a
                // bare integer literal that exceeds Int but fits into a
                // 53-bit mantissa. Coerce back to Int / Long for parity
                // with Jackson's UntypedObjectDeserializer.
                if (n.isFinite() && n % 1.0 == 0.0 && n in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble()) {
                    n.toInt()
                } else {
                    n
                }
            }
            is Float -> n.toDouble()
            else -> n
        }

    private fun toJsonObject(map: Map<String, Any?>): JSONObject {
        val obj = JSONObject()
        for ((k, v) in map) {
            obj.put(k, toJsonValue(v))
        }
        return obj
    }

    private fun toJsonArray(list: List<Any?>): JSONArray {
        val arr = JSONArray()
        for (v in list) arr.put(toJsonValue(v))
        return arr
    }

    private fun toJsonValue(v: Any?): Any =
        when (v) {
            null -> JSONObject.NULL
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                toJsonObject(v as Map<String, Any?>)
            }
            is List<*> -> toJsonArray(v)
            else -> v
        }
}
