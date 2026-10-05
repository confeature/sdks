// SPDX-License-Identifier: MIT
package io.confeature.android.internal

import io.confeature.android.User

/**
 * ConfigCat-parity flag evaluator. Pure function over a parsed `config_v6` map + [User] → returns
 * the resolved value (boolean / string / int / double) or the caller's typed fallback, plus the
 * matched-rule / matched-option / variation-id detail.
 *
 * Ported from `packages/sdk-shared/src/{evaluator,comparators,hash,semver,segments,
 * prerequisites}.ts` (the spec-117 reference, proven byte-for-byte against ConfigCat) and
 * transliterated from the Java port (spec 126, `io.confeature.client.internal.Evaluator`). The
 * setting's `t` discriminator selects the value slot: `0→v.b`, `1→v.s`, `2→v.i`, `3→v.d`.
 *
 * Fail-closed semantics (FR-012/FR-013, SC-006): any reason a value can't be resolved cleanly
 * returns the caller's default plus a discrete [Error] code; **no exception ever escapes to the
 * caller**. A circular prerequisite chain throws [CircularDependencyException] internally, caught by
 * the outer fail-closed frame → bounded fallback + error (no `StackOverflowError`).
 *
 * [evaluateTraced] additionally drives the ConfigCat-byte-identical evaluation-log trace (ADR 0003
 * / epic #494, #501): the WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk plus the
 * final INFO 5000 multi-line indented trace. The trace builders live in [EvalLog] / [EvalTraceLog];
 * a `null` sink (the hot path) is zero-cost.
 */
public object Evaluator {
    /** Setting-type discriminator for boolean values. */
    public const val SETTING_TYPE_BOOL: Int = 0

    /** Setting-type discriminator for string values. */
    public const val SETTING_TYPE_STRING: Int = 1

    /** Setting-type discriminator for int values. */
    public const val SETTING_TYPE_INT: Int = 2

    /** Setting-type discriminator for double values. */
    public const val SETTING_TYPE_DOUBLE: Int = 3

    private const val MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing"

    // PrerequisiteFlagComparator codes.
    private const val PREREQ_EQUALS = 0
    internal const val PREREQ_NOT_EQUALS = 1

    // SegmentComparator codes.
    private const val SEGMENT_IS_IN = 0
    internal const val SEGMENT_IS_NOT_IN = 1

    /** Discrete error classes — never surfaced to customers; used for logging. */
    public enum class Error {
        NONE,
        NO_CONFIG,
        KEY_NOT_FOUND,
        UNSUPPORTED_TYPE,
        TYPE_MISMATCH,
        MALFORMED_VALUE,
        MALFORMED_CONFIG,
    }

    /** Internal three-valued condition outcome kind (MATCH / NO_MATCH / VALIDATION_ERROR). */
    private enum class MatchOutcome {
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
    private class Outcome private constructor(
        val kind: MatchOutcome,
        val error: String?,
        val comparisonValueError: Boolean,
        val attribute: String?,
        val reason: String?,
    ) {
        fun isMatch(): Boolean = kind == MatchOutcome.MATCH

        fun isError(): Boolean = kind == MatchOutcome.VALIDATION_ERROR

        companion object {
            val MATCH = Outcome(MatchOutcome.MATCH, null, false, null, null)
            val NO_MATCH = Outcome(MatchOutcome.NO_MATCH, null, false, null, null)

            fun match(b: Boolean): Outcome = if (b) MATCH else NO_MATCH

            /** Generic validation error (missing user / missing attribute): no WARN 3004 from here. */
            fun attributeError(error: String): Outcome =
                Outcome(MatchOutcome.VALIDATION_ERROR, error, false, null, null)

            /** Typed-attribute conversion failure: emits WARN 3004 `userObjectAttributeIsInvalid`. */
            fun invalidAttribute(error: String, attribute: String?, reason: String?): Outcome =
                Outcome(MatchOutcome.VALIDATION_ERROR, error, false, attribute, reason)

            /** Malformed CONFIG comparison value (#509): emits WARN 3004 `comparisonValueIsInvalid`. */
            fun comparisonValueError(error: String): Outcome =
                Outcome(MatchOutcome.VALIDATION_ERROR, error, true, null, null)
        }
    }

    /** Thrown on a detected prerequisite cycle; caught by the evaluator's fail-closed frame. */
    private class CircularDependencyException(message: String, val cycle: String) :
        RuntimeException(message)

    /** Thrown on a malformed config the engine cannot evaluate; caught by the fail-closed frame. */
    private class MalformedConfigException(message: String) : RuntimeException(message)

    /** Evaluation outcome envelope (additive: variationId + matched rule/option). */
    public data class Result(
        val value: Any?,
        val error: Error,
        val variationId: String? = null,
        val matchedTargetingRule: Boolean = false,
        val matchedPercentageOption: Boolean = false,
        val evalError: String? = null,
    )

    /** The resolved `v` envelope + matched-rule/option identity (internal). */
    private class SettingResult(val value: Map<String, Any?>?, var variationId: String?) {
        var matchedRule: Boolean = false
        var matchedOption: Boolean = false
    }

