// SPDX-License-Identifier: MIT
package io.confeature.kmp

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The engine's helpers do not reach back into [io.confeature.kmp.internal.Evaluator] (#928 D2).
 *
 * `Evaluator` depends on `ConfigValues`, `EvalLog` and `ConditionEvaluator`. Each of them used to
 * read a code table off `Evaluator` (the setting types, the negated comparator codes), which made
 * two modules depend on each other. The tables live in `SettingType.kt` and
 * `ConditionComparators.kt` now, and depend on nothing. Kotlin reports no import cycle, so this
 * reads the sources: comments are stripped, then any mention of the name counts.
 */
class InternalDependencyTest {

    private val internalDir =
        WorkspaceRoot.repoRoot()
            .resolve("apps/sdk-kotlin-mp/src/commonMain/kotlin/io/confeature/kmp/internal")

    /** The file's code with block and line comments removed. */
    private fun code(fileName: String): String {
        val text = String(Files.readAllBytes(internalDir.resolve(fileName)), Charsets.UTF_8)
        return text.replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "").replace(Regex("//[^\n]*"), "")
    }

    /** The declarations of [names] that [fileName]'s code mentions. */
    private fun mentions(fileName: String, names: List<String>): List<String> {
        val body = code(fileName)
        return names.filter { Regex("(?<![A-Za-z0-9_])" + it + "(?![A-Za-z0-9_])").containsMatchIn(body) }
    }

    @Test
    fun theHelpersEvaluatorReadsDoNotReadEvaluator() {
        for (file in listOf("ConfigValues.kt", "EvalLog.kt", "ConditionEvaluator.kt")) {
            assertEquals(emptyList(), mentions(file, listOf("Evaluator")), "$file mentions Evaluator")
        }
    }

    @Test
    fun theCodeTablesDependOnNoOtherModule() {
        val modules =
            listOf("Evaluator", "ConfigValues", "EvalLog", "ConditionEvaluator", "SettingEvaluator", "EvalTraceLog")
        for (file in listOf("SettingType.kt", "ConditionComparators.kt")) {
            assertEquals(emptyList(), mentions(file, modules), "$file depends on an engine module")
        }
    }
}
