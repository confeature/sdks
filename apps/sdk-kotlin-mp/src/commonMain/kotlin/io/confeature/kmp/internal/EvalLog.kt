// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import kotlin.math.abs
import kotlin.math.round

/**
 * ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic #494, KMP slice of #501).
 *
 * Kotlin port of the spec-117 TS reference (`packages/sdk-shared/src/eval-log.ts`
 * `EvaluateLogBuilder` + `COMPARATOR_META`) and the Android port
 * ([io.confeature.android.internal.EvalLog]). Produces the byte-identical indented textual trace
 * ConfigCat's SDKs emit during flag evaluation — its `evaluationlog/` corpus (replayed via
 * `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`) is the byte-oracle.
 *
 * Lives in `commonMain` — pure kotlin-common stdlib (no `java.*`); the datetime ISO suffix is
 * rendered by a hand-rolled civil-date conversion ([epochMillisToIso]) rather than `java.time`.
 *
 * The trace is emitted via the trace sink at INFO under event id 5000 (ConfigCat's verbosity
 * contract) — see [Evaluator.evaluateTraced]. This capture seam is intentionally distinct from the
 * public [io.confeature.kmp.Logger] and keeps the no-trace hot path zero-cost.
 */
internal object EvalLog {

    /** ConfigCat's event id for the "config evaluated" INFO log line. */
    const val EVENT_ID = "5000"

    /** ConfigCat indents each nested eval-log line by two spaces per level. */
    const val INDENT_UNIT = "  "

    /** Max IS-ONE-OF / list items rendered before truncation (configcat parity). */
    const val STRING_LIST_MAX_LENGTH = 10

    // Placeholders ConfigCat substitutes for malformed condition parts (parity with
    // configcat-common's EvaluateLogBuilder).
    const val INVALID_VALUE_PLACEHOLDER = "<invalid value>"
    const val INVALID_NAME_PLACEHOLDER = "<invalid name>"
    const val INVALID_OPERATOR_PLACEHOLDER = "<invalid operator>"

    /**
     * Render a resolved SETTING value for the eval log (ConfigCat parity): boolean → `true`/`false`
     * (lowercase), string → verbatim, number → its decimal string. Mirrors the `'<value>'` token in
     * ConfigCat's `Returning '<value>'.` footer (eval-log.ts `settingValueToString`).
     */
    fun settingValueToLogString(value: Any?): String =
        when (value) {
            is Boolean -> boolToLogString(value)
            is String -> value
            is Double, is Float -> AttributeStrings.numberToCanonicalString((value as Number).toDouble())
            is Number -> value.toString()
            else -> ""
        }

    /** Render a boolean as the lowercase `true`/`false` the oracle uses. */
    fun boolToLogString(value: Boolean): String = if (value) "true" else "false"

    // -------------------------------------------------------------------------
    // Comparator metadata (configcat-common parity, eval-log.ts COMPARATOR_META).
    // -------------------------------------------------------------------------

    /** Which slot a comparator reads: list / string / number / datetime. */
    enum class ComparatorKind {
        LIST,
        STR,
        NUMBER,
        DATETIME,
    }