    /** Per-evaluation context threaded through rule / condition / prerequisite resolution. */
    private class EvalContext(
        val key: String,
        val setting: Map<String, Any?>,
        val settings: Map<String, Any?>,
        val segments: List<Any?>,
        val configSalt: String,
        val user: UserView?,
        val visitedFlags: MutableList<String>,
        val log: EvalTraceLog,
        val logBuilder: EvalLog.EvaluateLogBuilder?,
    ) {
        var evalError: String? = null
        var missingUserLogged: Boolean = false

        /**
         * Derive a child context for a prerequisite flag: same config / user / visited-flags stack /
         * trace, but a fresh `missingUserLogged` so a prereq referenced by N rules logs WARN 3001 N
         * times (common-js parity). The child seeds the parent's first surfaced error.
         */
        fun withChild(childKey: String, childSetting: Map<String, Any?>): EvalContext {
            val child =
                EvalContext(
                    childKey,
                    childSetting,
                    settings,
                    segments,
                    configSalt,
                    user,
                    visitedFlags,
                    log,
                    logBuilder,
                )
            child.evalError = this.evalError
            return child
        }
    }

    /** A typed user view the engine reads (identifier + typed attributes). */
    public interface UserView {
        public fun identifier(): String?

        /** The attribute value (well-known or custom), or `null` when absent. */
        public fun attribute(name: String): Any?

        /**
         * Custom attribute keys in encounter order (excludes Identifier / Email / Country) — drives
         * the eval-log header's `for User '…'` JSON. Empty by default.
         */
        public fun customKeys(): Iterable<String> = emptyList()
    }

    /**
     * Adapter from the public [User]. Custom values are `Any` (typed custom attributes, spec 151 /
     * #468) — number / boolean / `List<String>` / [java.util.Date] flow through the engine's
     * ConfigCat-parity attribute conversion (number → invariant decimal, Date → epoch seconds,
     * array → JSON); a `String` value is verbatim.
     */
    private class PublicUserView(private val user: User) : UserView {
        override fun identifier(): String = user.identifier

        override fun attribute(name: String): Any? =
            when (name) {
                "Identifier" -> user.identifier
                "Email" -> user.email
                "Country" -> user.country
                else -> user.custom[name]
            }

        override fun customKeys(): Iterable<String> = user.custom.keys
    }

    /**
     * Public [User] adapter to the typed-attribute view the engine reads. The public `User.custom`
     * is `Map<String,Any>`, so number / boolean / array / [java.util.Date] attributes arrive
     * un-stringified and flow through the engine's ConfigCat-parity conversion path.
     */
    public fun fromPublicUser(user: User?): UserView? =
        if (user == null) null else PublicUserView(user)

    /**
     * Resolve [key] against the full parsed `config_v6` map + [User]. NEVER throws.
     *
     * @param config parsed `config_v6.json` root (`{p,f,s}`), or null.
     * @param key flag key to resolve.
     * @param defaultValue caller's fallback (also the TYPE_MISMATCH discriminator).
     * @param user targeting context, or null.
     */
    @JvmStatic
    public fun evaluate(
        config: Map<String, Any?>?,
        key: String,
        defaultValue: Any?,
        user: User?,
    ): Result = evaluateWith(config, key, defaultValue, fromPublicUser(user))

    /**
     * Internal entrypoint taking the typed [UserView] (the conformance harness feeds native
     * number / array / epoch attributes through a corpus-local view; the public path adapts [User]
     * via [fromPublicUser]).
     */
    public fun evaluateWith(
        config: Map<String, Any?>?,
        key: String,
        defaultValue: Any?,
        user: UserView?,
    ): Result = evaluateTraced(config, key, defaultValue, user, null)

