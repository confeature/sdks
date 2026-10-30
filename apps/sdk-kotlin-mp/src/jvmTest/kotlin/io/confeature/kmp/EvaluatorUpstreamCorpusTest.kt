// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.Comparators
import io.confeature.kmp.internal.EvalTraceLog
import io.confeature.kmp.internal.Evaluator
import io.confeature.kmp.internal.SettingType
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.math.abs

/**
 * ConfigCat conformance gate (spec 129, SC-001) — the KMP `commonMain` engine replays the vendored
 * upstream evaluation matrix on the JVM target (the authoritative parity target; the engine is
 * platform-agnostic Kotlin, so JVM conformance proves it). This is the Kotlin-Multiplatform twin of
 * the Android `EvaluatorUpstreamCorpusTest` (spec 128) and mirrors the spec-117 TS reference suite
 * + the spec-118..128 ports. The corpus
 * (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor `configcat/go-sdk@08c4882` v9 —
 * see `fixtures/upstream/PROVENANCE.md`) is the oracle: each `(config, key, user) → expected` tuple
 * is checked against [Evaluator.evaluateWith]`(...).value` (and `.variationId` for the variation-id
 * matrix).
 *
 * It reads the vendored matrix through [WorkspaceRoot.upstreamJson] / [WorkspaceRoot.upstreamText]
 * and decodes JSON via the same kotlinx-serialization path the SDK uses.
 *
 * Scope = the full conformance surface: US1 targeting rules, US2 the comparators, US3 percentage
 * rollout, US4 segments / prerequisites (incl. multilevel + circular detection) / AND-groups, US5
 * attribute conversion + trimming + typed-attribute validation + variationId / matched detail. Per
 * FR-018 only structured value / identity is asserted — never a textual trace.
 *
 * The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts` faithfully — most
 * critically the Go `csv.Reader` LazyQuotes semantics (a `"` only opens a quoted field at the field
 * start), without which every JSON-array attribute cell is corrupted.
 *
 * Custom attributes are fed through [CorpusUserView] (a typed user view the evaluator reads
 * duck-typed) so the conversion-driver cases can deliver numbers / arrays / epochs un-stringified —
 * the public `io.confeature.kmp.User` stringifies custom values by contract (`Map<String,String>`),
 * which would defeat those cases.
 */
class EvaluatorUpstreamCorpusTest {

    /**
     * Targeting-context value object for the upstream conformance corpus whose custom attributes
     * stay TYPED. Mirrors the Android / Java `CorpusUserView`.
     */
    private class CorpusUserView(
        private val id: String?,
        private val email: String?,
        private val country: String?,
        private val custom: Map<String, Any?>?,
    ) : Evaluator.UserView {
        override fun identifier(): String = id ?: ""

        override fun attribute(name: String): Any? =
            when (name) {
                "Identifier" -> id ?: ""
                "Email" -> email
                "Country" -> country
                else -> custom?.get(name)
            }

        override fun customKeys(): Iterable<String> = custom?.keys ?: emptyList()

        fun customRepr(): String = custom.toString()
    }

