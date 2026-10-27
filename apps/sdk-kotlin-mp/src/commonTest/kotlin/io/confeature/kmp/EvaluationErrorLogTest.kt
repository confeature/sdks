// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.EvalTraceLog
import io.confeature.kmp.internal.Evaluator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The fail-closed frame keeps the exception it catches (#928 D1). A config the engine cannot
 * evaluate returns the caller's default, and the evaluator logs ERROR 1002 with the exception
 * attached.
 *
 * The message shape is upstream's, `configcat/kotlin-sdk` 5.1.0:
 * `ConfigCatLogMessages.getSettingEvaluationErrorWithDefaultValue` followed by
 * `FlagEvaluator.handleEvaluationError`'s `" " + exception.message` suffix, logged under event id
 * 1002 (`src/commonMain/kotlin/com/configcat/FlagEvaluator.kt`).
 *
 * In commonTest so it runs on every target, the browser one included.
 */
class EvaluationErrorLogTest {

    private class Entry(
        val level: EvalTraceLog.Level,
        val eventId: String,
        val message: String,
        val exception: Throwable?,
    )

    private class RecordingSink : EvalTraceLog.Sink {
        val entries = ArrayList<Entry>()

        override fun level(): EvalTraceLog.Level = EvalTraceLog.Level.ERROR

        override fun log(level: EvalTraceLog.Level, eventId: String, message: String, exception: Throwable?) {
            entries.add(Entry(level, eventId, message, exception))
        }
    }

    /** `flagA` has a rule whose prerequisite names a flag the config does not carry. */
    private val danglingPrerequisite: Map<String, Any?> = mapOf(
        "f" to mapOf(
            "flagA" to mapOf(
                "t" to 1,
                "v" to mapOf("s" to "served"),
                "r" to listOf(
                    mapOf(
                        "c" to listOf(
                            mapOf("p" to mapOf("f" to "absent", "c" to 0, "v" to mapOf("b" to true))),
                        ),
                        "s" to mapOf("v" to mapOf("s" to "rule")),
                    ),
                ),
            ),
        ),
    )

    @Test
    fun malformedConfig_logsError1002WithTheException() {
        val sink = RecordingSink()

        val result = Evaluator.evaluateTraced(danglingPrerequisite, "flagA", "fallback", null, sink)

        assertEquals(Evaluator.Error.MALFORMED_CONFIG, result.error)
        assertEquals("fallback", result.value)
        val errors = sink.entries.filter { it.eventId == "1002" }
        assertEquals(1, errors.size, "one ERROR 1002 entry")
        val entry = errors.single()
        assertEquals(EvalTraceLog.Level.ERROR, entry.level)
        assertEquals(
            "Error occurred in the `getValue` method while evaluating setting 'flagA'. Returning the " +
                "`defaultValue` parameter that you specified in your application: 'fallback'. " +
                "Prerequisite flag is missing or invalid.",
            entry.message,
        )
        val exception = assertNotNull(entry.exception, "the 1002 entry carries the exception")
        assertEquals("Prerequisite flag is missing or invalid.", exception.message)
    }

    @Test
    fun malformedConfig_aNullDefaultIsRenderedAsNull() {
        val sink = RecordingSink()

        Evaluator.evaluateTraced(danglingPrerequisite, "flagA", null, null, sink)

        val entry = sink.entries.single { it.eventId == "1002" }
        assertTrue(
            entry.message.contains("in your application: 'null'."),
            "upstream renders a null default as 'null': ${entry.message}",
        )
    }
}