    /**
     * [evaluateWith] with an optional eval-log trace sink (ADR 0003 / epic #494, #501). When the sink
     * is INFO-enabled it drives the ConfigCat byte-identical evaluation-log trace: the WARN
     * 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and the final INFO 5000 multi-line
     * indented trace. A `null` sink (the hot path) is zero-cost — identical behaviour to
     * [evaluateWith].
     */
    internal fun evaluateTraced(
        config: Map<String, Any?>?,
        key: String,
        defaultValue: Any?,
        user: UserView?,
        sink: EvalTraceLog.Sink?,
    ): Result {
        val log = EvalTraceLog(sink)
        if (config == null) return Result(defaultValue, Error.NO_CONFIG)

        val settings = asMap(config["f"]) ?: return Result(defaultValue, Error.NO_CONFIG)
        val settingAny = settings[key] ?: return Result(defaultValue, Error.KEY_NOT_FOUND)
        val setting = asMap(settingAny) ?: return Result(defaultValue, Error.MALFORMED_CONFIG)
        val settingType = readInt(setting["t"]) ?: return Result(defaultValue, Error.MALFORMED_CONFIG)
        if (settingType != SETTING_TYPE_BOOL &&
            settingType != SETTING_TYPE_STRING &&
            settingType != SETTING_TYPE_INT &&
            settingType != SETTING_TYPE_DOUBLE
        ) {
            return Result(defaultValue, Error.UNSUPPORTED_TYPE)
        }

        // Default-value type guard (preserves the existing tier-0 TYPE_MISMATCH contract). A null
        // default bypasses the check.
        if (defaultValue != null && !defaultMatchesType(defaultValue, settingType)) {
            return Result(defaultValue, Error.TYPE_MISMATCH)
        }

        val preferences = asMap(config["p"])
        val configSalt = (preferences?.get("s") as? String) ?: ""
        val segments = asList(config["s"]) ?: emptyList()

        // Evaluation-log trace (ADR 0003). Built lazily — only when the sink would emit at INFO. The
        // header is appended here; the `Returning '<value>'.` footer below; the whole multi-line
        // trace is surfaced under event id 5000.
        var logBuilder: EvalLog.EvaluateLogBuilder? = null
        if (log.enabled(EvalTraceLog.Level.INFO)) {
            logBuilder = EvalLog.EvaluateLogBuilder()
            logBuilder.append("Evaluating '$key'")
            if (user != null) {
                logBuilder.append(" for User '" + userAttributesForLogJson(user) + "'")
            }
        }

        val ctx =
            EvalContext(
                key,
                setting,
                settings,
                segments,
                configSalt,
                user,
                ArrayList(),
                log,
                logBuilder,
            )

        val sr: SettingResult =
            try {
                evaluateSetting(ctx)
            } catch (e: CircularDependencyException) {
                // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002 (naming the
                // setting + the chain), not the generic evaluation path.
                log.circularDependency(key, e.cycle)
                return Result(defaultValue, Error.MALFORMED_CONFIG)
            } catch (_: MalformedConfigException) {
                return Result(defaultValue, Error.MALFORMED_CONFIG)
            } catch (_: RuntimeException) {
                return Result(defaultValue, Error.MALFORMED_CONFIG)
            }

        val raw = selectSettingValue(sr.value, settingType)
        val typed = coerceTyped(raw, settingType) ?: return Result(defaultValue, Error.MALFORMED_VALUE)

        // Footer + emit. The INFO 5000 trace is emitted only when the resolved value is clean.
        if (logBuilder != null) {
            logBuilder.newLine("Returning '" + EvalLog.settingValueToLogString(typed) + "'.")
            log.info(EvalLog.EVENT_ID, logBuilder.toString())
        }

        val variationId = sr.variationId ?: readString(setting["i"])
        return Result(
            typed,
            Error.NONE,
            variationId,
            sr.matchedRule,
            sr.matchedOption,
            ctx.evalError,
        )
    }

    /**
     * Render the user's attributes as the eval-log header shows them — a Confeature-canonical object
     * `{Identifier, Email?, Country?, …custom}` JSON-serialized to the `for User '…'` token (ADR
     * 0003 addendum). This is the configcat-js form; insertion order is fixed (Identifier, Email,
     * Country, then custom in encounter order), and the serialization is compact with JS-JSON string
     * escaping (`JSON.stringify`).
     */
    private fun userAttributesForLogJson(user: UserView): String {
        val sb = StringBuilder()
        sb.append('{')
        sb.append("\"Identifier\":").append(jsJsonString(user.identifier() ?: ""))

        val email = user.attribute("Email")
        if (email is String && email.isNotEmpty()) {
            sb.append(",\"Email\":").append(jsJsonString(email))
        }
        val country = user.attribute("Country")
        if (country is String && country.isNotEmpty()) {
            sb.append(",\"Country\":").append(jsJsonString(country))
        }
        for (name in user.customKeys()) {
            sb.append(',')
                .append(jsJsonString(name))
                .append(':')
                .append(jsJsonString(Comparators.userAttributeValueToString(user.attribute(name))))
        }
        sb.append('}')
        return sb.toString()
    }

    /**
     * Serialize a string exactly as ECMAScript `JSON.stringify` renders a string value:
     * double-quoted, with `"`, `\`, and the C0 control characters escaped, all other code points
     * emitted verbatim.
     */
    private fun jsJsonString(s: String): String {
        val sb = StringBuilder()
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\t' -> sb.append("\\t")
                '\n' -> sb.append("\\n")
                '\u000C' -> sb.append("\\f")
                '\r' -> sb.append("\\r")
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
        return sb.toString()
    }

    /**
     * Resolve a setting to its `v` envelope + matched-rule/option identity: targeting-rule walk
     * (first-match-wins), then setting-level percentage options, then the served fallback.
     */
    private fun evaluateSetting(ctx: EvalContext): SettingResult {
        val rules = asList(ctx.setting["r"])
        if (rules != null && rules.isNotEmpty()) {
            val ruleResult = evaluateTargetingRules(rules, ctx)
            if (ruleResult != null) return ruleResult
        }

        val options = asList(ctx.setting["p"])
        if (options != null && options.isNotEmpty()) {
            val optionResult = evaluatePercentageOptions(options, false, ctx)
            if (optionResult != null) return optionResult
        }

        return SettingResult(asMap(ctx.setting["v"]), readString(ctx.setting["i"]))
    }