    private companion object {
        const val NULL_TOKEN = "##null##"

        const val PKD = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/"
        const val JCP = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/"

        /** Every eval-log scenario that contributes a byte-asserted trace tuple (#501). */
        val TRACE_SCENARIOS = listOf(
            "simple_value",
            "1_targeting_rule",
            "2_targeting_rules",
            "and_rules",
            "options_based_on_user_id",
            "options_based_on_custom_attr",
            "options_after_targeting_rule",
            "options_within_targeting_rule",
            "list_truncation",
            "number_validation",
            "circular_dep",
            "prerequisite_flag",
            "semver_validation",
            "epoch_date_validation",
        )

        /**
         * `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob was NOT
         * captured by the spec-117 vendoring (known DATA gap #401, not an engine gap). The
         * multilevel-prerequisite path IS exercised by the 3-level circular_dep chain + the
         * reconstructed-chain test below. Excluded LOUDLY (the same marker the TS / Python / Ruby /
         * PHP / Java / Android references use), never silently.
         */
        val UNVENDORED_EVAL_LOG_KEYS = listOf("dependentFeatureMultipleLevels")

        var contentByKeyCache: Map<String, Any?>? = null
        var evalLogConfigsCache: Map<String, Any?>? = null

        // -------------------------------------------------------------------
        // Matrix → SDK key mapping (verbatim from upstream-corpus.ts).
        // -------------------------------------------------------------------

        data class MatrixEntry(val matrix: String, val sdkKey: String, val variation: Boolean)

        val MATRIX_MAP = listOf(
            MatrixEntry("testmatrix.csv", PKD + "AG6C1ngVb0CvM07un6JisQ", false),
            MatrixEntry("testmatrix_semantic.csv", PKD + "iV8vH2MBakKxkFZylxHmTg", false),
            MatrixEntry("testmatrix_number.csv", PKD + "FCWN-k1dV0iBf8QZrDgjdw", false),
            MatrixEntry("testmatrix_semantic_2.csv", PKD + "U8nt3zEhDEO5S2ulubCopA", false),
            MatrixEntry("testmatrix_sensitive.csv", PKD + "-0YmVOUNgEGKkgRF-rU65g", false),
            MatrixEntry("testmatrix_segments_old.csv", PKD + "y_ZB7o-Xb0Swxth-ZlMSeA", false),
            MatrixEntry("testmatrix_and_or.csv", JCP + "ByMO9yZNn02kXcm72lnY1A", false),
            MatrixEntry("testmatrix_comparators_v6.csv", JCP + "OfQqcTjfFUGBwMKqtyEOrQ", false),
            MatrixEntry("testmatrix_prerequisite_flag.csv", JCP + "JoGwdqJZQ0K2xDy7LnbyOg", false),
            MatrixEntry("testmatrix_segments.csv", JCP + "h99HYXWWNE2bH8eWyLAVMA", false),
            MatrixEntry("testmatrix_unicode.csv", JCP + "Da6w8dBbmUeMUBhh0iEeQQ", false),
            MatrixEntry("testmatrix_variationId.csv", PKD + "spQnkRTIPEWVivZkWM84lQ", true),
        )

        fun matrixEntry(matrix: String): MatrixEntry? = MATRIX_MAP.firstOrNull { it.matrix == matrix }

        // -------------------------------------------------------------------
        // Config loaders (cached).
        // -------------------------------------------------------------------

        fun contentByKey(): Map<String, Any?> {
            var c = contentByKeyCache
            if (c == null) {
                c = WorkspaceRoot.upstreamJson("content-by-key.json")
                contentByKeyCache = c
            }
            return c
        }

        fun evalLogConfigs(): Map<String, Any?> {
            var c = evalLogConfigsCache
            if (c == null) {
                c = WorkspaceRoot.upstreamJson("evaluationlog/_configs-by-key.json")
                evalLogConfigsCache = c
            }
            return c
        }

        // -------------------------------------------------------------------
        // CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port).
        // A `"` only opens a quoted field when it is the FIRST char of the
        // field; anywhere else it is a literal quote. Getting this wrong
        // corrupts every JSON-array attribute cell.
        // -------------------------------------------------------------------

        fun parseCsvLine(line: String): List<String> {
            val fields = ArrayList<String>()
            val field = StringBuilder()
            var inQuotes = false
            var fieldStart = true
            val n = line.length
            var i = 0
            while (i < n) {
                val ch = line[i]
                when {
                    inQuotes && ch == '"' && i + 1 < n && line[i + 1] == '"' -> {
                        field.append('"')
                        i++
                    }
                    inQuotes && ch == '"' -> inQuotes = false
                    inQuotes -> field.append(ch)
                    ch == '"' && fieldStart -> {
                        inQuotes = true
                        fieldStart = false
                    }
                    ch == ';' -> {
                        fields.add(field.toString())
                        field.setLength(0)
                        fieldStart = true
                        i++
                        continue
                    }
                    else -> {
                        field.append(ch)
                        fieldStart = false
                    }
                }
                i++
            }
            fields.add(field.toString())
            return fields
        }

        private val INT_RE = Regex("-?\\d+")
        private val FLOAT_RE = Regex("-?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?")

        /** Parse a CSV cell to its primitive (mirrors upstream `parseCell`). */
        fun parseCell(s: String): Any {
            if (INT_RE.matches(s)) {
                val v = s.toLongOrNull()
                if (v != null && abs(v) <= 9007199254740991L && v.toString() == s) {
                    return if (v in Int.MIN_VALUE..Int.MAX_VALUE) v.toInt() else v
                }
            }
            if (FLOAT_RE.matches(s)) {
                return s.toDouble()
            }
            if (s == "True") return true
            if (s == "False") return false
            return s
        }

        fun setOrNull(v: String?): String? =
            if (v == null || v.isEmpty() || v == NULL_TOKEN) null else v

        /** Build a CorpusUserView from the first four CSV columns (port `userFromRow`). */
        fun userFromRow(line: List<String>, customKey: String): CorpusUserView? {
            if (line.isEmpty() || NULL_TOKEN == line[0]) return null
            val identifier = line[0]
            val email = setOrNull(get(line, 1))
            val country = setOrNull(get(line, 2))
            val customVal = setOrNull(get(line, 3))
            val custom: Map<String, Any?>? =
                if (customVal == null) null else linkedMapOf(customKey to customVal)
            return CorpusUserView(identifier, email, country, custom)
        }

        fun get(list: List<String>, idx: Int): String? = if (idx < list.size) list[idx] else null

        @Suppress("UNCHECKED_CAST")
        fun loadMatrix(matrix: String): List<MatrixTuple> {
            val entry = matrixEntry(matrix) ?: error("Unknown testmatrix file: $matrix")
            val configAny = contentByKey()[entry.sdkKey]
            check(configAny is Map<*, *>) {
                "No config for matrix $matrix (sdkKey ${entry.sdkKey})"
            }
            val config = configAny as Map<String, Any?>

            val text = WorkspaceRoot.upstreamText(matrix)
            val lines = text.split(Regex("\r?\n")).filter { it.isNotEmpty() }
            val header = parseCsvLine(lines[0])
            val customKey = if (header.size > 3) header[3] else "Custom1"
            val settingKeys = header.subList(4, header.size)

            val tuples = ArrayList<MatrixTuple>()
            for (r in 1 until lines.size) {
                val cols = parseCsvLine(lines[r])
                val user = userFromRow(cols, customKey)
                for (c in settingKeys.indices) {
                    val key = settingKeys[c]
                    val raw = if (c + 4 < cols.size) cols[c + 4] else ""
                    val expected: Any? = if (entry.variation) raw else parseCell(raw)
                    tuples.add(MatrixTuple(matrix, key, user, entry.variation, expected, config))
                }
            }
            return tuples
        }

        // -------------------------------------------------------------------
        // evaluationlog/<scenario> (port loadEvalLogScenario).
        // -------------------------------------------------------------------

        fun evalLogUser(raw: Map<String, Any?>?): CorpusUserView? {
            if (raw == null || raw.isEmpty()) return null
            var identifier = ""
            var email: String? = null
            var country: String? = null
            val custom = LinkedHashMap<String, Any?>()
            for ((k, v) in raw) {
                when (k) {
                    "Identifier" -> identifier = v?.toString() ?: ""
                    "Email" -> email = v?.toString()
                    "Country" -> country = v?.toString()
                    // Custom attrs keep their native JSON-decoded type so a numeric / bool custom
                    // attr reaches the comparator un-stringified.
                    else -> custom[k] = v
                }
            }
            return CorpusUserView(identifier, email, country, if (custom.isEmpty()) null else custom)
        }

        @Suppress("UNCHECKED_CAST")
        fun evalLogConfig(suite: Map<String, Any?>): Map<String, Any?> {
            val jsonOverride = suite["jsonOverride"]
            if (jsonOverride is String) {
                return WorkspaceRoot.upstreamJson("evaluationlog/_overrides/$jsonOverride")
            }
            val sdkKey = suite["sdkKey"]
            if (sdkKey is String) {
                var config = contentByKey()[sdkKey]
                if (config == null) config = evalLogConfigs()[sdkKey]
                check(config is Map<*, *>) { "No config for eval-log sdkKey $sdkKey" }
                return config as Map<String, Any?>
            }
            error("Eval-log suite has neither jsonOverride nor sdkKey")
        }

        @Suppress("UNCHECKED_CAST")
        fun loadEvalLogScenario(scenario: String): List<EvalLogTuple> {
            val suite = WorkspaceRoot.upstreamJson("evaluationlog/$scenario.json")
            val config = evalLogConfig(suite)
            val testsAny = suite["tests"]
            val out = ArrayList<EvalLogTuple>()
            if (testsAny is List<*>) {
                for (tAny in testsAny) {
                    if (tAny !is Map<*, *>) continue
                    val t = tAny as Map<String, Any?>
                    val hasDefault = t.containsKey("defaultValue")
                    val userAny = t["user"]
                    out.add(
                        EvalLogTuple(
                            scenario,
                            (t["key"] ?: "").toString(),
                            t["defaultValue"],
                            hasDefault,
                            evalLogUser(if (userAny is Map<*, *>) userAny as Map<String, Any?> else null),
                            t["returnValue"],
                            config,
                        ),
                    )
                }
            }
            return out
        }

        // -------------------------------------------------------------------
        // Assertion helpers.
        // -------------------------------------------------------------------

        @Suppress("UNCHECKED_CAST")
        fun settingType(config: Map<String, Any?>, key: String): Int? {
            val settings = config["f"] as? Map<String, Any?> ?: return null
            val setting = settings[key] as? Map<String, Any?> ?: return null
            val t = setting["t"]
            return if (t is Number && t !is Boolean) t.toInt() else null
        }

        /** Type-appropriate default matching the resolved primitive type. */
        fun defaultFor(expected: Any?, settingType: Int?): Any {
            if (expected is Boolean) return false
            if (expected is Number) {
                return if (settingType != null && settingType == SettingType.DOUBLE) {
                    0.0
                } else {
                    0
                }
            }
            return "__default__"
        }

        /** Cast a JSON-decoded eval-log default to the type implied by `t`. */
        fun coerceDefault(def: Any?, settingType: Int?): Any? {
            if (def is Boolean) return def
            if (settingType == SettingType.DOUBLE && def is Number) {
                return def.toDouble()
            }
            if (settingType == SettingType.INT && def is Number && def !is Boolean) {
                return def.toInt()
            }
            return def
        }

        /** Numeric-tolerant equality (5 == 5.0); booleans must not equate with numbers. */
        fun valueEqual(actual: Any?, expected: Any?): Boolean {
            if (expected is Number && expected !is Boolean) {
                if (actual is Boolean || actual !is Number) return false
                val e = expected.toDouble()
                val a = actual.toDouble()
                if (e.isNaN()) return a.isNaN()
                return a == e
            }
            if ((expected is Boolean) != (actual is Boolean)) return false
            return if (expected == null) actual == null else expected == actual
        }

        fun userRepr(user: CorpusUserView?): String {
            if (user == null) return "null"
            return "id=" + user.identifier() +
                " email=" + user.attribute("Email") +
                " country=" + user.attribute("Country") +
                " custom=" + user.customRepr()
        }

        fun comparisonConfig(fixture: String): Map<String, Any?> =
            WorkspaceRoot.upstreamJson("$fixture.json")

        fun firstWhere(cases: List<EvalLogTuple>, p: (EvalLogTuple) -> Boolean): EvalLogTuple =
            cases.firstOrNull(p)
                ?: error("No matching case in corpus scenario")

        // -------------------------------------------------------------------
        // Tiny config-builder helpers for the reconstructed-chain / cycle /
        // numeric tests (so the inline blobs stay readable).
        // -------------------------------------------------------------------

        fun cfg(flags: Map<String, Any?>): Map<String, Any?> {
            val p = linkedMapOf<String, Any?>("u" to "", "r" to 0, "s" to "salt")
            return linkedMapOf("p" to p, "s" to ArrayList<Any?>(), "f" to flags)
        }

        fun setting(t: Int, v: Map<String, Any?>, i: String, r: List<Any?>): MutableMap<String, Any?> =
            linkedMapOf("t" to t, "v" to v, "i" to i, "r" to r)

        fun boolV(b: Boolean): Map<String, Any?> = linkedMapOf("b" to b)

        fun strV(s: String): Map<String, Any?> = linkedMapOf("s" to s)

        fun served(v: Map<String, Any?>, i: String): Map<String, Any?> =
            linkedMapOf("v" to v, "i" to i)

        fun rule(conditions: List<Any?>, served: Map<String, Any?>): Map<String, Any?> =
            linkedMapOf("c" to conditions, "s" to served)

        fun prereqCond(flag: String, cmp: Int, v: Map<String, Any?>): Map<String, Any?> {
            val p = linkedMapOf<String, Any?>("f" to flag, "c" to cmp, "v" to v)
            return linkedMapOf("p" to p)
        }

        fun userCond(attr: String, cmp: Int, d: Double): Map<String, Any?> {
            val u = linkedMapOf<String, Any?>("a" to attr, "c" to cmp, "d" to d)
            return linkedMapOf("u" to u)
        }
    }

