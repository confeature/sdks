// SPDX-License-Identifier: MIT
package io.confeature.kmp.internal

import io.confeature.kmp.User
import io.confeature.kmp.internal.ConfigValues.asList
import io.confeature.kmp.internal.ConfigValues.asMap
import io.confeature.kmp.internal.ConfigValues.coerceTyped
import io.confeature.kmp.internal.ConfigValues.defaultMatchesType
import io.confeature.kmp.internal.ConfigValues.readInt
import io.confeature.kmp.internal.ConfigValues.readString
import io.confeature.kmp.internal.ConfigValues.selectSettingValue

/**
 * ConfigCat-parity flag evaluator. Pure function over a parsed `config_v6` map + [User] → returns
 * the resolved value (boolean / string / int / double) or the caller's typed fallback, plus the
 * matched-rule / matched-option / variation-id detail.
 *
 * Ported from `packages/sdk-shared/src/{evaluator,comparators,hash,semver,segments,
 * prerequisites}.ts` (the spec-117 reference, proven byte-for-byte against ConfigCat) and
 * transliterated from the Android port (spec 128, `io.confeature.android.internal.Evaluator`) into
 * `commonMain` (platform-agnostic Kotlin; the only platform difference is the [Hashing]-backing
 * `Sha1Provider` / `Sha256Provider` `expect/actual` pair). The setting's `t` discriminator selects
 * the value slot: `0→v.b`, `1→v.s`, `2→v.i`, `3→v.d`.
 *
 * Fail-closed semantics (SC-006): any reason a value can't be resolved cleanly returns the caller's
 * default plus a discrete [Error] code; **no exception ever escapes to the caller**. A circular
 * prerequisite chain throws [CircularDependencyException] internally, caught by the outer
 * fail-closed frame → bounded fallback + error (no `StackOverflowError`).
 *
 * [evaluateTraced] additionally drives the ConfigCat-byte-identical evaluation-log trace (ADR 0003
 * / epic #494, #501): the WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk plus the
 * final INFO 5000 multi-line indented trace. The trace builders live in [EvalLog] / [EvalTraceLog];
 * a `null` sink (the hot path) is zero-cost.
 */
public object Evaluator {
    /** Setting-type discriminator for boolean values (matches `SettingType.Bool=0`). */
    public const val SETTING_TYPE_BOOL: Int = 0

    /** Setting-type discriminator for string values (matches `SettingType.String=1`). */
    public const val SETTING_TYPE_STRING: Int = 1

    /** Setting-type discriminator for int values (matches `SettingType.Int=2`). */
    public const val SETTING_TYPE_INT: Int = 2

    /** Setting-type discriminator for double values (matches `SettingType.Double=3`). */
    public const val SETTING_TYPE_DOUBLE: Int = 3

    // PrerequisiteFlagComparator / SegmentComparator negated codes (the eval-log trace reads them).
    internal const val PREREQ_NOT_EQUALS = 1
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

    /** Evaluation outcome envelope (additive: variationId + matched rule/option). */
    public data class Result(
        val value: Any?,
        val error: Error,
        val variationId: String? = null,
        val matchedTargetingRule: Boolean = false,
        val matchedPercentageOption: Boolean = false,
        val evalError: String? = null,
    )

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

    /** Adapter from the public [User] (custom values are typed: String / Number / Boolean / List). */
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
     * is `Map<String,Any>` (mirroring upstream `ConfigCatUser`), so a number / boolean / string array
     * reaches the comparator un-stringified; cleartext / sensitive-text comparators stringify it via
     * ConfigCat's invariant rules ([AttributeStrings.userAttributeValueToString]).
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
        val located = locateSetting(config, key, defaultValue)
        if (located.error != Error.NONE) return Result(defaultValue, located.error)

        val preferences = asMap(config?.get("p"))
        val configSalt = (preferences?.get("s") as? String) ?: ""
        val segments = asList(config?.get("s")) ?: emptyList()