    /** Walk `setting.r[]` in document order; first rule whose AND-conditions all match wins. */
    private fun evaluateTargetingRules(rules: List<Any?>, ctx: EvalContext): SettingResult? {
        val lb = ctx.logBuilder
        lb?.newLine("Evaluating targeting rules and applying the first match if any:")
        for (ruleAny in rules) {
            val rule = asMap(ruleAny) ?: continue
            val conditions = asList(rule["c"]) ?: emptyList()
            val outcome = evaluateConditions(conditions, ctx.key, ctx, rule)
            if (!outcome.isMatch()) {
                // A rule whose conditions ERRORED (missing user/attr/validation) is ignored and
                // evaluation continues — ConfigCat emits this trace line. A rule that merely did NOT
                // match (false) just continues, with no such line.
                if (outcome.isError() && lb != null) {
                    lb.increaseIndent()
                        .newLine(
                            "The current targeting rule is ignored and the evaluation continues with" +
                                " the next rule.",
                        )
                        .decreaseIndent()
                }
                continue
            }

            val served = asMap(rule["s"])
            if (served != null) {
                val r = SettingResult(asMap(served["v"]), readString(served["i"]))
                r.matchedRule = true
                return r
            }
            // A rule serving % options: the block is traced one level deeper (under the rule). If the
            // options can't resolve (no user / missing keying attr) the rule is ignored and
            // evaluation continues.
            val options = asList(rule["p"]) ?: emptyList()
            lb?.increaseIndent()
            val optionResult = evaluatePercentageOptions(options, true, ctx)
            if (optionResult != null) {
                lb?.decreaseIndent()
                return optionResult
            }
            lb?.newLine(
                "The current targeting rule is ignored and the evaluation continues with the next" +
                    " rule.",
            )?.decreaseIndent()
        }
        return null
    }

    /**
     * Resolve a percentage-option list to its bucket: `sha1(key + attrValue)[0,7] % 100`, keyed by
     * the setting's `a` attribute (default Identifier). Returns null (skip) when there is no user or
     * the keying attribute is missing.
     */
    private fun evaluatePercentageOptions(
        options: List<Any?>,
        fromRule: Boolean,
        ctx: EvalContext,
    ): SettingResult? {
        val lb = ctx.logBuilder
        if (ctx.user == null) {
            surfaceMissingUser(ctx)
            lb?.newLine("Skipping % options because the User Object is missing.")
            return null
        }

        var attrName = ctx.setting["a"] as? String
        val attrValue: Any?
        if (attrName == null) {
            attrName = "Identifier"
            attrValue = ctx.user.identifier() ?: ""
        } else {
            attrValue = ctx.user.attribute(attrName)
        }
        if (attrValue == null) {
            if (ctx.evalError == null) ctx.evalError = missingUserAttributeError(attrName)
            ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName)
            lb?.newLine("Skipping % options because the User.$attrName attribute is missing.")
            return null
        }

        val hashValue =
            Hashing.percentageBucket(ctx.key, Comparators.userAttributeValueToString(attrValue))

        if (lb != null) {
            lb.newLine("Evaluating % options based on the User.$attrName attribute:")
            lb.newLine(
                "- Computing hash in the [0..99] range from User." +
                    attrName +
                    " => " +
                    hashValue +
                    " (this value is sticky and consistent across all SDKs)",
            )
        }

        var bucket = 0
        for (i in options.indices) {
            val option = asMap(options[i]) ?: continue
            val width = readInt(option["p"]) ?: continue
            bucket += width
            if (hashValue >= bucket) continue
            val optionValue = asMap(option["v"])
            if (lb != null) {
                lb.newLine(
                    "- Hash value " +
                        hashValue +
                        " selects % option " +
                        (i + 1) +
                        " (" +
                        width +
                        "%), '" +
                        EvalLog.settingValueToLogString(
                            selectSettingValue(optionValue, settingTypeOf(ctx)),
                        ) +
                        "'.",
                )
            }
            val r = SettingResult(optionValue, readString(option["i"]))
            r.matchedRule = fromRule
            r.matchedOption = true
            return r
        }
        // Sum of widths < 100 — a malformed config. Throw to the fail-closed frame.
        throw MalformedConfigException("Sum of percentage option percentages is less than 100.")
    }

    /**
     * AND-grouped condition list, short-circuiting on the first non-match / error. When [rule] is
     * non-null its THEN consequence is traced (a bare segment passes `null`). Mirrors evaluator.ts
     * `evaluateConditions`.
     */
    private fun evaluateConditions(
        conditions: List<Any?>,
        contextSalt: String,
        ctx: EvalContext,
        rule: Map<String, Any?>?,
    ): Outcome {
        val lb = ctx.logBuilder
        var result: Outcome = Outcome.MATCH
        lb?.newLine("- ")
        for (i in conditions.indices) {
            val condition = asMap(conditions[i])
            if (lb != null) {
                if (i == 0) {
                    lb.append("IF ").increaseIndent()
                } else {
                    lb.increaseIndent().newLine("AND ")
                }
            }

            result =
                when {
                    condition == null -> Outcome.attributeError("")
                    condition["u"] != null ->
                        evaluateUserCondition(asMap(condition["u"]), contextSalt, ctx)
                    condition["p"] != null ->
                        Outcome.match(evaluatePrerequisiteCondition(asMap(condition["p"]), ctx))
                    condition["s"] != null -> evaluateSegmentCondition(asMap(condition["s"]), ctx)
                    else -> Outcome.attributeError("")
                }

            if (lb != null) {
                // The go-sdk oracle always shows the per-condition consequence (even for a
                // single-condition rule, where configcat-js omits it) — match go.
                lb.appendConditionConsequence(result.isMatch())
                lb.decreaseIndent()
            }

            if (!result.isMatch()) break
        }

        // When evaluating a targeting rule (not a bare segment), append its THEN consequence. The go
        // oracle always newlines THEN when the rule has conditions.
        if (rule != null && lb != null) {
            val served = asMap(rule["s"])
            val thenValue =
                if (served != null) {
                    EvalLog.settingValueToLogString(
                        selectSettingValue(asMap(served["v"]), settingTypeOf(ctx)),
                    )
                } else {
                    null
                }
            val matchKind =
                when {
                    result.isMatch() -> EvalLog.MatchOrError.match()
                    result.isError() -> EvalLog.MatchOrError.err(result.error ?: "")
                    else -> EvalLog.MatchOrError.noMatch()
                }
            lb.appendTargetingRuleConsequence(thenValue, matchKind, conditions.isNotEmpty())
        }

        return result
    }