    private data class MatrixTuple(
        val matrix: String,
        val key: String,
        val user: CorpusUserView?,
        val variation: Boolean,
        val expected: Any?,
        val config: Map<String, Any?>,
    )

    private data class EvalLogTuple(
        val scenario: String,
        val key: String,
        val defaultValue: Any?,
        val hasDefault: Boolean,
        val user: CorpusUserView?,
        val expectedValue: Any?,
        val config: Map<String, Any?>,
    )

    private fun assertMatrixTuple(tuple: MatrixTuple, failures: MutableList<String>) {
        val label = tuple.matrix + " " + tuple.key + " user=" + userRepr(tuple.user)
        if (tuple.variation) {
            val result = Evaluator.evaluateWith(tuple.config, tuple.key, null, tuple.user)
            if (result.variationId != tuple.expected) {
                failures.add("$label: actual=${result.variationId} expected=${tuple.expected}")
            }
            return
        }
        val def = defaultFor(tuple.expected, settingType(tuple.config, tuple.key))
        val result = Evaluator.evaluateWith(tuple.config, tuple.key, def, tuple.user)
        if (!valueEqual(result.value, tuple.expected)) {
            failures.add("$label: actual=${result.value} expected=${tuple.expected}")
        }
    }

    private fun assertEvalLogValue(tuple: EvalLogTuple, failures: MutableList<String>) {
        val expected = tuple.expectedValue
        val st = settingType(tuple.config, tuple.key)
        val def =
            if (!tuple.hasDefault || tuple.defaultValue == null) {
                defaultFor(expected, st)
            } else {
                coerceDefault(tuple.defaultValue, st)
            }
        val label = tuple.scenario + " " + tuple.key + " user=" + userRepr(tuple.user)
        val result = Evaluator.evaluateWith(tuple.config, tuple.key, def, tuple.user)
        if (!valueEqual(result.value, expected)) {
            failures.add("$label: actual=${result.value} expected=$expected")
        }
    }