        val logBuilder = startTrace(log, key, user)
        val scope = EvalScope(located.settings, segments, configSalt, user, log, logBuilder)
        val ctx = EvalContext(key, located.setting, scope)

        val sr = resolveFailClosed(ctx) ?: return Result(defaultValue, Error.MALFORMED_CONFIG)
        val raw = selectSettingValue(sr.value, located.type)
        val typed = coerceTyped(raw, located.type) ?: return Result(defaultValue, Error.MALFORMED_VALUE)

        // Footer + emit. The INFO 5000 trace is emitted only when the resolved value is clean.
        if (logBuilder != null) {
            logBuilder.newLine("Returning '" + EvalLog.settingValueToLogString(typed) + "'.")
            log.info(EvalLog.EVENT_ID, logBuilder.toString())
        }

        val variationId = sr.variationId ?: readString(located.setting["i"])
        return Result(
            typed,
            Error.NONE,
            variationId,
            sr.matchedRule,
            sr.matchedOption,
            ctx.evalError,
        )
    }

    /** The setting [key] names, its type, and the error ([Error.NONE] when it can be evaluated). */
    private class LocatedSetting(
        val settings: Map<String, Any?>,
        val setting: Map<String, Any?>,
        val type: Int,
        val error: Error,
    )

    /**
     * Find [key]'s setting and check its type against the caller's default. The checks run in the
     * fail-closed order: no config, missing key, malformed setting, unsupported type, then the
     * tier-0 TYPE_MISMATCH guard (a null default bypasses it).
     */
    private fun locateSetting(config: Map<String, Any?>?, key: String, defaultValue: Any?): LocatedSetting {
        val settings = asMap(config?.get("f"))
        val settingAny = settings?.get(key)
        val setting = asMap(settingAny)
        val type = readInt(setting?.get("t"))
        val error =
            when {
                config == null || settings == null -> Error.NO_CONFIG
                settingAny == null -> Error.KEY_NOT_FOUND
                setting == null || type == null -> Error.MALFORMED_CONFIG
                else -> typeError(type, defaultValue)
            }
        return LocatedSetting(
            settings ?: emptyMap(),
            setting ?: emptyMap(),
            type ?: SETTING_TYPE_BOOL,
            error,
        )
    }

    private fun typeError(settingType: Int, defaultValue: Any?): Error =
        when {
            settingType !in SETTING_TYPE_BOOL..SETTING_TYPE_DOUBLE -> Error.UNSUPPORTED_TYPE
            defaultValue != null && !defaultMatchesType(defaultValue, settingType) -> Error.TYPE_MISMATCH
            else -> Error.NONE
        }

    /**
     * Evaluation-log trace (ADR 0003). Built lazily — only when the sink would emit at INFO. The
     * header is appended here; the `Returning '<value>'.` footer by [evaluateTraced]; the whole
     * multi-line trace is surfaced under event id 5000.
     */
    private fun startTrace(log: EvalTraceLog, key: String, user: UserView?): EvalLog.EvaluateLogBuilder? {
        if (!log.enabled(EvalTraceLog.Level.INFO)) return null
        val logBuilder = EvalLog.EvaluateLogBuilder()
        logBuilder.append("Evaluating '$key'")
        if (user != null) {
            logBuilder.append(" for User '" + AttributeStrings.userAttributesForLogJson(user) + "'")
        }
        return logBuilder
    }

    /** Walk the setting; any failure is fail-closed to null (MALFORMED_CONFIG for the caller). */
    private fun resolveFailClosed(ctx: EvalContext): SettingResult? =
        try {
            SettingEvaluator.evaluateSetting(ctx)
        } catch (e: CircularDependencyException) {
            // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002 (naming the
            // setting + the chain), not the generic evaluation path.
            ctx.log.circularDependency(ctx.key, e.cycle)
            null
        } catch (_: MalformedConfigException) {
            null
        } catch (_: RuntimeException) {
            null
        }
}