    /** Per-comparator eval-log metadata: token rendering, value-slot kind, sensitive masking. */
    class ComparatorMeta private constructor(
        val token: String,
        val kind: ComparatorKind,
        val sensitive: Boolean,
    ) {
        companion object {
            private fun of(token: String, kind: ComparatorKind, sensitive: Boolean): ComparatorMeta =
                ComparatorMeta(token, kind, sensitive)

            private val MAP: Map<Int, ComparatorMeta> = buildMap {
                put(Comparators.TEXT_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, false))
                put(Comparators.TEXT_IS_NOT_ONE_OF, of("IS NOT ONE OF", ComparatorKind.LIST, false))
                put(Comparators.TEXT_CONTAINS_ANY_OF, of("CONTAINS ANY OF", ComparatorKind.LIST, false))
                put(
                    Comparators.TEXT_NOT_CONTAINS_ANY_OF,
                    of("NOT CONTAINS ANY OF", ComparatorKind.LIST, false),
                )
                put(Comparators.SEMVER_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, false))
                put(Comparators.SEMVER_IS_NOT_ONE_OF, of("IS NOT ONE OF", ComparatorKind.LIST, false))
                put(Comparators.SEMVER_LESS, of("<", ComparatorKind.STR, false))
                put(Comparators.SEMVER_LESS_OR_EQUALS, of("<=", ComparatorKind.STR, false))
                put(Comparators.SEMVER_GREATER, of(">", ComparatorKind.STR, false))
                put(Comparators.SEMVER_GREATER_OR_EQUALS, of(">=", ComparatorKind.STR, false))
                put(Comparators.NUMBER_EQUALS, of("=", ComparatorKind.NUMBER, false))
                put(Comparators.NUMBER_NOT_EQUALS, of("!=", ComparatorKind.NUMBER, false))
                put(Comparators.NUMBER_LESS, of("<", ComparatorKind.NUMBER, false))
                put(Comparators.NUMBER_LESS_OR_EQUALS, of("<=", ComparatorKind.NUMBER, false))
                put(Comparators.NUMBER_GREATER, of(">", ComparatorKind.NUMBER, false))
                put(Comparators.NUMBER_GREATER_OR_EQUALS, of(">=", ComparatorKind.NUMBER, false))
                put(Comparators.SENSITIVE_TEXT_IS_ONE_OF, of("IS ONE OF", ComparatorKind.LIST, true))
                put(
                    Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF,
                    of("IS NOT ONE OF", ComparatorKind.LIST, true),
                )
                put(Comparators.DATETIME_BEFORE, of("BEFORE", ComparatorKind.DATETIME, false))
                put(Comparators.DATETIME_AFTER, of("AFTER", ComparatorKind.DATETIME, false))
                put(Comparators.SENSITIVE_TEXT_EQUALS, of("EQUALS", ComparatorKind.STR, true))
                put(Comparators.SENSITIVE_TEXT_NOT_EQUALS, of("NOT EQUALS", ComparatorKind.STR, true))
                put(
                    Comparators.SENSITIVE_TEXT_STARTS_WITH_ANY_OF,
                    of("STARTS WITH ANY OF", ComparatorKind.LIST, true),
                )
                put(
                    Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
                    of("NOT STARTS WITH ANY OF", ComparatorKind.LIST, true),
                )
                put(
                    Comparators.SENSITIVE_TEXT_ENDS_WITH_ANY_OF,
                    of("ENDS WITH ANY OF", ComparatorKind.LIST, true),
                )
                put(
                    Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
                    of("NOT ENDS WITH ANY OF", ComparatorKind.LIST, true),
                )
                put(
                    Comparators.SENSITIVE_ARRAY_CONTAINS_ANY_OF,
                    of("ARRAY CONTAINS ANY OF", ComparatorKind.LIST, true),
                )
                put(
                    Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
                    of("ARRAY NOT CONTAINS ANY OF", ComparatorKind.LIST, true),
                )
                put(Comparators.TEXT_EQUALS, of("EQUALS", ComparatorKind.STR, false))
                put(Comparators.TEXT_NOT_EQUALS, of("NOT EQUALS", ComparatorKind.STR, false))
                put(
                    Comparators.TEXT_STARTS_WITH_ANY_OF,
                    of("STARTS WITH ANY OF", ComparatorKind.LIST, false),
                )
                put(
                    Comparators.TEXT_NOT_STARTS_WITH_ANY_OF,
                    of("NOT STARTS WITH ANY OF", ComparatorKind.LIST, false),
                )
                put(Comparators.TEXT_ENDS_WITH_ANY_OF, of("ENDS WITH ANY OF", ComparatorKind.LIST, false))
                put(
                    Comparators.TEXT_NOT_ENDS_WITH_ANY_OF,
                    of("NOT ENDS WITH ANY OF", ComparatorKind.LIST, false),
                )
                put(
                    Comparators.ARRAY_CONTAINS_ANY_OF,
                    of("ARRAY CONTAINS ANY OF", ComparatorKind.LIST, false),
                )
                put(
                    Comparators.ARRAY_NOT_CONTAINS_ANY_OF,
                    of("ARRAY NOT CONTAINS ANY OF", ComparatorKind.LIST, false),
                )
            }

