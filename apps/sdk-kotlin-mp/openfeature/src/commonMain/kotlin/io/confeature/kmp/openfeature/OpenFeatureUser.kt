// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.EvaluationContext
import dev.openfeature.kotlin.sdk.Value
import io.confeature.kmp.internal.Evaluator
import kotlin.time.ExperimentalTime

internal class OpenFeatureUser private constructor(
    private val identifier: String?,
    private val attributes: Map<String, Any>,
) : Evaluator.UserView {
    override fun identifier(): String? = identifier

    override fun attribute(name: String): Any? = if (name == "Identifier") identifier else attributes[name]

    companion object {
        fun from(context: EvaluationContext?): OpenFeatureUser? {
            if (context == null) return null
            val id = context.getTargetingKey().takeIf(String::isNotEmpty)
            val attributes = buildMap {
                for ((name, value) in context.asMap()) {
                    val converted = when (name) {
                        "Identifier", "targetingKey" -> null
                        "Email", "Country" -> value.asString()
                        else -> convert(value)
                    }
                    if (converted != null) put(name, converted)
                }
            }
            return if (id == null && attributes.isEmpty()) null else OpenFeatureUser(id, attributes)
        }

        @OptIn(ExperimentalTime::class)
        private fun convert(value: Value): Any? = when (value) {
            is Value.Boolean -> value.boolean
            is Value.String -> value.string
            is Value.Integer -> value.integer
            is Value.Long -> value.long
            is Value.Double -> value.double.takeIf(Double::isFinite)
            is Value.Instant -> value.instant.epochSeconds
            is Value.List -> strings(value.list)
            is Value.Structure, Value.Null -> null
        }

        private fun strings(values: List<Value>): List<String>? {
            val strings = ArrayList<String>(values.size)
            for (value in values) strings.add(value.asString() ?: return null)
            return strings
        }
    }
}