    private fun assertNoFailures(failures: List<String>) {
        assertTrue(failures.isEmpty(), "${failures.size} drift:\n${failures.joinToString("\n")}")
    }

    // =======================================================================
    // US1 / US2 — value + comparator matrices
    // =======================================================================

    @TestFactory
    fun valueMatrices(): List<DynamicTest> {
        val matrices = listOf(
            "testmatrix.csv",
            "testmatrix_comparators_v6.csv",
            "testmatrix_semantic.csv",
            "testmatrix_semantic_2.csv",
            "testmatrix_number.csv",
            "testmatrix_sensitive.csv",
            "testmatrix_unicode.csv",
        )
        return matrices.map { m -> DynamicTest.dynamicTest(m) { runMatrix(m) } }
    }

    private fun runMatrix(matrix: String) {
        val tuples = loadMatrix(matrix)
        assertTrue(tuples.isNotEmpty(), "$matrix produced no tuples")
        val failures = ArrayList<String>()
        for (t in tuples) assertMatrixTuple(t, failures)
        assertNoFailures(failures)
    }

    // =======================================================================
    // US1 — targeting-rule eval-log scenarios
    // =======================================================================

    @TestFactory
    fun targetingRuleScenarios(): List<DynamicTest> =
        listOf("1_targeting_rule", "2_targeting_rules", "simple_value")
            .map { s -> DynamicTest.dynamicTest(s) { runEvalLog(s) } }

    private fun runEvalLog(scenario: String) {
        val failures = ArrayList<String>()
        val tuples = loadEvalLogScenario(scenario)
        assertTrue(tuples.isNotEmpty(), "$scenario produced no tuples")
        for (t in tuples) assertEvalLogValue(t, failures)
        assertNoFailures(failures)
    }

    @Test
    fun matchedTargetingRuleIsReported() {
        val cases = loadEvalLogScenario("1_targeting_rule")
        val matching = firstWhere(cases) { it.expectedValue == "Dog" }
        val result = Evaluator.evaluateWith(matching.config, matching.key, "default", matching.user)
        assertEquals("Dog", result.value)
        assertTrue(result.matchedTargetingRule)
        assertFalse(result.matchedPercentageOption)
        assertEquals("d0cd8f06", result.variationId)
    }