    /** Dispatch one user condition to its comparator. */
    private fun evaluateUserCondition(
        condition: Map<String, Any?>?,
        contextSalt: String,
        ctx: EvalContext,
    ): Outcome {
        val lb = ctx.logBuilder
        if (lb != null) {
            val cmpForLog = if (condition == null) null else readInt(condition["c"])
            lb.appendUserCondition(
                if (condition == null) null else readString(condition["a"]),
                cmpForLog ?: -1,
                if (condition == null) null else readString(condition["s"]),
                if (condition == null) null else readDouble(condition["d"]),
                if (condition == null) null else readStringList(condition["l"]),
            )
        }

        if (condition == null) return Outcome.attributeError("")
        if (ctx.user == null) {
            surfaceMissingUser(ctx)
            return Outcome.attributeError(MISSING_USER_OBJECT_ERROR)
        }

        val attrName = readString(condition["a"])
        val attrValue = if (attrName == null) null else ctx.user.attribute(attrName)
        if (attrName == null || attrValue == null || "" == attrValue) {
            val msg = missingUserAttributeError(attrName ?: "")
            if (ctx.evalError == null) ctx.evalError = msg
            // ConfigCat logs a WARN (event 3003) per targeting rule whose attribute is missing — not
            // deduped per evaluation.
            ctx.log.userObjectAttributeIsMissing(ctx.key, attrName ?: "")
            return Outcome.attributeError(msg)
        }

        val cmp = readInt(condition["c"]) ?: return Outcome.attributeError("")
        val configSalt = ctx.configSalt
        val list = readStringList(condition["l"])
        val svOrEmpty = readString(condition["s"]) ?: ""
        val dvBoxed = readDouble(condition["d"])
        val dv = dvBoxed ?: 0.0

        val outcome =
            dispatchComparator(
                cmp,
                attrName,
                attrValue,
                list,
                svOrEmpty,
                dvBoxed,
                dv,
                configSalt,
                contextSalt,
            )

        // Surface the WARN 3004 lines for typed-attribute / comparison-value failures.
        if (outcome.isError()) {
            if (outcome.comparisonValueError) {
                if (ctx.evalError == null) ctx.evalError = outcome.error
                ctx.log.comparisonValueIsInvalid(ctx.key, outcome.error ?: "")
            } else if (outcome.attribute != null && outcome.reason != null) {
                if (ctx.evalError == null) ctx.evalError = outcome.error
                ctx.log.userObjectAttributeIsInvalid(ctx.key, outcome.attribute, outcome.reason)
            }
        }
        return outcome
    }

