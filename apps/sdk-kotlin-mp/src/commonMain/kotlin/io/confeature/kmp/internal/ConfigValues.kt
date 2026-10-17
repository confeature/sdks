// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * Typed reads over the JSON-decoded `config_v6` tree (maps / lists / numbers), plus the
 * setting-type value-slot selection: `0→v.b`, `1→v.s`, `2→v.i`, `3→v.d`.
 */
internal object ConfigValues {
    @Suppress("UNCHECKED_CAST")
    fun asMap(o: Any?): Map<String, Any?>? = o as? Map<String, Any?>

    fun asList(o: Any?): List<Any?>? = o as? List<Any?>

    fun readString(o: Any?): String? = o as? String

    fun readStringList(o: Any?): List<String> {
        val list = asList(o) ?: return emptyList()
        val out = ArrayList<String>(list.size)
        for (e in list) if (e is String) out.add(e)
        return out
    }

    /** Reads a JSON-decoded number as an Int (Int/Long/Double/Number). */
    fun readInt(raw: Any?): Int? =
        when (raw) {
            is Boolean -> null
            is Int -> raw
            is Long -> raw.toInt()
            is Number -> raw.toInt()
            else -> null
        }

    /** Reads a JSON-decoded number as a Double (any Number variant). */
    fun readDouble(raw: Any?): Double? =
        when (raw) {
            is Boolean -> null
            is Number -> raw.toDouble()
            else -> null
        }

    /** Select the typed value out of a `v` envelope by the setting's `t` discriminator. */
    fun selectSettingValue(value: Map<String, Any?>?, type: Int): Any? {
        if (value == null) return null
        return when (type) {
            Evaluator.SETTING_TYPE_BOOL -> value["b"]
            Evaluator.SETTING_TYPE_STRING -> value["s"]
            Evaluator.SETTING_TYPE_INT -> value["i"]
            Evaluator.SETTING_TYPE_DOUBLE -> value["d"]
            else -> null
        }
    }

    /** Coerce a selected raw value to the Kotlin type the setting type implies (or null). */
    fun coerceTyped(raw: Any?, type: Int): Any? =
        when (type) {
            Evaluator.SETTING_TYPE_BOOL -> raw as? Boolean
            Evaluator.SETTING_TYPE_STRING -> raw as? String
            Evaluator.SETTING_TYPE_INT -> if (raw is Number && raw !is Boolean) raw.toInt() else null
            Evaluator.SETTING_TYPE_DOUBLE -> if (raw is Number && raw !is Boolean) raw.toDouble() else null
            else -> null
        }

    fun defaultMatchesType(defaultValue: Any?, type: Int): Boolean =
        when (type) {
            Evaluator.SETTING_TYPE_BOOL -> defaultValue is Boolean
            Evaluator.SETTING_TYPE_STRING -> defaultValue is String
            Evaluator.SETTING_TYPE_INT -> defaultValue is Int || defaultValue is Long
            Evaluator.SETTING_TYPE_DOUBLE -> defaultValue is Double || defaultValue is Float
            else -> false
        }

    fun nullSafeEquals(a: Any?, b: Any?): Boolean {
        if (a == null) return b == null
        if (a is Number && b is Number) return a.toDouble() == b.toDouble()
        return a == b
    }
}