    @Test
    fun noUserServesFallbackWithReasonAndNeverThrows() {
        val cases = loadEvalLogScenario("1_targeting_rule")
        val noUser = firstWhere(cases) { it.user == null }
        val result = Evaluator.evaluateWith(noUser.config, noUser.key, "default", null)
        assertEquals("Cat", result.value) // fallback
        assertEquals(Evaluator.Error.NONE, result.error) // a value resolved cleanly
        assertNotNull(result.evalError)
        assertTrue(result.evalError!!.contains("User Object is missing"))
        assertFalse(result.matchedTargetingRule)
    }

    // =======================================================================
    // US3 — percentage rollout
    // =======================================================================

    @TestFactory
    fun percentageScenarios(): List<DynamicTest> =
        listOf(
            "options_based_on_user_id",
            "options_based_on_custom_attr",
            "options_after_targeting_rule",
            "options_within_targeting_rule",
        ).map { s -> DynamicTest.dynamicTest(s) { runEvalLog(s) } }

    @Test
    fun percentageBucketingIsDeterministic() {
        val cases = loadEvalLogScenario("options_based_on_user_id")
        val withUser = firstWhere(cases) { it.user != null }
        val first = Evaluator.evaluateWith(withUser.config, withUser.key, "default", withUser.user)
        for (i in 0 until 20) {
            val again =
                Evaluator.evaluateWith(withUser.config, withUser.key, "default", withUser.user)
            assertEquals(first.value, again.value, "percentage bucketing must be repeat-invariant")
            assertEquals(first.variationId, again.variationId)
        }
        assertTrue(valueEqual(first.value, withUser.expectedValue))
        assertTrue(first.matchedPercentageOption)
    }

    // =======================================================================
    // US4 — segments / prerequisites / AND-OR matrices + scenarios
    // =======================================================================

    @TestFactory
    fun us4Matrices(): List<DynamicTest> {
        val matrices = listOf(
            "testmatrix_and_or.csv",
            "testmatrix_segments.csv",
            "testmatrix_segments_old.csv",
            "testmatrix_prerequisite_flag.csv",
        )
        return matrices.map { m -> DynamicTest.dynamicTest(m) { runMatrix(m) } }
    }

    @TestFactory
    fun us4EvalLogScenarios(): List<DynamicTest> =
        listOf("segment", "prerequisite_flag", "and_rules")
            .map { s -> DynamicTest.dynamicTest(s) { runEvalLogExcludingUnvendored(s) } }

    private fun runEvalLogExcludingUnvendored(scenario: String) {
        val failures = ArrayList<String>()
        val tuples = loadEvalLogScenario(scenario)
        assertTrue(tuples.isNotEmpty(), "$scenario produced no tuples")
        for (t in tuples) {
            if (UNVENDORED_EVAL_LOG_KEYS.contains(t.key)) {
                continue // #401 data gap — covered by the reconstructed-chain test below.
            }
            assertEvalLogValue(t, failures)
        }
        assertNoFailures(failures)
    }

    @Test
    fun multilevelPrerequisiteResolvesThroughReconstructedChain() {
        // Reconstructed from evaluationlog/prerequisite_flag (its config blob was not vendored,
        // #401). Proves the engine recurses A -> B -> C correctly.
        val config = cfg(
            linkedMapOf(
                "mainFeatureWithoutUserCondition" to
                    setting(0, boolV(true), "main", listOf<Any?>()),
                "intermediateFeature" to
                    setting(
                        0,
                        boolV(false),
                        "inter",
                        listOf(
                            rule(
                                listOf(
                                    prereqCond("mainFeatureWithoutUserCondition", 0, boolV(true)),
                                    prereqCond("mainFeatureWithoutUserCondition", 0, boolV(true)),
                                ),
                                served(boolV(true), "interT"),
                            ),
                        ),
                    ),
                "dependentFeatureMultipleLevels" to
                    setting(
                        1,
                        strV("Cat"),
                        "dep",
                        listOf(
                            rule(
                                listOf(prereqCond("intermediateFeature", 0, boolV(true))),
                                served(strV("Dog"), "depDog"),
                            ),
                        ),
                    ),
            ),
        )
        val result = Evaluator.evaluate(config, "dependentFeatureMultipleLevels", "default", null)
        assertEquals("Dog", result.value)
        assertTrue(result.matchedTargetingRule)
    }

    // =======================================================================
    // US4 — circular-dependency termination (SC-004)
    // =======================================================================

    @Test
    fun circularDepScenariosBoundedFallback() {
        val failures = ArrayList<String>()
        val tuples = loadEvalLogScenario("circular_dep")
        assertTrue(tuples.isNotEmpty(), "circular_dep produced no tuples")
        for (t in tuples) {
            val start = System.nanoTime()
            val result = Evaluator.evaluateWith(t.config, t.key, "default", t.user)
            val elapsed = (System.nanoTime() - start) / 1_000_000_000.0
            if (elapsed >= 1.0) {
                failures.add("${t.key} took too long (${elapsed}s) — cycle not bounded")
            }
            if ("default" != result.value) {
                failures.add("${t.key} value=${result.value} (expected fail-closed default)")
            }
            if (result.error == Evaluator.Error.NONE) {
                failures.add("${t.key} resolved with no error code")
            }
        }
        assertNoFailures(failures)
    }