    /** Dispatch the comparator slot to its evaluator, validating the config operand first (#509). */
    private fun dispatchComparator(
        cmp: Int,
        attrName: String,
        attrValue: Any?,
        list: List<String>,
        svOrEmpty: String,
        dvBoxed: Double?,
        dv: Double,
        configSalt: String,
        contextSalt: String,
    ): Outcome {
        return when (cmp) {
            Comparators.TEXT_EQUALS, Comparators.TEXT_NOT_EQUALS ->
                Outcome.match(
                    Comparators.evaluateTextEquals(
                        Comparators.attributeAsText(attrValue),
                        svOrEmpty,
                        cmp == Comparators.TEXT_NOT_EQUALS,
                    ),
                )
            Comparators.SENSITIVE_TEXT_EQUALS, Comparators.SENSITIVE_TEXT_NOT_EQUALS ->
                Outcome.match(
                    Comparators.evaluateSensitiveTextEquals(
                        Comparators.attributeAsText(attrValue),
                        svOrEmpty,
                        configSalt,
                        contextSalt,
                        cmp == Comparators.SENSITIVE_TEXT_NOT_EQUALS,
                    ),
                )
            Comparators.TEXT_IS_ONE_OF, Comparators.TEXT_IS_NOT_ONE_OF ->
                Outcome.match(
                    Comparators.evaluateTextIsOneOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        cmp == Comparators.TEXT_IS_NOT_ONE_OF,
                    ),
                )
            Comparators.SENSITIVE_TEXT_IS_ONE_OF, Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF ->
                Outcome.match(
                    Comparators.evaluateSensitiveTextIsOneOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        configSalt,
                        contextSalt,
                        cmp == Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF,
                    ),
                )
            Comparators.TEXT_STARTS_WITH_ANY_OF, Comparators.TEXT_NOT_STARTS_WITH_ANY_OF ->
                Outcome.match(
                    Comparators.evaluateTextSliceEqualsAnyOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        true,
                        cmp == Comparators.TEXT_NOT_STARTS_WITH_ANY_OF,
                    ),
                )
            Comparators.SENSITIVE_TEXT_STARTS_WITH_ANY_OF,
            Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
            ->
                Outcome.match(
                    Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        configSalt,
                        contextSalt,
                        true,
                        cmp == Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
                    ),
                )
            Comparators.TEXT_ENDS_WITH_ANY_OF, Comparators.TEXT_NOT_ENDS_WITH_ANY_OF ->
                Outcome.match(
                    Comparators.evaluateTextSliceEqualsAnyOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        false,
                        cmp == Comparators.TEXT_NOT_ENDS_WITH_ANY_OF,
                    ),
                )
            Comparators.SENSITIVE_TEXT_ENDS_WITH_ANY_OF,
            Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
            ->
                Outcome.match(
                    Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        configSalt,
                        contextSalt,
                        false,
                        cmp == Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
                    ),
                )
            Comparators.TEXT_CONTAINS_ANY_OF, Comparators.TEXT_NOT_CONTAINS_ANY_OF ->
                Outcome.match(
                    Comparators.evaluateTextContainsAnyOf(
                        Comparators.attributeAsText(attrValue),
                        list,
                        cmp == Comparators.TEXT_NOT_CONTAINS_ANY_OF,
                    ),
                )
            Comparators.SEMVER_IS_ONE_OF, Comparators.SEMVER_IS_NOT_ONE_OF -> {
                val r = Comparators.attributeAsSemVer(attrName, attrValue)
                if (!r.ok) {
                    invalidAttributeOutcome(r)
                } else {
                    Outcome.match(
                        Comparators.evaluateSemVerIsOneOf(
                            r.value!!,
                            list,
                            cmp == Comparators.SEMVER_IS_NOT_ONE_OF,
                        ),
                    )
                }
            }
            Comparators.SEMVER_LESS,
            Comparators.SEMVER_LESS_OR_EQUALS,
            Comparators.SEMVER_GREATER,
            Comparators.SEMVER_GREATER_OR_EQUALS,
            -> {
                // configcat-common validates the CONFIG comparison value BEFORE the user attribute
                // (#509): a malformed operand wins even when the attribute is also malformed.
                val cv = Comparators.comparisonValueAsSemVer(svOrEmpty)
                if (!cv.ok) {
                    Outcome.comparisonValueError(cv.error!!)
                } else {
                    val r = Comparators.attributeAsSemVer(attrName, attrValue)
                    if (!r.ok) {
                        invalidAttributeOutcome(r)
                    } else {
                        Outcome.match(Comparators.evaluateSemVerRelation(r.value!!, cmp, svOrEmpty))
                    }
                }
            }
            Comparators.NUMBER_EQUALS,
            Comparators.NUMBER_NOT_EQUALS,
            Comparators.NUMBER_LESS,
            Comparators.NUMBER_LESS_OR_EQUALS,
            Comparators.NUMBER_GREATER,
            Comparators.NUMBER_GREATER_OR_EQUALS,
            -> {
                val cv = Comparators.comparisonValueAsNumber(dvBoxed)
                if (!cv.ok) {
                    Outcome.comparisonValueError(cv.error!!)
                } else {
                    val r = Comparators.attributeAsNumber(attrName, attrValue)
                    if (!r.ok) {
                        invalidAttributeOutcome(r)
                    } else {
                        Outcome.match(Comparators.evaluateNumberRelation(r.value!!, cmp, dv))
                    }
                }
            }
            Comparators.DATETIME_BEFORE, Comparators.DATETIME_AFTER -> {
                val cv = Comparators.comparisonValueAsUnixTimeSeconds(dvBoxed)
                if (!cv.ok) {
                    Outcome.comparisonValueError(cv.error!!)
                } else {
                    val r = Comparators.attributeAsUnixTimeSeconds(attrName, attrValue)
                    if (!r.ok) {
                        invalidAttributeOutcome(r)
                    } else {
                        Outcome.match(
                            Comparators.evaluateDateTimeRelation(
                                r.value!!,
                                dv,
                                cmp == Comparators.DATETIME_BEFORE,
                            ),
                        )
                    }
                }
            }
            Comparators.ARRAY_CONTAINS_ANY_OF, Comparators.ARRAY_NOT_CONTAINS_ANY_OF -> {
                val r = Comparators.attributeAsStringArray(attrName, attrValue)
                if (!r.ok) {
                    invalidAttributeOutcome(r)
                } else {
                    Outcome.match(
                        Comparators.evaluateArrayContainsAnyOf(
                            r.value!!,
                            list,
                            cmp == Comparators.ARRAY_NOT_CONTAINS_ANY_OF,
                        ),
                    )
                }
            }
            Comparators.SENSITIVE_ARRAY_CONTAINS_ANY_OF,
            Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
            -> {
                val r = Comparators.attributeAsStringArray(attrName, attrValue)
                if (!r.ok) {
                    invalidAttributeOutcome(r)
                } else {
                    Outcome.match(
                        Comparators.evaluateSensitiveArrayContainsAnyOf(
                            r.value!!,
                            list,
                            configSalt,
                            contextSalt,
                            cmp == Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
                        ),
                    )
                }
            }
            else -> Outcome.attributeError("")
        }
    }

    /** Map a failed typed-attribute conversion to its WARN-3004-bearing [Outcome]. */
    private fun invalidAttributeOutcome(r: Comparators.Convert<*>): Outcome =
        Outcome.invalidAttribute(r.error ?: "", r.attribute, r.reason)

    /**
     * Resolve a prerequisite-flag condition (child context, fresh missing-user state). Returns a
     * plain boolean (`true`/`false`); a cycle / malformed reference throws to the fail-closed frame.
     */
    private fun evaluatePrerequisiteCondition(
        condition: Map<String, Any?>?,
        ctx: EvalContext,
    ): Boolean {
        if (condition == null) {
            throw MalformedConfigException("Prerequisite condition is missing or invalid.")
        }
        val prereqKey =
            readString(condition["f"])
                ?: throw MalformedConfigException("Prerequisite flag key is missing or invalid.")
        val prereqSetting =
            asMap(ctx.settings[prereqKey])
                ?: throw MalformedConfigException("Prerequisite flag is missing or invalid.")
        val declaredType =
            readInt(prereqSetting["t"])
                ?: throw MalformedConfigException("Prerequisite flag is missing or invalid.")

        val comparisonValue = selectSettingValue(asMap(condition["v"]), declaredType)

        val lb = ctx.logBuilder
        val cmp =
            readInt(condition["c"])
                ?: throw MalformedConfigException("Comparison operator is missing or invalid.")
        lb?.appendPrerequisiteFlagCondition(
            prereqKey,
            cmp,
            if (comparisonValue != null) EvalLog.settingValueToLogString(comparisonValue) else "",
        )

        // Cycle detection: push current key, detect a revisit before recursing.
        ctx.visitedFlags.add(ctx.key)
        if (ctx.visitedFlags.contains(prereqKey)) {
            ctx.visitedFlags.add(prereqKey)
            val cycle = ctx.visitedFlags.joinToString(" -> ")
            throw CircularDependencyException(
                "Circular dependency detected between the following depending flags: $cycle.",
                cycle,
            )
        }

        // The prerequisite evaluates in its OWN context (fresh missingUserLogged) so a prereq
        // referenced by N rules logs WARN 3001 N times, not once (common-js parity).
        val childCtx = ctx.withChild(prereqKey, prereqSetting)

        // The trace re-enters the full evaluation nested in `( … )` (go-sdk oracle structure): the
        // child appends its own "Evaluating '<key>' …" header + "Returning …".
        if (lb != null) {
            lb.newLine("(").increaseIndent().newLine("Evaluating '$prereqKey'")
            if (ctx.user != null) {
                lb.append(" for User '" + userAttributesForLogJson(ctx.user) + "'")
            }
        }

        val resolvedEnvelope = evaluateSetting(childCtx)

        if (lb != null) {
            val childValue = selectSettingValue(resolvedEnvelope.value, declaredType)
            lb.newLine("Returning '" + EvalLog.settingValueToLogString(childValue) + "'.")
                .decreaseIndent()
                .newLine(")")
        }

        if (childCtx.evalError != null && ctx.evalError == null) {
            ctx.evalError = childCtx.evalError
        }
        // Restore the stack for sibling prerequisites.
        ctx.visitedFlags.removeAt(ctx.visitedFlags.size - 1)

        val resolvedValue = selectSettingValue(resolvedEnvelope.value, declaredType)
        val equal = nullSafeEquals(resolvedValue, comparisonValue)
        return when (cmp) {
            PREREQ_EQUALS -> equal
            PREREQ_NOT_EQUALS -> !equal
            else -> throw MalformedConfigException("Comparison operator is missing or invalid.")
        }
    }

    /** Resolve a segment condition (sensitive context salt = segment NAME). */
    private fun evaluateSegmentCondition(
        condition: Map<String, Any?>?,
        ctx: EvalContext,
    ): Outcome {
        if (condition == null) throw MalformedConfigException("Segment reference is invalid.")
        val lb = ctx.logBuilder
        val index = readInt(condition["s"])
        val segment =
            if (index != null && index >= 0 && index < ctx.segments.size) {
                asMap(ctx.segments[index])
            } else {
                null
            }
        val segmentName = if (segment == null) null else readString(segment["n"])
        val segCmp = readInt(condition["c"])
        lb?.appendSegmentCondition(segmentName ?: "", segCmp ?: SEGMENT_IS_IN)

        if (ctx.user == null) {
            surfaceMissingUser(ctx)
            return Outcome.attributeError(MISSING_USER_OBJECT_ERROR)
        }
        if (segment == null) {
            throw MalformedConfigException("Segment reference is invalid.")
        }
        if (segmentName.isNullOrEmpty()) {
            throw MalformedConfigException("Segment name is missing.")
        }

        if (lb != null) {
            lb.newLine("(").increaseIndent().newLine("Evaluating segment '$segmentName':")
        }

        // The segment's AND-grouped bare user conditions, traced via the shared evaluateConditions
        // path (segment name = the sensitive-comparator salt).
        val segConditions = asList(segment["r"])
        val wrapped = ArrayList<Any?>()
        if (segConditions != null) {
            for (ucAny in segConditions) {
                wrapped.add(linkedMapOf<String, Any?>("u" to ucAny))
            }
        }

        val inSegment = evaluateConditions(wrapped, segmentName, ctx, null)

        // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
        var result = inSegment
        if (!inSegment.isError() && segCmp != null && segCmp == SEGMENT_IS_NOT_IN) {
            result = Outcome.match(!inSegment.isMatch())
        }

        if (lb != null) {
            lb.newLine("Segment evaluation result: ")
            if (!inSegment.isError()) {
                lb.append(if (inSegment.isMatch()) "User IS IN SEGMENT" else "User IS NOT IN SEGMENT")
            } else {
                lb.append(inSegment.error ?: "")
            }
            lb.append(".")
            lb.newLine("Condition (")
                .appendSegmentCondition(segmentName, segCmp ?: SEGMENT_IS_IN)
                .append(")")
            if (!result.isError()) {
                lb.append(" evaluates to ").appendConditionResult(result.isMatch())
            } else {
                lb.append(" failed to evaluate")
            }
            lb.append(".").decreaseIndent().newLine(")")
        }

        return result
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun surfaceMissingUser(ctx: EvalContext) {
        if (ctx.evalError == null) ctx.evalError = MISSING_USER_OBJECT_ERROR
        // ConfigCat logs the no-user WARN (event 3001) once per context. A prerequisite flag
        // evaluates in its OWN context (fresh state), so a prereq referenced by N rules logs it N
        // times (common-js parity).
        if (!ctx.missingUserLogged) {
            ctx.log.userObjectIsMissing(ctx.key)
            ctx.missingUserLogged = true
        }
    }

    private fun missingUserAttributeError(attr: String): String =
        "cannot evaluate, the User.$attr attribute is missing"

    /** The setting type of the current eval context (drives the value-slot selection for the trace). */
    private fun settingTypeOf(ctx: EvalContext): Int = readInt(ctx.setting["t"]) ?: SETTING_TYPE_BOOL

    /** Select the typed value out of a `v` envelope by the setting's `t` discriminator. */
    private fun selectSettingValue(value: Map<String, Any?>?, type: Int): Any? {
        if (value == null) return null
        return when (type) {
            SETTING_TYPE_BOOL -> value["b"]
            SETTING_TYPE_STRING -> value["s"]
            SETTING_TYPE_INT -> value["i"]
            SETTING_TYPE_DOUBLE -> value["d"]
            else -> null
        }
    }

    /** Coerce a selected raw value to the Kotlin type the setting type implies (or null). */
    private fun coerceTyped(raw: Any?, type: Int): Any? =
        when (type) {
            SETTING_TYPE_BOOL -> if (raw is Boolean) raw else null
            SETTING_TYPE_STRING -> if (raw is String) raw else null
            SETTING_TYPE_INT -> if (raw is Number && raw !is Boolean) raw.toInt() else null
            SETTING_TYPE_DOUBLE -> if (raw is Number && raw !is Boolean) raw.toDouble() else null
            else -> null
        }

    private fun defaultMatchesType(defaultValue: Any?, type: Int): Boolean =
        when (type) {
            SETTING_TYPE_BOOL -> defaultValue is Boolean
            SETTING_TYPE_STRING -> defaultValue is String
            SETTING_TYPE_INT -> defaultValue is Int || defaultValue is Long
            SETTING_TYPE_DOUBLE -> defaultValue is Double || defaultValue is Float
            else -> false
        }

    private fun nullSafeEquals(a: Any?, b: Any?): Boolean {
        if (a == null) return b == null
        if (a is Number && b is Number) return a.toDouble() == b.toDouble()
        return a == b
    }

    @Suppress("UNCHECKED_CAST")
    private fun asMap(o: Any?): Map<String, Any?>? = o as? Map<String, Any?>

    private fun asList(o: Any?): List<Any?>? = o as? List<Any?>

    private fun readString(o: Any?): String? = o as? String

    private fun readStringList(o: Any?): List<String> {
        val list = asList(o) ?: return emptyList()
        val out = ArrayList<String>(list.size)
        for (e in list) if (e is String) out.add(e)
        return out
    }

    /** Reads a JSON-decoded number as an Int (Int/Long/Double/Number). */
    private fun readInt(raw: Any?): Int? =
        when (raw) {
            is Boolean -> null
            is Int -> raw
            is Long -> raw.toInt()
            is Number -> raw.toInt()
            else -> null
        }

    /** Reads a JSON-decoded number as a Double (any Number variant). */
    private fun readDouble(raw: Any?): Double? =
        when (raw) {
            is Boolean -> null
            is Number -> raw.toDouble()
            else -> null
        }
}