            fun get(comparator: Int): ComparatorMeta? = MAP[comparator]

            /** Render a comparator as its eval-log operator token, or the invalid-operator placeholder. */
            fun formatUserComparator(comparator: Int): String =
                MAP[comparator]?.token ?: INVALID_OPERATOR_PLACEHOLDER
        }
    }

    // -------------------------------------------------------------------------
    // Three-valued THEN consequence (MATCH / no match / error string), mirroring
    // TS's `boolean | string` (eval-log.ts appendTargetingRuleConsequence).
    // -------------------------------------------------------------------------

    class MatchOrError private constructor(val kind: Int, val error: String?) {
        companion object {
            const val MATCH = 0
            const val NO_MATCH = 1
            const val ERROR = 2

            fun match(): MatchOrError = MatchOrError(MATCH, null)

            fun noMatch(): MatchOrError = MatchOrError(NO_MATCH, null)

            fun err(text: String?): MatchOrError = MatchOrError(ERROR, text ?: "")
        }
    }

    /**
     * Kotlin analogue of eval-log.ts `EvaluateLogBuilder`: the indent / newLine / append primitives +
     * the condition-rendering helpers. EOL is `"\n"` — the byte the upstream oracle uses.
     */
    class EvaluateLogBuilder {
        private val chunks = StringBuilder()
        private var indentLevel = 0

        /** Append text to the current line. */
        fun append(text: String): EvaluateLogBuilder {
            chunks.append(text)
            return this
        }

        /** Break to a new line at the current indent, then append [text]. */
        fun newLine(text: String?): EvaluateLogBuilder {
            chunks.append(EOL)
            repeat(indentLevel) { chunks.append(INDENT_UNIT) }
            if (!text.isNullOrEmpty()) chunks.append(text)
            return this
        }

        fun newLine(): EvaluateLogBuilder = newLine(null)

        fun increaseIndent(): EvaluateLogBuilder {
            indentLevel++
            return this
        }

        fun decreaseIndent(): EvaluateLogBuilder {
            if (indentLevel > 0) indentLevel--
            return this
        }

        /** Render one user condition (`User.<attr> <COMP> <value>`). */
        fun appendUserCondition(
            attr: String?,
            comparator: Int,
            stringValue: String?,
            numberValue: Double?,
            listValue: List<String>?,
        ): EvaluateLogBuilder {
            val attrName = attr ?: INVALID_NAME_PLACEHOLDER
            val meta = ComparatorMeta.get(comparator)
                ?: return appendUserConditionFallback(
                    attrName,
                    comparator,
                    stringValue,
                    numberValue,
                    listValue,
                )
            return when (meta.kind) {
                ComparatorKind.LIST ->
                    appendUserConditionStringList(attrName, comparator, listValue, meta.sensitive)
                ComparatorKind.STR ->
                    appendUserConditionString(attrName, comparator, stringValue, meta.sensitive)
                ComparatorKind.NUMBER ->
                    appendUserConditionNumber(attrName, comparator, numberValue, false)
                ComparatorKind.DATETIME ->
                    appendUserConditionNumber(attrName, comparator, numberValue, true)
            }
        }

        /** Append a single condition's boolean result (` => true` / ` => false, …`). */
        fun appendConditionConsequence(result: Boolean): EvaluateLogBuilder {
            append(" => " + boolToLogString(result))
            return if (result) this else append(", skipping the remaining AND conditions")
        }

        /**
         * Append a targeting rule's THEN consequence. [thenValue] is the rule's formatted served
         * value (e.g. `Dog`) for a fixed-value rule, or `null` for a rule serving `% options`.
         */
        fun appendTargetingRuleConsequence(
            thenValue: String?,
            matchKind: MatchOrError,
            newLine: Boolean,
        ): EvaluateLogBuilder {
            increaseIndent()
            if (newLine) newLine() else append(" ")
            append("THEN")
            append(if (thenValue != null) " '$thenValue'" else " % options")
            append(" => ")
            when (matchKind.kind) {
                MatchOrError.MATCH -> append("MATCH, applying rule")
                MatchOrError.NO_MATCH -> append("no match")
                else -> append(matchKind.error ?: "")
            }
            return decreaseIndent()
        }

        /** Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`). */
        fun appendPrerequisiteFlagCondition(
            prereqKey: String,
            comparator: Int,
            comparisonValue: String,
        ): EvaluateLogBuilder {
            val op = if (comparator == PrerequisiteComparator.NOT_EQUALS) "NOT EQUALS" else "EQUALS"
            return append("Flag '$prereqKey' $op '$comparisonValue'")
        }

        /** Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`). */
        fun appendSegmentCondition(segmentName: String, comparator: Int): EvaluateLogBuilder {
            val op = if (comparator == SegmentComparator.IS_NOT_IN) "IS NOT IN SEGMENT" else "IS IN SEGMENT"
            return append("User $op '$segmentName'")
        }

        /** Append a bare boolean condition result (`true` / `false`). */
        fun appendConditionResult(result: Boolean): EvaluateLogBuilder = append(boolToLogString(result))

        override fun toString(): String = chunks.toString()

        private fun appendUserConditionCore(
            attr: String,
            comparator: Int,
            value: String,
        ): EvaluateLogBuilder {
            val v = if (value.isEmpty()) INVALID_VALUE_PLACEHOLDER else value
            return append(
                "User." + attr + " " + ComparatorMeta.formatUserComparator(comparator) + " '" + v + "'",
            )
        }

        private fun appendUserConditionString(
            attr: String,
            comparator: Int,
            value: String?,
            isSensitive: Boolean,
        ): EvaluateLogBuilder {
            if (value == null) return appendUserConditionCore(attr, comparator, "")
            return appendUserConditionCore(attr, comparator, if (!isSensitive) value else "<hashed value>")
        }

        private fun appendUserConditionStringList(
            attr: String,
            comparator: Int,
            values: List<String>?,
            isSensitive: Boolean,
        ): EvaluateLogBuilder {
            if (values == null) return appendUserConditionCore(attr, comparator, "")
            val comparatorText = ComparatorMeta.formatUserComparator(comparator)
            if (isSensitive) {
                val word = if (values.size == 1) "value" else "values"
                return append(
                    "User." + attr + " " + comparatorText + " [<" + values.size + " hashed " + word + ">]",
                )
            }
            val listText = formatStringList(values, STRING_LIST_MAX_LENGTH)
            return append("User." + attr + " " + comparatorText + " [" + listText + "]")
        }

        private fun appendUserConditionNumber(
            attr: String,
            comparator: Int,
            value: Double?,
            isDateTime: Boolean,
        ): EvaluateLogBuilder {
            if (value == null) return appendUserConditionCore(attr, comparator, "")
            val comparatorText = ComparatorMeta.formatUserComparator(comparator)
            val valueText = AttributeStrings.numberToCanonicalString(value)
            val iso = if (isDateTime) unixSecondsToIso(value) else null
            return if (iso != null) {
                append("User." + attr + " " + comparatorText + " '" + valueText + "' (" + iso + " UTC)")
            } else {
                append("User." + attr + " " + comparatorText + " '" + valueText + "'")
            }
        }

        private fun appendUserConditionFallback(
            attr: String,
            comparator: Int,
            stringValue: String?,
            numberValue: Double?,
            listValue: List<String>?,
        ): EvaluateLogBuilder {
            if (stringValue != null) return appendUserConditionCore(attr, comparator, stringValue)
            if (numberValue != null) {
                return appendUserConditionCore(
                    attr,
                    comparator,
                    AttributeStrings.numberToCanonicalString(numberValue),
                )
            }
            if (listValue != null && listValue.isNotEmpty()) {
                return appendUserConditionCore(attr, comparator, listValue[0])
            }
            return appendUserConditionCore(attr, comparator, "")
        }

        companion object {
            private const val EOL = '\n'

            /**
             * Format a string list exactly as configcat-common's `formatStringList` (Utils.ts):
             * `'a', 'b'` joined by `, `, with an optional truncation appendix once [maxLength] is
             * exceeded.
             */
            private fun formatStringList(items: List<String>, maxLength: Int): String {
                if (items.isEmpty()) return ""
                var shown = items
                var appendix = ""
                if (maxLength > 0 && items.size > maxLength) {
                    shown = items.subList(0, maxLength)
                    val count = items.size - maxLength
                    val word = if (count == 1) "value" else "values"
                    appendix = ", ... <$count more $word>"
                }
                return "'" + shown.joinToString("', '") + "'" + appendix
            }

            /**
             * Render a Unix-seconds value as ConfigCat's eval-log datetime suffix — JS `new
             * Date(value*1000).toISOString()`, e.g. `2023-04-01T00:00:00.000Z` (always millisecond
             * precision, UTC). Returns `null` for non-finite values (NaN / ±Inf), matching the JS
             * `isNaN(date)` guard.
             */
            private fun unixSecondsToIso(seconds: Double): String? {
                if (seconds.isNaN() || seconds.isInfinite()) return null
                val ms = round(seconds * 1000.0).toLong()
                return epochMillisToIso(ms)
            }

            /**
             * Hand-rolled civil-date conversion (no `java.time`) — epoch milliseconds → ISO-8601
             * `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` in UTC. Uses Howard Hinnant's days-from-civil inverse
             * (`days_from_civil`/`civil_from_days`) so the rendering is byte-identical to JS
             * `Date.toISOString` across platforms.
             */
            private fun epochMillisToIso(epochMillis: Long): String {
                val msPerDay = 86_400_000L
                var days = epochMillis / msPerDay
                var msOfDay = epochMillis % msPerDay
                if (msOfDay < 0) {
                    msOfDay += msPerDay
                    days -= 1
                }
                val hour = (msOfDay / 3_600_000L).toInt()
                val minute = ((msOfDay / 60_000L) % 60L).toInt()
                val second = ((msOfDay / 1_000L) % 60L).toInt()
                val millis = (msOfDay % 1_000L).toInt()

                // civil_from_days (Hinnant): days since 1970-01-01 → (year, month, day).
                val z = days + 719_468L
                val era = (if (z >= 0) z else z - 146_096L) / 146_097L
                val doe = z - era * 146_097L
                val yoe = (doe - doe / 1_460L + doe / 36_524L - doe / 146_096L) / 365L
                val year = yoe + era * 400L
                val doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
                val mp = (5L * doy + 2L) / 153L
                val day = (doy - (153L * mp + 2L) / 5L + 1L).toInt()
                val month = (if (mp < 10L) mp + 3L else mp - 9L).toInt()
                val fullYear = (if (month <= 2) year + 1L else year)

                return pad(fullYear.toInt(), 4) + "-" + pad(month, 2) + "-" + pad(day, 2) + "T" +
                    pad(hour, 2) + ":" + pad(minute, 2) + ":" + pad(second, 2) + "." +
                    pad(millis, 3) + "Z"
            }

            private fun pad(value: Int, width: Int): String {
                val s = abs(value).toString().padStart(width, '0')
                return if (value < 0) "-$s" else s
            }
        }
    }
}