    @Test
    fun directTwoFlagCycleTerminates() {
        val config = cfg(
            linkedMapOf(
                "flagA" to
                    setting(
                        1,
                        strV("A"),
                        "a",
                        listOf(
                            rule(
                                listOf(prereqCond("flagB", 0, boolV(true))),
                                served(strV("AA"), "aa"),
                            ),
                        ),
                    ),
                "flagB" to
                    setting(
                        1,
                        strV("B"),
                        "b",
                        listOf(
                            rule(
                                listOf(prereqCond("flagA", 0, boolV(true))),
                                served(strV("BB"), "bb"),
                            ),
                        ),
                    ),
            ),
        )
        val start = System.nanoTime()
        val result = Evaluator.evaluate(config, "flagA", "default", null)
        val elapsed = (System.nanoTime() - start) / 1_000_000_000.0
        assertTrue(elapsed < 1.0, "a direct two-flag cycle must terminate bounded")
        assertEquals("default", result.value)
        assertTrue(result.error != Evaluator.Error.NONE)
    }

    // =======================================================================
    // US5 — normalization / conversion / trimming (comparison_*.json drivers)
    // =======================================================================

    @Test
    fun comparisonAttributeConversion() {
        val config = comparisonConfig("comparison_attribute_conversion")
        val driver: List<Array<Any?>> = listOf(
            arrayOf("numberToStringConversion", 0.12345, "1"),
            arrayOf("numberToStringConversionInt", 125, "4"),
            arrayOf("numberToStringConversionPositiveExp", -1.23456789e96, "2"),
            arrayOf("numberToStringConversionNegativeExp", -1.23456789e-96, "4"),
            arrayOf("numberToStringConversionNaN", Double.NaN, "3"),
            arrayOf("numberToStringConversionPositiveInf", Double.POSITIVE_INFINITY, "4"),
            arrayOf("numberToStringConversionNegativeInf", Double.NEGATIVE_INFINITY, "3"),
            arrayOf("dateToStringConversion", 1680307199.999, "3"),
            arrayOf("dateToStringConversionNaN", Double.NaN, "3"),
            arrayOf("dateToStringConversionPositiveInf", Double.POSITIVE_INFINITY, "1"),
            arrayOf("dateToStringConversionNegativeInf", Double.NEGATIVE_INFINITY, "5"),
            arrayOf("stringArrayToStringConversion", listOf("read", "Write", " eXecute "), "4"),
            arrayOf("stringArrayToStringConversionEmpty", emptyList<String>(), "5"),
            arrayOf("stringArrayToStringConversionSpecialChars", listOf("+<>%\"'\\/\t\r\n"), "3"),
            arrayOf("stringArrayToStringConversionUnicode", listOf("äöüÄÖÜçéèñışğâ¢™✓😀"), "2"),
        )
        val failures = ArrayList<String>()
        for (c in driver) {
            val custom = linkedMapOf<String, Any?>("Custom1" to c[1])
            val user = CorpusUserView("12345", null, null, custom)
            val result = Evaluator.evaluateWith(config, c[0] as String, "default", user)
            if (result.value != c[2]) {
                failures.add("${c[0]}: actual=${result.value} expected=${c[2]}")
            }
        }
        assertNoFailures(failures)
    }

    /**
     * Native-typed custom attributes must reach the numeric comparator un-stringified and evaluate
     * identically to their string spelling. Exercises CorpusUserView's native-numeric branch, not
     * only the string->float coercion path the matrix CSVs / eval-log scenarios cover.
     */
    @Test
    fun nativeNumericCustomAttributeMatchesStringForm() {
        val setting = setting(
            1,
            strV("no-match"),
            "ng",
            listOf(
                rule(
                    listOf(userCond("Custom1", Comparators.NUMBER_GREATER_OR_EQUALS, 18.0)),
                    served(strV("match"), "m"),
                ),
            ),
        )
        setting["a"] = "Custom1"
        val config = cfg(linkedMapOf("numericGate" to setting))

        val cases: List<Array<Any?>> = listOf(
            arrayOf(21, "match"),
            arrayOf(18.0, "match"),
            arrayOf(17, "no-match"),
            arrayOf(17.999, "no-match"),
            arrayOf("21", "match"),
            arrayOf("18.0", "match"),
            arrayOf("17", "no-match"),
        )
        val failures = ArrayList<String>()
        for (c in cases) {
            val custom = linkedMapOf<String, Any?>("Custom1" to c[0])
            val user = CorpusUserView("12345", null, null, custom)
            val result = Evaluator.evaluateWith(config, "numericGate", "default", user)
            if (result.value != c[1]) {
                failures.add("${c[0]}: actual=${result.value} expected=${c[1]}")
            }
        }
        assertNoFailures(failures)
    }

    @Test
    fun comparisonAttributeTrimming() {
        val config = comparisonConfig("comparison_attribute_trimming")
        val custom = linkedMapOf<String, Any?>(
            "Version" to " 1.0.0 ",
            "Number" to " 3 ",
            "Date" to " 1705253400 ",
        )
        val user = CorpusUserView(" 12345 ", null, "[\" USA \"]", custom)
        val failures = ArrayList<String>()
        for (c in trimmingDriver()) {
            val result = Evaluator.evaluateWith(config, c[0], "default", user)
            if (result.value != c[1]) {
                failures.add("${c[0]}: actual=${result.value} expected=${c[1]}")
            }
        }
        assertNoFailures(failures)
    }

