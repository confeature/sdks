// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

/**
 * The evaluator's internal model: the per-evaluation context, the condition outcome, the resolved
 * setting envelope and the two fail-closed exceptions. [Evaluator] is the public entrypoint; the
 * walk itself lives in [SettingEvaluator], [ConditionEvaluator] and [ComparatorDispatch].
 */

/** The error text of a condition that needs a User Object when none was given. */
internal const val MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing"

/** The error text of a condition whose user attribute is absent. */
internal fun missingUserAttributeError(attr: String): String =
    "cannot evaluate, the User.$attr attribute is missing"

/** Internal three-valued condition outcome kind (MATCH / NO_MATCH / VALIDATION_ERROR). */
internal enum class MatchOutcome {
    MATCH,
    NO_MATCH,
    VALIDATION_ERROR,
}

/**
 * Three-valued condition outcome carrying the error text (data-model §3). Mirrors the TS
 * `ConditionOutcome` (`true | false | {error}`): an error short-circuits the AND group like
 * `false` but its message is surfaced for the trace's THEN consequence. [comparisonValueError]
 * flags the #509 malformed-operand path (a distinct WARN 3004 with no "please check…" suffix);
 * [attribute] + [reason] flag a typed-attribute conversion failure (WARN 3004
 * `userObjectAttributeIsInvalid`).
 */
internal class ConditionOutcome private constructor(
    val kind: MatchOutcome,
    val error: String?,
    val comparisonValueError: Boolean,
    val attribute: String?,
    val reason: String?,
) {
    fun isMatch(): Boolean = kind == MatchOutcome.MATCH

    fun isError(): Boolean = kind == MatchOutcome.VALIDATION_ERROR

    companion object {
        val MATCH = ConditionOutcome(MatchOutcome.MATCH, null, false, null, null)
        val NO_MATCH = ConditionOutcome(MatchOutcome.NO_MATCH, null, false, null, null)

        fun match(b: Boolean): ConditionOutcome = if (b) MATCH else NO_MATCH

        /** Generic validation error (missing user / missing attribute): no WARN 3004 from here. */
        fun attributeError(error: String): ConditionOutcome =
            ConditionOutcome(MatchOutcome.VALIDATION_ERROR, error, false, null, null)

        /** Typed-attribute conversion failure: emits WARN 3004 `userObjectAttributeIsInvalid`. */
        fun invalidAttribute(error: String, attribute: String?, reason: String?): ConditionOutcome =
            ConditionOutcome(MatchOutcome.VALIDATION_ERROR, error, false, attribute, reason)

        /** Malformed CONFIG comparison value (#509): emits WARN 3004 `comparisonValueIsInvalid`. */
        fun comparisonValueError(error: String): ConditionOutcome =
            ConditionOutcome(MatchOutcome.VALIDATION_ERROR, error, true, null, null)
    }
}

/** Thrown on a detected prerequisite cycle; caught by the evaluator's fail-closed frame. */
internal class CircularDependencyException(message: String, val cycle: String) :
    RuntimeException(message)

/** Thrown on a malformed config the engine cannot evaluate; caught by the fail-closed frame. */
internal class MalformedConfigException(message: String) : RuntimeException(message)

/** This value, or a [MalformedConfigException] with [message] when it is absent (fail-closed). */
internal fun <T : Any> T?.orMalformed(message: String): T =
    this ?: throw MalformedConfigException(message)

/** The resolved `v` envelope + matched-rule/option identity. */
internal class SettingResult(val value: Map<String, Any?>?, var variationId: String?) {
    var matchedRule: Boolean = false
    var matchedOption: Boolean = false
}

/** The two salts a sensitive (SHA-256) comparator hashes with: the config's and the context's. */
internal class HashSalt(val config: String, val context: String)

/**
 * What one evaluation shares with every prerequisite it resolves: the config, the user, the
 * visited-flags stack (cycle detection) and the trace.
 */
internal class EvalScope(
    val settings: Map<String, Any?>,
    val segments: List<Any?>,
    val configSalt: String,
    val user: Evaluator.UserView?,
    val log: EvalTraceLog,
    val logBuilder: EvalLog.EvaluateLogBuilder?,
) {
    val visitedFlags: MutableList<String> = ArrayList()
}

/** Per-setting context threaded through rule / condition / prerequisite resolution. */
internal class EvalContext(
    val key: String,
    val setting: Map<String, Any?>,
    private val scope: EvalScope,
) {
    val settings: Map<String, Any?> = scope.settings
    val segments: List<Any?> = scope.segments
    val configSalt: String = scope.configSalt
    val user: Evaluator.UserView? = scope.user
    val visitedFlags: MutableList<String> = scope.visitedFlags
    val log: EvalTraceLog = scope.log
    val logBuilder: EvalLog.EvaluateLogBuilder? = scope.logBuilder

    var evalError: String? = null
    var missingUserLogged: Boolean = false

    /** Keep the first error the evaluation surfaced; later ones do not overwrite it. */
    fun recordError(message: String?) {
        if (evalError == null) evalError = message
    }

    /**
     * Surface the missing User Object. ConfigCat logs the no-user WARN (event 3001) once per
     * context. A prerequisite flag evaluates in its OWN context (fresh state), so a prereq
     * referenced by N rules logs it N times (common-js parity).
     */
    fun surfaceMissingUser() {
        recordError(MISSING_USER_OBJECT_ERROR)
        if (!missingUserLogged) {
            log.userObjectIsMissing(key)
            missingUserLogged = true
        }
    }

    /**
     * Derive a child context for a prerequisite flag: same config / user / visited-flags stack /
     * trace, but a fresh `missingUserLogged` so a prereq referenced by N rules logs WARN 3001 N
     * times (common-js parity). The child seeds the parent's first surfaced error.
     */
    fun withChild(childKey: String, childSetting: Map<String, Any?>): EvalContext {
        val child = EvalContext(childKey, childSetting, scope)
        child.evalError = this.evalError
        return child
    }
}

/** One user condition's operands, read once from the config and handed to its comparator. */
internal class UserConditionOperands(
    val cmp: Int,
    val attrName: String,
    val attrValue: Any?,
    val list: List<String>,
    /** The `s` comparison value, or "" when absent. */
    val comparisonText: String,
    /** The `d` comparison value, or null when absent. */
    val comparisonNumber: Double?,
) {
    /** The `d` comparison value, 0.0 when absent. */
    val comparisonNumberOrZero: Double = comparisonNumber ?: 0.0
}