    @Test
    fun comparisonValueTrimming() {
        val config = comparisonConfig("comparison_value_trimming")
        val custom = linkedMapOf<String, Any?>(
            "Version" to "1.0.0",
            "Number" to "3",
            "Date" to "1705253400",
        )
        val user = CorpusUserView("12345", null, "[\"USA\"]", custom)
        val failures = ArrayList<String>()
        for (c in valueTrimmingDriver()) {
            val result = Evaluator.evaluateWith(config, c[0], "default", user)
            if (result.value != c[1]) {
                failures.add("${c[0]}: actual=${result.value} expected=${c[1]}")
            }
        }
        assertNoFailures(failures)
    }

    // =======================================================================
    // US5 — typed-attribute validation outcomes (FR-010) + list truncation
    // =======================================================================

    @TestFactory
    fun validationScenarios(): List<DynamicTest> =
        listOf("semver_validation", "number_validation", "epoch_date_validation", "list_truncation")
            .map { s -> DynamicTest.dynamicTest(s) { runEvalLog(s) } }

    // =======================================================================
    // US5 — variationId + matched rule/option detail (FR-011)
    // =======================================================================

    @Test
    fun variationIdMatrix() {
        runMatrix("testmatrix_variationId.csv")
    }

    @Test
    fun segmentMatchedFlagReportsValueAndVariationId() {
        val cases = loadEvalLogScenario("segment")
        val match = firstWhere(cases) {
            "featureWithSegmentTargeting" == it.key && it.user != null
        }
        val result = Evaluator.evaluateWith(match.config, match.key, false, match.user)
        assertEquals(true, result.value)
        assertTrue(result.matchedTargetingRule)
        assertNotNull(result.variationId)
    }

    // ==========================================================================
    // Evaluation-log TRACE fidelity (ADR 0003 / epic #494, #501 KMP slice).
    //
    // Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
    // (the cross-language byte-oracle; each tuple carries a Confeature-canonical
    // expectedTrace) through Evaluator.evaluateTraced and asserts the emitted
    // trace is byte-identical. Mirrors the Android / Java / Go / Python / Rust /
    // .NET / Ruby / PHP / Dart / Elixir / C++ ports. The KMP engine is commonMain
    // and exercised on the JVM target (the authoritative parity target).
    // ==========================================================================

    @Test
    fun evalLogTraceFidelity() {
        val tuples = readCorpusArray(
            WorkspaceRoot.repoRoot()
                .resolve("packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json"),
        )
        assertTrue(tuples.isNotEmpty())

        val seen = LinkedHashMap<String, Int>()
        val failures = ArrayList<String>()

        for (t in tuples) {
            val expectedObj = t["expectedTrace"]
            val scenarioObj = t["scenario"]
            if (expectedObj !is String || scenarioObj !is String || !TRACE_SCENARIOS.contains(scenarioObj)) continue

            val key = t["key"] as String

            @Suppress("UNCHECKED_CAST")
            val config = t["config"] as Map<String, Any?>
            val st = settingType(config, key)
            // Coerce the numeric default to the setting type so e.g. doubleDefaultPi (default 0,
            // setting t=3) does not TYPE_MISMATCH before the trace is built (→ empty trace).
            val def = coerceDefault(t["defaultValue"], st)

            @Suppress("UNCHECKED_CAST")
            val user = traceUser(t["user"] as? Map<String, Any?>)

            val sink = CaptureSink()
            Evaluator.evaluateTraced(config, key, def, user, sink)
            val actual = sink.lines.joinToString("\n")

            seen.merge(scenarioObj, 1) { a, b -> a + b }
            if (actual != expectedObj) {
                failures.add(
                    "trace mismatch for $scenarioObj/$key\n--- want ---\n$expectedObj\n--- got ---\n$actual",
                )
            }
        }

        assertTrue(failures.isEmpty(), failures.joinToString("\n\n"))

        // Every trace-bearing scenario must have asserted >=1 tuple.
        for (scenario in TRACE_SCENARIOS) {
            assertTrue(
                seen.getOrDefault(scenario, 0) > 0,
                "trace scenario $scenario carried no asserted tuples",
            )
        }
    }

    /**
     * Read the top-level corpus JSON ARRAY into a list of maps via kotlinx-serialization (the same
     * decoder path [WorkspaceRoot.upstreamJson] uses for objects), so JSON integers decode to
     * Int/Long and decimals to Double exactly as the engine's own parser does.
     */
    private fun readCorpusArray(path: java.nio.file.Path): List<Map<String, Any?>> {
        val text = String(java.nio.file.Files.readAllBytes(path), Charsets.UTF_8)
        val el = kotlinx.serialization.json.Json.parseToJsonElement(text)
        require(el is kotlinx.serialization.json.JsonArray) { "Corpus root is not a JSON array" }
        val out = ArrayList<Map<String, Any?>>(el.size)
        for (e in el) {
            val decoded = decodeJsonElement(e)
            @Suppress("UNCHECKED_CAST")
            if (decoded is Map<*, *>) out.add(decoded as Map<String, Any?>)
        }
        return out
    }

    private fun decodeJsonElement(el: kotlinx.serialization.json.JsonElement?): Any? = when (el) {
        null, is kotlinx.serialization.json.JsonNull -> null
        is kotlinx.serialization.json.JsonObject -> el.mapValues { decodeJsonElement(it.value) }
        is kotlinx.serialization.json.JsonArray -> el.map { decodeJsonElement(it) }
        is kotlinx.serialization.json.JsonPrimitive -> decodePrimitive(el)
        else -> null
    }

    private fun decodePrimitive(p: kotlinx.serialization.json.JsonPrimitive): Any? {
        if (p.isString) return p.content
        p.booleanOrNull?.let { return it }
        p.longOrNull?.let { return if (it in Int.MIN_VALUE..Int.MAX_VALUE) it.toInt() else it }
        p.doubleOrNull?.let { return it }
        return p.contentOrNull
    }

    /**
     * Build a [CorpusUserView] from the corpus tuple's LOWERCASE user object
     * (`{identifier, email?, country?, custom?}`) by reshaping it into the capitalized flat form
     * [evalLogUser] expects, then reusing it.
     */
    @Suppress("UNCHECKED_CAST")
    private fun traceUser(raw: Map<String, Any?>?): CorpusUserView? {
        if (raw == null || raw.isEmpty()) return null
        val reshaped = LinkedHashMap<String, Any?>()
        raw["identifier"]?.let { reshaped["Identifier"] = it }
        raw["email"]?.let { reshaped["Email"] = it }
        raw["country"]?.let { reshaped["Country"] = it }
        (raw["custom"] as? Map<String, Any?>)?.let { reshaped.putAll(it) }
        return evalLogUser(reshaped)
    }

    /** INFO-level eval-log capture sink reconstructing the parity byte-string. */
    private class CaptureSink : EvalTraceLog.Sink {
        val lines = ArrayList<String>()

        override fun level(): EvalTraceLog.Level = EvalTraceLog.Level.INFO

        override fun log(level: EvalTraceLog.Level, eventId: String, message: String, exception: Throwable?) {
            lines.add(traceLabel(level) + ": [" + eventId + "] " + message)
        }

        private fun traceLabel(level: EvalTraceLog.Level): String =
            when (level) {
                EvalTraceLog.Level.ERROR -> "ERROR"
                EvalTraceLog.Level.WARN -> "WARN"
                EvalTraceLog.Level.INFO -> "INFO"
                EvalTraceLog.Level.DEBUG -> "DEBUG"
                else -> "?"
            }
    }

    // -----------------------------------------------------------------------
    // Trimming driver tables (ported verbatim from upstream-corpus.ts).
    // -----------------------------------------------------------------------

    private fun trimmingDriver(): List<Array<String>> {
        val noTrim = listOf(
            "isoneof", "isnotoneof", "isoneofhashed", "isnotoneofhashed", "equalshashed",
            "notequalshashed", "arraycontainsanyofhashed", "arraynotcontainsanyofhashed",
            "equals", "notequals", "startwithanyof", "notstartwithanyof", "endswithanyof",
            "notendswithanyof", "arraycontainsanyof", "arraynotcontainsanyof", "startwithanyofhashed",
            "notstartwithanyofhashed", "endswithanyofhashed", "notendswithanyofhashed",
        )
        val out = ArrayList<Array<String>>()
        for (k in noTrim) out.add(arrayOf(k, "no trim"))
        val trim = listOf(
            arrayOf("semverisoneof", "4 trim"),
            arrayOf("semverisnotoneof", "5 trim"),
            arrayOf("semverless", "6 trim"),
            arrayOf("semverlessequals", "7 trim"),
            arrayOf("semvergreater", "8 trim"),
            arrayOf("semvergreaterequals", "9 trim"),
            arrayOf("numberequals", "10 trim"),
            arrayOf("numbernotequals", "11 trim"),
            arrayOf("numberless", "12 trim"),
            arrayOf("numberlessequals", "13 trim"),
            arrayOf("numbergreater", "14 trim"),
            arrayOf("numbergreaterequals", "15 trim"),
            arrayOf("datebefore", "18 trim"),
            arrayOf("dateafter", "19 trim"),
        )
        out.addAll(trim)
        out.add(arrayOf("containsanyof", "no trim"))
        out.add(arrayOf("notcontainsanyof", "no trim"))
        return out
    }

    private fun valueTrimmingDriver(): List<Array<String>> {
        val noTrim = listOf(
            "isoneof", "isnotoneof", "containsanyof", "notcontainsanyof", "isoneofhashed",
            "isnotoneofhashed", "equalshashed", "notequalshashed", "arraycontainsanyofhashed",
            "arraynotcontainsanyofhashed", "equals", "notequals", "startwithanyof",
            "notstartwithanyof", "endswithanyof", "notendswithanyof", "arraycontainsanyof",
            "arraynotcontainsanyof", "startwithanyofhashed", "notstartwithanyofhashed",
            "endswithanyofhashed", "notendswithanyofhashed",
        )
        val out = ArrayList<Array<String>>()
        for (k in noTrim) out.add(arrayOf(k, "no trim"))
        val trim = listOf(
            arrayOf("semverisoneof", "4 trim"),
            arrayOf("semverisnotoneof", "5 trim"),
            arrayOf("semverless", "6 trim"),
            arrayOf("semverlessequals", "7 trim"),
            arrayOf("semvergreater", "8 trim"),
            arrayOf("semvergreaterequals", "9 trim"),
        )
        out.addAll(trim)
        return out
    }
}
